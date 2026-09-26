/**
 * V2 Serializer（RFC-LOC-1 PR3a 规格 §2.2）：Canonical → 五个 V2 文件的 JSON 值。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。与 V2 Reader（`./v2Reader.ts`）互逆：
 * 对迁移产出的 Canonical（地点 id 为 UUIDv7、运行时字段为 V2 模式的值），`readV2(serializeV2(c, meta))`
 * 与 `c` 在 JSON 意义下深度相等。
 *
 * 几乎是恒等变换（决定 D：V2 文件就是 Canonical 去掉运行时字段），只有三处不同：
 * - 足迹的元数据写成旧文件的蛇形字段名（`schema_version`、`generated_at` …）；
 * - 记录坐标：与所属城市地点的 `location` 完全相同 → 省略 `lat` / `lng`；原为 `null` → 写 `null`；
 *   其他 → 原样写（RFC Q8：记录自身的位置与地点的规范坐标不同时才值得存）；
 * - Canonical 里没有的文件级元数据（想去文件的 `generated_at` / `privacy_level` / `intended_use`，
 *   媒体文件的其他顶层字段，地点注册表的 `generated_at`）由调用方经 `V2FileMeta` 给出，原样写入。
 *
 * 输出只含 JSON 值（经 JSON 往返的深拷贝），不与输入共享引用。本模块不校验：写盘前由调用方用
 * `validateV2Files`（`./v2Schema.ts`）校验。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { CanonicalData, CanonicalPlace, CanonicalTravelRecord } from './types.ts'
import {
  EDITOR_STATE_SCHEMA_VERSION,
  MEDIA_SCHEMA_VERSION,
  PLACES_SCHEMA_VERSION,
  TRAVEL_SCHEMA_VERSION,
  WANT_TO_GO_SCHEMA_VERSION,
  type V2Files,
  type V2MediaFile,
  type V2TravelFile,
  type V2TravelRecord,
  type V2WantToGoFile,
} from './v2Schema.ts'

/** Canonical 里没有、只存在于文件上的元数据。 */
export interface V2FileMeta {
  /** 地点注册表的 `generated_at`（迁移时是规划时间）。 */
  placesGeneratedAt: string
  /** 旧想去文件的顶层元数据；只取 `generated_at` / `privacy_level` / `intended_use`，有才写。 */
  wantToGo?: Record<string, unknown>
  /** 旧媒体文件除 `schemaVersion` 与 `items` 外的顶层字段，原样写入。 */
  media?: Record<string, unknown>
}

/** 想去文件搬过来的三个顶层字段（PR3a 规格 §2.2）。 */
export const WANT_TO_GO_META_KEYS = ['generated_at', 'privacy_level', 'intended_use'] as const

/** JSON 往返的深拷贝：去掉值为 undefined 的键，结果只含 JSON 值。 */
export const jsonClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 记录坐标与城市地点的规范坐标完全相同（两者都是数字且逐个相等）。 */
export const recordMatchesCityLocation = (record: CanonicalTravelRecord, city: CanonicalPlace | undefined): boolean => {
  const location = city?.location
  return location !== undefined
    && typeof record.lat === 'number'
    && typeof record.lng === 'number'
    && record.lat === location.lat
    && record.lng === location.lng
}

const serializeRecord = (record: CanonicalTravelRecord, places: ReadonlyMap<string, CanonicalPlace>): V2TravelRecord => {
  if (!recordMatchesCityLocation(record, places.get(record.placeId))) return record
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'lat' && key !== 'lng')) as V2TravelRecord
}

/** Canonical → 五个 V2 文件。运行时字段（`source`、`problems`）不写。 */
export function serializeV2(canonical: CanonicalData, meta: V2FileMeta): V2Files {
  const data = jsonClone(canonical)
  const places = new Map(data.places.map((place) => [place.id, place]))
  const travelMeta = data.travel.meta

  const travel: V2TravelFile = {
    schema_version: TRAVEL_SCHEMA_VERSION,
    ...(travelMeta.generatedAt !== undefined ? { generated_at: travelMeta.generatedAt } : {}),
    ...(travelMeta.privacyLevel !== undefined ? { privacy_level: travelMeta.privacyLevel } : {}),
    ...(travelMeta.intendedUse !== undefined ? { intended_use: travelMeta.intendedUse } : {}),
    ...(travelMeta.safetyNotes !== undefined ? { safety_notes: travelMeta.safetyNotes } : {}),
    display: data.travel.display,
    records: data.travel.records.map((record) => serializeRecord(record, places)),
  }

  const wantToGoMeta: Record<string, unknown> = {}
  for (const key of WANT_TO_GO_META_KEYS) {
    if (meta.wantToGo?.[key] !== undefined) wantToGoMeta[key] = meta.wantToGo[key]
  }
  const wantToGo = {
    schema_version: WANT_TO_GO_SCHEMA_VERSION,
    ...jsonClone(wantToGoMeta),
    items: data.wantToGo.items,
  } as V2WantToGoFile

  const mediaMeta = Object.fromEntries(
    Object.entries(meta.media ?? {}).filter(([key]) => key !== 'schemaVersion' && key !== 'items'),
  )
  const media: V2MediaFile = {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    ...jsonClone(mediaMeta),
    items: data.media.items,
  }

  return {
    places: { schema_version: PLACES_SCHEMA_VERSION, generated_at: meta.placesGeneratedAt, places: data.places },
    travel,
    wantToGo,
    editorState: { ...data.editorState, schemaVersion: EDITOR_STATE_SCHEMA_VERSION },
    media,
  }
}
