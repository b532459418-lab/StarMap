/**
 * Shadow compare（RFC-LOC-1 §4「切换前 shadow compare，分两层」，PR3a 规格 §2.1、§2.4 第 9 步）。
 *
 * `src/data/migration/` 是 App 层的迁移工具，【不是】 StarMap Core。三份基线：
 *
 *   A  = 派生(L)            今天 App 看到的（L = Legacy Adapter 的输出）
 *   A′ = 派生(L′)           在旧 id 空间里先应用全部合并与决定之后，App 会看到的
 *   B  = 派生(read(files))  迁移 → 写成 V2 文件 → V2 Reader 读回之后 App 会看到的，UUID 映射回旧 id
 *
 * - **Canonical 层**：`read(files)` 经迁移清单把地点 id 映射回旧 id、`legacyKeys` 去掉命名空间前缀后，
 *   与 L′ 逐项相同（地点、足迹元数据、显示规则、记录、想去条目、editor-state、媒体项）。
 * - **派生层**：A′ 与 B 的 `buildBaseline` + `stableStringify` 逐字节相同。B 里出现的每个 UUID
 *   （包括嵌在 `place:city:<uuid>`、`country-order__<uuid>__…` 这类派生 id 里的）替换回旧 id，
 *   再按键排序输出——对象键里的 UUID 换回旧 id 后顺序会变，所以替换在序列化之前做。
 * - A 与 A′ 的差异只报告：那就是合并与决定带来的显示变化。
 *
 * 运行时字段（`travel.source`、`wantToGo.source`、`wantToGo.problems`、`media.problems`）不属于 V2 文件：
 * V2 Reader 固定给出 `'local'` 与空数组，它们描述的是「选了哪份文件、解析时丢了什么」，不是数据。
 * 所以 Canonical 层不比较它们，派生层算 B 时沿用 L′ 的运行时字段；想去与媒体的 problems 在迁移前
 * 已由门槛保证为空（E_WTG_PROBLEMS、E_MEDIA_INVALID）。
 *
 * 两边跑的派生代码完全相同（`deriveAppDataFromCanonical` + `buildBaseline`），任何差异只可能来自
 * id 重映射、序列化或 V2 Reader。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import { mapPlaceIds } from '../canonical/placeIds.ts'
import type { CanonicalData, PlaceId } from '../canonical/types.ts'
import { diffJson, type DiffSummary } from './jsonDiff.ts'

/** 基线的 `now`（与 `legacy-baseline.mjs` 相同）：三份基线必须用同一个值。 */
export const SHADOW_NOW = '2000-01-01T00:00:00.000Z'

/** Canonical → App 派生结果的规范化基线（可交给 `stableStringify`）。 */
export const baselineOf = (canonical: CanonicalData): unknown =>
  buildBaseline(deriveAppDataFromCanonical(canonical, { now: SHADOW_NOW }), { now: SHADOW_NOW })

/** 文本里出现的 UUIDv7（小写）。只有迁移清单里有的才会被替换。 */
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g

const replaceUuids = (text: string, oldIdOf: ReadonlyMap<string, PlaceId>) =>
  text.replace(UUID_IN_TEXT, (uuid) => oldIdOf.get(uuid) ?? uuid)

/** 把一份 JSON 值里（值与对象键中）出现的每个已知 UUID 换回旧 id。 */
export const mapUuidsBack = (value: unknown, oldIdOf: ReadonlyMap<string, PlaceId>): unknown => {
  if (typeof value === 'string') return replaceUuids(value, oldIdOf)
  if (Array.isArray(value)) return value.map((item) => mapUuidsBack(item, oldIdOf))
  if (value === null || typeof value !== 'object') return value
  const mapped: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) mapped[replaceUuids(key, oldIdOf)] = mapUuidsBack(item, oldIdOf)
  return mapped
}

/** 去掉 legacyKeys 的命名空间前缀（`country:` / `city:`）：L′ 里的 legacyKeys 是 legacy 模式的写法。 */
const stripNamespace = (key: string) => key.replace(/^(country|city):/, '')

/** 读回的 Canonical（UUID）→ 旧 id 空间：地点 id 经迁移清单映射回去，legacyKeys 去掉前缀。 */
export const mapCanonicalBack = (actual: CanonicalData, oldIdOf: ReadonlyMap<string, PlaceId>): CanonicalData => {
  const mapped = mapPlaceIds(actual, (id) => oldIdOf.get(id) ?? id)
  return {
    ...mapped,
    places: mapped.places.map((place) => (
      place.legacyKeys === undefined ? place : { ...place, legacyKeys: place.legacyKeys.map(stripNamespace) }
    )),
  }
}

/** Canonical 层比较的范围：数据本身，不含运行时字段。 */
const persistentPart = (data: CanonicalData) => ({
  places: data.places,
  travelMeta: data.travel.meta,
  display: data.travel.display,
  records: data.travel.records,
  wantToGoItems: data.wantToGo.items,
  editorState: data.editorState,
  mediaItems: data.media.items,
})

/** `target` 换上 `source` 的运行时字段。 */
export const withRuntimeFieldsOf = (target: CanonicalData, source: CanonicalData): CanonicalData => ({
  ...target,
  travel: { ...target.travel, source: source.travel.source },
  wantToGo: { ...target.wantToGo, source: source.wantToGo.source, problems: source.wantToGo.problems },
  media: { ...target.media, problems: source.media.problems },
})

/** 两份基线：逐字节相同时 equal；不同时给出差异路径（不带值）。 */
export const compareBaselines = (left: unknown, right: unknown): DiffSummary => {
  if (stableStringify(left) === stableStringify(right)) return { equal: true, total: 0, paths: [] }
  const diff = diffJson(left, right)
  // stableStringify 与 JSON 往返只在极端值上不同（例如 -0）；那也算不同。
  return diff.equal ? { equal: false, total: 1, paths: ['$'] } : diff
}

export interface ShadowCompareInput {
  /** L′：旧 id 空间里完成合并之后的 Canonical。 */
  expected: CanonicalData
  /** read(files)：V2 Reader 读回的 Canonical（地点 id 是 UUID）。 */
  actual: CanonicalData
  /** UUID → 旧 id（迁移清单的反查）。 */
  oldIdOf: ReadonlyMap<string, PlaceId>
  /** 已经算好的 A′（省一次派生）；不给就现算。 */
  expectedBaseline?: unknown
}

export interface ShadowCompareResult {
  canonical: DiffSummary
  derived: DiffSummary
}

/** 两层 shadow compare：Canonical 层逐项相同、派生层逐字节相同（A′ ≡ B）。 */
export function shadowCompare(input: ShadowCompareInput): ShadowCompareResult {
  const { expected, actual, oldIdOf } = input
  const canonical = diffJson(persistentPart(expected), persistentPart(mapCanonicalBack(actual, oldIdOf)))
  const aPrime = input.expectedBaseline ?? baselineOf(expected)
  const b = mapUuidsBack(baselineOf(withRuntimeFieldsOf(actual, expected)), oldIdOf)
  return { canonical, derived: compareBaselines(aPrime, b) }
}
