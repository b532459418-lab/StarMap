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
import {
  EDITOR_STATE_SCHEMA_VERSION,
  MEDIA_SCHEMA_VERSION,
  PLACES_SCHEMA_VERSION,
  TRAVEL_SCHEMA_VERSION,
  V2_FILE_KEYS,
  WANT_TO_GO_SCHEMA_VERSION,
  validateV2Files,
  type V2FileKey,
  type V2Files,
} from '../canonical/v2Schema.ts'
import { jsonClone } from '../canonical/v2Serializer.ts'
import { V2WriteError } from './errors.ts'

/** `data/v2/` 下五个文件的原始 JSON 值；缺的文件为 undefined（或不出现）。 */
export type V2FilesOrEmpty = Partial<Record<V2FileKey, unknown>>

/** 国家目录的一项（插件的 world-countries 目录，键为大写 ISO）。 */
export interface CatalogCountry {
  nameZh: string
  nameEn: string
  countryCode: string
  centerLat: number
  centerLng: number
  region?: string
}

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

/**
 * 全新 V2 目录里「写时创建」的五个空文件（PR3b-2 规格 §2.1）。足迹：`schema_version: 2`、
 * `privacy_level: 'private-local'`（同旧编辑器新建私人足迹文件时的写法）、显示规则全空；想去：
 * `privacy_level: 'local-only'`（同旧想去 store 新建文件时的写法）；其余按 PR3a 的格式与版本号。
 * 时间字段在写盘时统一盖成这次写入的时间（`runV2Transaction`）。
 */
export const emptyV2FilesForWrite = (now: Date): V2Files => {
  const iso = now.toISOString()
  return {
    places: { schema_version: PLACES_SCHEMA_VERSION, generated_at: iso, places: [] },
    travel: {
      schema_version: TRAVEL_SCHEMA_VERSION,
      generated_at: iso,
      privacy_level: 'private-local',
      display: { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] },
      records: [],
    },
    wantToGo: { schema_version: WANT_TO_GO_SCHEMA_VERSION, generated_at: iso, privacy_level: 'local-only', items: [] },
    editorState: {
      schemaVersion: EDITOR_STATE_SCHEMA_VERSION,
      addedCountries: [],
      countryOrder: [],
      hiddenCountryIds: [],
      cityOrderByCountry: {},
      hiddenCityIds: [],
      mediaOrderByCity: {},
      hiddenMediaIds: [],
      coverMediaByCity: {},
      droneOrderByCity: {},
      hiddenDroneMediaIds: [],
      updatedAt: iso,
    },
    media: { schemaVersion: MEDIA_SCHEMA_VERSION, items: [] },
  }
}

/** 缺的文件换成空模板；在的文件深拷贝（包括不合法的，留给完整性检查报错）。 */
export const completeForWrite = (files: V2FilesOrEmpty | undefined, now: Date): Record<V2FileKey, unknown> => {
  const empty = emptyV2FilesForWrite(now)
  return Object.fromEntries(
    V2_FILE_KEYS.map((key) => [key, files?.[key] === undefined ? empty[key] : jsonClone(files[key])]),
  ) as Record<V2FileKey, unknown>
}

// ---------------------------------------------------------------------------
// 地点引用与完整性
// ---------------------------------------------------------------------------

/** 一处地点引用：在哪个文件、哪个位置（字段或 `字段.键`），引用的 id。 */
export interface PlaceRef {
  file: V2FileKey
  where: string
  id: PlaceId
}

/**
 * 五个文件里【全部】地点引用（与 ../canonical/placeIds.ts 列的位置相同，另加 `partOf`）。
 * 输入须已通过 `validateV2Files` 的结构检查。
 */
export const placeRefs = (files: V2Files): PlaceRef[] => {
  const refs: PlaceRef[] = []
  const add = (file: V2FileKey, where: string, id: PlaceId) => refs.push({ file, where, id })
  for (const place of files.places.places) if (place.partOf !== undefined) add('places', `partOf(${place.id})`, place.partOf)
  const { display } = files.travel
  for (const id of display.homeHiddenCountryIds) add('travel', 'display.homeHiddenCountryIds', id)
  for (const id of display.originCountryIds) add('travel', 'display.originCountryIds', id)
  for (const id of display.regionCountryIds) add('travel', 'display.regionCountryIds', id)
  for (const id of display.navigationHiddenCityIds) add('travel', 'display.navigationHiddenCityIds', id)
  for (const record of files.travel.records) add('travel', `records(${record.id})`, record.placeId)
  for (const item of files.wantToGo.items) add('wantToGo', `items(${item.id})`, item.placeId)
  const state = files.editorState
  for (const entry of state.addedCountries) add('editorState', 'addedCountries', entry.placeId)
  for (const id of state.countryOrder) add('editorState', 'countryOrder', id)
  for (const id of state.hiddenCountryIds) add('editorState', 'hiddenCountryIds', id)
  for (const [countryId, cityIds] of Object.entries(state.cityOrderByCountry)) {
    add('editorState', 'cityOrderByCountry(键)', countryId)
    for (const id of cityIds) add('editorState', `cityOrderByCountry.${countryId}`, id)
  }
  for (const id of state.hiddenCityIds) add('editorState', 'hiddenCityIds', id)
  for (const id of Object.keys(state.mediaOrderByCity)) add('editorState', 'mediaOrderByCity(键)', id)
  for (const id of Object.keys(state.coverMediaByCity)) add('editorState', 'coverMediaByCity(键)', id)
  for (const id of Object.keys(state.droneOrderByCity)) add('editorState', 'droneOrderByCity(键)', id)
  for (const item of files.media.items) add('media', `items(${item.id})`, item.placeId)
  return refs
}

/** 悬空引用：引用的地点不在注册表里。 */
export const danglingPlaceRefs = (files: V2Files): PlaceRef[] => {
  const ids = new Set(files.places.places.map((place) => place.id))
  return placeRefs(files).filter((ref) => !ids.has(ref.id))
}

/**
 * 完整性检查：`validateV2Files` 的全部问题，加上悬空引用（结构合法时才查）。返回问题的简述
 * （文件、路径、问题；不含字段的值），空数组表示通过。
 */
export const integrityProblems = (files: Record<V2FileKey, unknown>): string[] => {
  const problems = validateV2Files(files).map((problem) => `${problem.file} ${problem.path}：${problem.message}`)
  if (problems.length > 0) return problems
  return danglingPlaceRefs(files as unknown as V2Files).map((ref) => `${ref.file} ${ref.where}：引用的地点不存在（${ref.id}）`)
}

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
export const removeUnreferencedPlaces = (files: V2Files, candidates: Iterable<PlaceId>): PlaceId[] => {
  const pending = new Set(candidates)
  const removed: PlaceId[] = []
  for (;;) {
    const referenced = new Set(placeRefs(files).map((ref) => ref.id))
    const removable = files.places.places.filter((place) => pending.has(place.id) && !referenced.has(place.id))
    if (removable.length === 0) break
    const ids = new Set(removable.map((place) => place.id))
    files.places.places = files.places.places.filter((place) => !ids.has(place.id))
    for (const id of ids) pending.delete(id)
    removed.push(...removable.map((place) => place.id))
  }
  return removed
}
