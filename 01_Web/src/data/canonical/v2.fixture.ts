/**
 * V2 格式测试（RFC-LOC-1 PR3a）共用的小工具。不是测试文件，App 代码从不 import 它。
 *
 * - `sequentialUuids()`：确定的 UUIDv7 序列（时间戳与随机字节都由计数器给出），测试结果可逐字节复现；
 * - `toV2Space()`：把 Legacy Adapter 产出的 Canonical 直接搬进 V2 的 id 空间（旧 id → UUID、
 *   `legacyKeys` 加命名空间前缀、运行时字段取 V2 模式的值），【不做】任何地点合并。
 *   只用来单独测试 Serializer / Reader / 校验；真正的迁移（含合并与决定）见 `../migration/planMigration.ts`。
 */

import { mapPlaceIds } from './placeIds.ts'
import type { CanonicalData, PlaceId } from './types.ts'
import { uuidv7 } from './uuidv7.ts'
import { jsonClone } from './v2Serializer.ts'

/** 2026-01-01T00:00:00.000Z */
export const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1)

/** 确定的 UUIDv7 序列：第 n 个 id 的时间戳为 `startMs + n`，随机字节为 n 的大端表示。 */
export const sequentialUuids = (startMs: number = FIXTURE_EPOCH_MS): (() => string) => {
  let counter = 0
  return () => {
    counter += 1
    const n = counter
    return uuidv7({
      now: () => startMs + n,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length)
        let rest = n
        for (let index = length - 1; index >= 0 && rest > 0; index -= 1) {
          bytes[index] = rest % 256
          rest = Math.floor(rest / 256)
        }
        return bytes
      },
    })
  }
}

export interface V2SpaceResult {
  data: CanonicalData
  /** 旧 id → UUID。 */
  uuidOf: Map<PlaceId, string>
}

/** 旧 id 空间的 Canonical → V2 id 空间（不合并地点，见文件头）。 */
export const toV2Space = (canonical: CanonicalData, newId: () => string = sequentialUuids()): V2SpaceResult => {
  const uuidOf = new Map<PlaceId, string>(canonical.places.map((place) => [place.id, newId()]))
  const mapped = mapPlaceIds(canonical, (id) => uuidOf.get(id) ?? id)
  const data: CanonicalData = {
    places: mapped.places.map((place) => ({
      ...place,
      ...(place.legacyKeys !== undefined ? { legacyKeys: place.legacyKeys.map((key) => `${place.subtype}:${key}`) } : {}),
    })),
    travel: { ...mapped.travel, source: 'local', meta: { ...mapped.travel.meta, schemaVersion: 2 } },
    wantToGo: { ...mapped.wantToGo, source: 'local', problems: [] },
    editorState: {
      ...mapped.editorState,
      addedCountries: mapped.editorState.addedCountries.map(({ placeId, region, visitedDate }) => ({
        placeId,
        ...(region !== undefined ? { region } : {}),
        ...(visitedDate !== undefined ? { visitedDate } : {}),
      })),
    },
    media: { ...mapped.media, problems: [] },
  }
  return { data: jsonClone(data), uuidOf }
}
