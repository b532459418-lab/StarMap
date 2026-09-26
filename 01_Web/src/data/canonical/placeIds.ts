/**
 * 把 Canonical 里【所有】地点 id 引用换成另一套 id（RFC-LOC-1 PR3a）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。地点 id 出现在这些位置，本模块逐一处理，
 * 其他地方都不是地点 id：
 * - `places[].id`、`places[].partOf`；
 * - 足迹记录的 `placeId`；显示规则的四个 id 列表（`regionIncludes` 是 region 字符串，不是地点）；
 * - 想去条目的 `placeId`；
 * - editor-state：`addedCountries[].placeId`，`countryOrder` / `hiddenCountryIds` / `hiddenCityIds` 的值，
 *   `cityOrderByCountry` 的键与值，`mediaOrderByCity` / `coverMediaByCity` / `droneOrderByCity` 的键
 *   （这三者的值是媒体 id）；
 * - 媒体项的 `placeId`。
 *
 * `legacyKeys` 不在这里改：它们是旧键的记录，不是地点 id 引用。
 *
 * 用在三处：迁移把旧 id 换成 UUID、迁移在旧 id 空间里把被合并的地点改指存活地点、
 * shadow compare 把 UUID 映射回旧 id。只按 id 查表，不解析 id 的结构（RFC ID-1）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { CanonicalData, CanonicalDisplay, CanonicalEditorState, PlaceId } from './types.ts'

export type PlaceIdMapper = (id: PlaceId) => PlaceId

/**
 * 键换成新 id。两个旧键映射到同一个新键时保留先出现的那个（只会在合并时发生；
 * UUID 分配是一一映射，不会碰撞）。
 */
const mapKeys = <T,>(record: Record<PlaceId, T>, mapId: PlaceIdMapper): Record<PlaceId, T> => {
  const next: Record<PlaceId, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const mapped = mapId(key)
    if (!Object.hasOwn(next, mapped)) next[mapped] = value
  }
  return next
}

const mapDisplay = (display: CanonicalDisplay, mapId: PlaceIdMapper): CanonicalDisplay => ({
  ...display,
  homeHiddenCountryIds: display.homeHiddenCountryIds.map(mapId),
  originCountryIds: display.originCountryIds.map(mapId),
  regionCountryIds: display.regionCountryIds.map(mapId),
  navigationHiddenCityIds: display.navigationHiddenCityIds.map(mapId),
})

const mapEditorState = (state: CanonicalEditorState, mapId: PlaceIdMapper): CanonicalEditorState => ({
  ...state,
  addedCountries: state.addedCountries.map((entry) => ({ ...entry, placeId: mapId(entry.placeId) })),
  countryOrder: state.countryOrder.map(mapId),
  hiddenCountryIds: state.hiddenCountryIds.map(mapId),
  cityOrderByCountry: Object.fromEntries(
    Object.entries(mapKeys(state.cityOrderByCountry, mapId)).map(([countryId, cityIds]) => [countryId, cityIds.map(mapId)]),
  ),
  hiddenCityIds: state.hiddenCityIds.map(mapId),
  mediaOrderByCity: mapKeys(state.mediaOrderByCity, mapId),
  coverMediaByCity: mapKeys(state.coverMediaByCity, mapId),
  droneOrderByCity: mapKeys(state.droneOrderByCity, mapId),
})

/** 返回新的 Canonical：每个地点 id 引用都换成 `mapId(id)`；其余字段原样（浅拷贝到被改动的那一层）。 */
export function mapPlaceIds(data: CanonicalData, mapId: PlaceIdMapper): CanonicalData {
  return {
    places: data.places.map((place) => ({
      ...place,
      id: mapId(place.id),
      ...(place.partOf !== undefined ? { partOf: mapId(place.partOf) } : {}),
    })),
    travel: {
      ...data.travel,
      display: mapDisplay(data.travel.display, mapId),
      records: data.travel.records.map((record) => ({ ...record, placeId: mapId(record.placeId) })),
    },
    wantToGo: {
      ...data.wantToGo,
      items: data.wantToGo.items.map((item) => ({ ...item, placeId: mapId(item.placeId) })),
    },
    editorState: mapEditorState(data.editorState, mapId),
    media: {
      ...data.media,
      items: data.media.items.map((item) => ({ ...item, placeId: mapId(item.placeId) })),
    },
  }
}

/** editor-state 里引用地点 id 的位置（供「悬空引用」检查与报告用）：`字段` 或 `字段.键`。 */
export const editorStatePlaceRefs = (state: CanonicalEditorState): { where: string; id: PlaceId }[] => [
  ...state.addedCountries.map((entry) => ({ where: 'addedCountries', id: entry.placeId })),
  ...state.countryOrder.map((id) => ({ where: 'countryOrder', id })),
  ...state.hiddenCountryIds.map((id) => ({ where: 'hiddenCountryIds', id })),
  ...Object.entries(state.cityOrderByCountry).flatMap(([countryId, cityIds]) => [
    { where: 'cityOrderByCountry(键)', id: countryId },
    ...cityIds.map((id) => ({ where: 'cityOrderByCountry(值)', id })),
  ]),
  ...state.hiddenCityIds.map((id) => ({ where: 'hiddenCityIds', id })),
  ...Object.keys(state.mediaOrderByCity).map((id) => ({ where: 'mediaOrderByCity', id })),
  ...Object.keys(state.coverMediaByCity).map((id) => ({ where: 'coverMediaByCity', id })),
  ...Object.keys(state.droneOrderByCity).map((id) => ({ where: 'droneOrderByCity', id })),
]
