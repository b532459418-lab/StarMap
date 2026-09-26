/**
 * V2 Reader（RFC-LOC-1 PR3a 规格 §2.2）：五个 V2 文件 → Canonical。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。与 V2 Serializer（`./v2Serializer.ts`）互逆。
 * PR3b 起 App 在 v2 模式下经它读数据（RFC §3.6：「v2 模式：新文件 ──V2 Reader──> Canonical」），
 * 之后的派生与 legacy 模式完全相同（`./derive.ts`）。
 *
 * - 省略坐标的足迹记录（`lat` / `lng` 两个键都不存在）用所属城市地点的 `location` 填回；城市没有
 *   `location` 时保持省略。只省略了一个键的记录原样读（Serializer 不会这样写）。
 * - 运行时字段：`source` 固定为 `'local'`（V2 文件只存在于私人数据目录），`problems` 为空
 *   （V2 文件先整体校验，不逐条丢弃）。
 * - Canonical 里没有的文件级元数据（想去文件的 `generated_at` 等、媒体文件的其他顶层字段、
 *   地点注册表的 `generated_at`）读时丢弃；需要保留它们的写入方自己从文件里取。
 *
 * 输入须已通过 `validateV2Files`（`./v2Schema.ts`）。输出只含 JSON 值，不与输入共享引用。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { CanonicalData, CanonicalPlace, CanonicalTravelMeta, CanonicalTravelRecord } from './types.ts'
import type { V2Files, V2TravelRecord } from './v2Schema.ts'
import { jsonClone } from './v2Serializer.ts'

const readRecord = (record: V2TravelRecord, places: ReadonlyMap<string, CanonicalPlace>): CanonicalTravelRecord => {
  const omitted = !Object.hasOwn(record, 'lat') && !Object.hasOwn(record, 'lng')
  const location = places.get(record.placeId)?.location
  if (!omitted || location === undefined) return record as CanonicalTravelRecord
  return { ...record, lat: location.lat, lng: location.lng }
}

/** 五个 V2 文件 → Canonical（运行时字段取 V2 模式的值）。 */
export function readV2(files: V2Files): CanonicalData {
  const data = jsonClone(files)
  const places = new Map(data.places.places.map((place) => [place.id, place]))
  const travel = data.travel

  const meta = {
    schemaVersion: travel.schema_version,
    ...(travel.generated_at !== undefined ? { generatedAt: travel.generated_at } : {}),
    ...(travel.privacy_level !== undefined ? { privacyLevel: travel.privacy_level } : {}),
    ...(travel.intended_use !== undefined ? { intendedUse: travel.intended_use } : {}),
    ...(travel.safety_notes !== undefined ? { safetyNotes: travel.safety_notes } : {}),
  } as CanonicalTravelMeta

  return {
    places: data.places.places,
    travel: {
      source: 'local',
      meta,
      display: travel.display,
      records: travel.records.map((record) => readRecord(record, places)),
    },
    wantToGo: { source: 'local', items: data.wantToGo.items, problems: [] },
    editorState: data.editorState,
    media: { items: data.media.items, problems: [] },
  }
}
