/**
 * V2 写入的事务骨架（RFC-LOC-1 PR3b-2 规格 §2.1、§2.4）：空文件模板、地点引用、完整性检查与写入顺序。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。每个 V2 写入都是一个纯函数：
 *
 *   (files: V2FilesOrEmpty, input: unknown, ctx: V2WriteContext) => { writes, result }
 *
 * - `files`：`data/v2/` 下五个文件的原始 JSON 值，缺的为 undefined——按「空 V2 文件」处理，写时创建
 *   （全新 V2 目录）。这里【绝不】读旧文件或样例（决定 E）。
 * - `writes`：要写的文件，按【写盘顺序】排列：新增时 地点注册表 → 足迹 → 想去 → editor-state，
 *   删除时 editor-state → 足迹 → 想去 → 地点注册表。中途失败最多留下「没人引用的地点」，
 *   永远不会出现「引用了不存在的地点」。
 * - 出口的完整性检查：写完后的五个文件必须通过 PR3a 的 `validateV2Files`，且没有悬空的地点引用；
 *   否则抛 `E_INTEGRITY`，不返回任何写入。入口同样检查（现有文件本身不合法时不在它上面继续写）。
 * - 出错时抛 `V2WriteError`（./errors.ts）。
 *
 * 插件（scripts/local-editor-plugin.mjs，经 scripts/v2-editor-store.mjs）只做 IO：读文件 → 调纯函数 →
 * 按 `writes` 的顺序原子写盘 → 回写响应。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 * 不读时钟、不读随机源：`now` 与 `newId` 由 `ctx` 注入。
 */

import type { CanonicalPlace, PlaceId } from '../canonical/types.ts'
import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import { jsonClone } from '../canonical/v2Serializer.ts'
import { completeForWrite, integrityProblems, placeRefs, type V2FilesOrEmpty } from '../canonical/v2Integrity.ts'
import type { CatalogCountry } from '../editor/rules/places.ts'
import { V2WriteError } from '../editor/errors.ts'
import { pruneUnreferencedPlaces } from '../editor/rules/places.ts'

// 3C-5 E: moved out (../canonical/v2Integrity.ts, ../editor/rules/places.ts); re-exported for the V2 write functions.
export { completeForWrite, danglingPlaceRefs, emptyV2FilesForWrite, integrityProblems, placeRefs, type PlaceRef, type V2FilesOrEmpty } from '../canonical/v2Integrity.ts'
export type { CatalogCountry } from '../editor/rules/places.ts'

export interface V2WriteContext {
  /** 分配新 id（UUIDv7）：新地点、新足迹记录、新想去条目、新行程。 */
  newId(): string
  /** 这次写入的时间：文件的 generated_at / updatedAt、想去条目的默认加入日期（本地日期）。 */
  now: Date
  /** 按大写 ISO 查国家目录。 */
  countryCatalog: ReadonlyMap<string, CatalogCountry>
}

/** 一次写盘。`onFailure` 是这一步失败时给用户的说明（`{reason}` 换成失败原因）；没有时原样报失败原因。 */
export interface V2Write {
  file: V2FileKey
  value: unknown
  onFailure?: string
}

export interface V2WriteOutcome<R> {
  writes: V2Write[]
  result: R
}

// ---------------------------------------------------------------------------
// 空文件模板（全新 V2 目录）
// ---------------------------------------------------------------------------

const assertIntegrity = (files: Record<V2FileKey, unknown>, stage: 'input' | 'output') => {
  const problems = integrityProblems(files)
  if (problems.length > 0) throw new V2WriteError('E_INTEGRITY', { stage, problems: problems.slice(0, 20), total: problems.length })
}

// ---------------------------------------------------------------------------
// 事务
// ---------------------------------------------------------------------------

/** 事务主体可以就地修改的草稿：五个文件的深拷贝（缺的已补成空模板，已通过入口检查）。 */
export interface V2Draft {
  files: V2Files
  ctx: V2WriteContext
  placeById: (id: PlaceId) => CanonicalPlace | undefined
}

/** 事务主体的返回：结果，以及按写盘顺序列出的要写的文件（值取自草稿）。 */
export interface V2TransactionBody<R> {
  result: R
  writes: { file: V2FileKey; onFailure?: string }[]
}

/**
 * 运行一个 V2 写入事务：补齐 → 入口检查 → 主体修改草稿 → 给要写的文件盖时间 → 出口检查 → 按顺序给出写入。
 * 入口或出口检查不通过时抛 `E_INTEGRITY`，不给出任何写入。
 */
export function runV2Transaction<R>(
  files: V2FilesOrEmpty | undefined,
  ctx: V2WriteContext,
  body: (draft: V2Draft) => V2TransactionBody<R>,
): V2WriteOutcome<R> {
  const completed = completeForWrite(files, ctx.now)
  assertIntegrity(completed, 'input')
  const draftFiles = completed as unknown as V2Files
  const draft: V2Draft = {
    files: draftFiles,
    ctx,
    placeById: (id) => draftFiles.places.places.find((place) => place.id === id),
  }
  const { result, writes } = body(draft)

  const stamp = ctx.now.toISOString()
  const seen = new Set<V2FileKey>()
  for (const { file } of writes) {
    if (seen.has(file)) throw new TypeError(`V2 事务重复写同一个文件：${file}`)
    seen.add(file)
    if (file === 'places') draftFiles.places.generated_at = stamp
    else if (file === 'travel') draftFiles.travel.generated_at = stamp
    else if (file === 'wantToGo') draftFiles.wantToGo.generated_at = stamp
    else if (file === 'editorState') draftFiles.editorState.updatedAt = stamp
  }
  assertIntegrity(draftFiles as unknown as Record<V2FileKey, unknown>, 'output')

  return {
    writes: writes.map(({ file, onFailure }) => ({
      file,
      value: jsonClone(draftFiles[file]),
      ...(onFailure !== undefined ? { onFailure } : {}),
    })),
    result: jsonClone(result),
  }
}

/**
 * 从 `candidates` 里删掉不再被任何数据引用的地点（引用包括 `partOf`，所以删掉城市后，只被它引用的国家也会删）。
 * 只考虑候选地点，其他没人引用的地点不动。返回被删的 id（按删除的先后；同一轮内按注册表顺序）。
 */
export const removeUnreferencedPlaces = (files: V2Files, candidates: Iterable<PlaceId>): PlaceId[] => pruneUnreferencedPlaces(
  candidates,
  (pending) => {
    const referenced = new Set(placeRefs(files).map((ref) => ref.id))
    return files.places.places.filter((place) => pending.has(place.id) && !referenced.has(place.id)).map((place) => place.id)
  },
  (removable) => {
    const ids = new Set(removable)
    files.places.places = files.places.places.filter((place) => !ids.has(place.id))
  },
)
