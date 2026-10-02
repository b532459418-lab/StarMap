/**
 * 从 Canonical 重建今天的旧形状（RFC-LOC-1 PR2 规格 §2.4）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。UI 与 Core 今天读到的对象（记录上的
 * `country` / `country_en` / `country_code` / `city` / `city_en`、想去条目的内联 `place`、媒体项的
 * `countryId` / `cityId` / 名称 / 标题、editor-state 的 `addedCountries`、`travelAtlasCountryCodes`）
 * 在这里一律由地点重建，不再从各条记录自带的写法里取。
 *
 * 本模块给 `./derive.ts`（Canonical → 派生）与 V2 写入用。PR2 到 PR5a 它还被 normalizeLegacy 共用（把旧数据里
 * 每个地点的写法统一成这里的重建值，作为「B ≡ C」里的 B 基线）；PR5b 删除了 normalizeLegacy。
 *
 * 这里只按地点 id 取值，不按名字推导任何身份。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { WantToGoItem, WantToGoPlace } from '../derive/wantToGo.ts'
import type { LocalEditorCountry, TravelAtlasEditorState } from '../derive/editorState.ts'
import type { ImportedMediaCatalogItem } from '../derive/mediaCatalog.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import type {
  CanonicalAddedCountry,
  CanonicalEditorState,
  CanonicalMediaItem,
  CanonicalPlace,
  CanonicalTravelRecord,
  CanonicalWantToGoItem,
  PlaceId,
} from './types.ts'

/** 中文名的语言标签（RFC LOC-2：现有中文名全为简体）。 */
export const ZH = 'zh-Hans'
/** 英文名的语言标签。 */
export const EN = 'en'

export type PlaceIndex = ReadonlyMap<PlaceId, CanonicalPlace>

export const indexPlaces = (places: readonly CanonicalPlace[]): PlaceIndex =>
  new Map(places.map((place) => [place.id, place]))

/** 只写非空值（PR2 规格 §2.3）。 */
export const namesOf = (zh: unknown, en: unknown): Record<string, string> => {
  const names: Record<string, string> = {}
  if (typeof zh === 'string' && zh) names[ZH] = zh
  if (typeof en === 'string' && en) names[EN] = en
  return names
}

export const isoOf = (place: CanonicalPlace | undefined): string | undefined =>
  place?.externalIds?.iso3166Alpha2

/** 城市地点所属的国家地点；国家地点就是它自己。 */
export const countryPlaceOf = (places: PlaceIndex, place: CanonicalPlace | undefined): CanonicalPlace | undefined => {
  if (!place) return undefined
  if (place.subtype === 'country') return place
  return place.partOf === undefined ? undefined : places.get(place.partOf)
}

/** 旧双语匹配输入的形状。Core 的 Entity.title 已改为 LocalizedText，不再用它显示。 */
export type PlaceTitle = { zh: string; en?: string }

/**
 * 旧双语规则的兼容辅助函数，仅保留给冻结的 placeResolver 测试（这些测试不改动）。
 * 生产匹配用独立的 matchNameOf，Core 显示用 LocalizedText / resolveName；两者都不再依赖这里。
 */
export const placeTitle = (place: Pick<CanonicalPlace, 'names'>): PlaceTitle => {
  const nameZh = place.names[ZH] ?? ''
  const nameEn = (place.names[EN] ?? '') || nameZh
  const title: PlaceTitle = { zh: nameZh || nameEn || '' }
  if (nameEn) title.en = nameEn
  return title
}

/** 记录上的国家字段：中文名、英文名（没有则为空字符串）、国家代码（ISO 的小写；没有 ISO 就不写）。 */
export const legacyCountryFields = (country: CanonicalPlace | undefined) => {
  const iso = isoOf(country)
  return {
    country: country?.names[ZH] ?? '',
    country_en: country?.names[EN] ?? '',
    ...(iso ? { country_code: iso.toLowerCase() } : {}),
  }
}

/** 记录上的城市字段：中文名、英文名（没有则为空字符串）。 */
export const legacyCityFields = (city: CanonicalPlace | undefined) => ({
  city: city?.names[ZH] ?? '',
  city_en: city?.names[EN] ?? '',
})

/**
 * Canonical 足迹记录 → 今天的 `TravelMapRecord`：事实字段原样，名称与代码由所属城市及其国家重建。
 * 不含 `travelCategory` / `hiddenFromHome` 的派生值（那是 `./derive.ts` 的事），记录自带的覆盖值保留。
 */
export const reconstructRecord = (record: CanonicalTravelRecord, places: PlaceIndex): TravelMapRecord => {
  const { placeId, ...facts } = record
  const city = places.get(placeId)
  return {
    ...facts,
    ...legacyCountryFields(countryPlaceOf(places, city)),
    ...legacyCityFields(city),
  }
}

/** 名称供媒体项使用：英文名，没有则中文名（与 import-media.mjs 写入 countryName / cityName 的取法一致）。 */
const displayNameOf = (place: CanonicalPlace | undefined): string | undefined =>
  place?.names[EN] ?? place?.names[ZH]

/**
 * Canonical 媒体项 → 今天的媒体目录条目。
 * 引用的城市地点不存在（悬空引用）时不写 `countryId` / `countryName` / `cityName`：Canonical 里没有这些信息。
 */
export const reconstructMediaItem = (item: CanonicalMediaItem, places: PlaceIndex): ImportedMediaCatalogItem => {
  const { placeId, title, ...facts } = item
  const place = places.get(placeId)
  const city = place?.subtype === 'city' ? place : undefined
  const country = city?.partOf === undefined ? undefined : places.get(city.partOf)
  const countryName = displayNameOf(country)
  const cityName = displayNameOf(city)
  const titleZh = title?.names[ZH]
  const titleEn = title?.names[EN]
  return {
    ...facts,
    ...(city?.partOf !== undefined ? { countryId: city.partOf } : {}),
    cityId: placeId,
    ...(countryName !== undefined ? { countryName } : {}),
    ...(cityName !== undefined ? { cityName } : {}),
    ...(titleZh !== undefined ? { titleZh } : {}),
    ...(titleEn !== undefined ? { titleEn } : {}),
  } as ImportedMediaCatalogItem
}

/**
 * Canonical 想去条目 → UI 读到的 `WantToGoItem`（`../derive/wantToGo.ts`；Core 想去适配器直接收 Canonical 条目）：
 * `kind` ← subtype，名称 ← names，`countryCode` ← 自身（国家）或 partOf（城市）的 ISO，`lat` / `lng` ← location。
 */
export const reconstructWantToGoItem = (item: CanonicalWantToGoItem, places: PlaceIndex): WantToGoItem => {
  const place = places.get(item.placeId)
  const place_: WantToGoPlace = {
    kind: place?.subtype ?? 'city',
    nameZh: place?.names[ZH] ?? '',
    nameEn: place?.names[EN] ?? '',
    countryCode: isoOf(countryPlaceOf(places, place)) ?? '',
  }
  if (place?.location) {
    place_.lat = place.location.lat
    place_.lng = place.location.lng
  }
  const result: WantToGoItem = { id: item.id, place: place_, addedAt: item.addedAt, hidden: item.hidden }
  if (item.note !== undefined) result.note = item.note
  if (item.source !== undefined) result.source = item.source
  return result
}

/**
 * editor-state 的手动添加国家 → 今天的 `LocalEditorCountry`：名称、代码、中心坐标取自地点；
 * 地点没有代码 / 坐标时才用条目自己保留的值（见 `CanonicalAddedCountry`）。
 */
export const reconstructAddedCountry = (entry: CanonicalAddedCountry, places: PlaceIndex): LocalEditorCountry => {
  const place = places.get(entry.placeId)
  const iso = isoOf(place)
  const center = place?.location ?? entry.center
  return {
    id: entry.placeId,
    nameZh: place?.names[ZH] ?? '',
    nameEn: place?.names[EN] ?? '',
    countryCode: iso ? iso.toLowerCase() : entry.countryCode ?? '',
    // 适配器保证两者至少有一个（条目通过了 isLocalEditorCountry，自带数字坐标）。
    centerLat: center?.lat ?? Number.NaN,
    centerLng: center?.lng ?? Number.NaN,
    ...(entry.region !== undefined ? { region: entry.region } : {}),
    ...(entry.visitedDate !== undefined ? { visitedDate: entry.visitedDate } : {}),
  }
}

/** editor-state v2 → 今天 `parseEditorState` 的输出形状（v1）。键与值里的地点 id 原样，其余字段原样。 */
export const reconstructEditorState = (state: CanonicalEditorState, places: PlaceIndex): TravelAtlasEditorState => ({
  schemaVersion: 1,
  addedCountries: state.addedCountries.map((entry) => reconstructAddedCountry(entry, places)),
  countryOrder: state.countryOrder,
  hiddenCountryIds: state.hiddenCountryIds,
  cityOrderByCountry: state.cityOrderByCountry,
  hiddenCityIds: state.hiddenCityIds,
  mediaOrderByCity: state.mediaOrderByCity,
  hiddenMediaIds: state.hiddenMediaIds,
  coverMediaByCity: state.coverMediaByCity,
  droneOrderByCity: state.droneOrderByCity,
  hiddenDroneMediaIds: state.hiddenDroneMediaIds,
  updatedAt: state.updatedAt,
})

/**
 * 足迹记录（visited 与 planned）引用到的国家地点，按首次出现的顺序。
 * 这就是「足迹国家」；`travelAtlasCountryCodes` 与想去城市的 partOf 都按它来。
 */
export const footprintCountryIds = (records: readonly CanonicalTravelRecord[], places: PlaceIndex): PlaceId[] => {
  const ids: PlaceId[] = []
  const seen = new Set<PlaceId>()
  for (const record of records) {
    const country = countryPlaceOf(places, places.get(record.placeId))
    if (!country || seen.has(country.id)) continue
    seen.add(country.id)
    ids.push(country.id)
  }
  return ids
}

/**
 * 重建 `display.countryCodes` / `travelAtlasCountryCodes`：每个有 ISO 的足迹国家，
 * 英文名（没有则中文名）→ ISO 小写（PR2 规格 §2.4）。
 */
export const rebuildCountryCodes = (records: readonly CanonicalTravelRecord[], places: PlaceIndex): Record<string, string> => {
  const codes: Record<string, string> = {}
  for (const id of footprintCountryIds(records, places)) {
    const country = places.get(id)
    const iso = isoOf(country)
    if (!country || !iso) continue
    codes[country.names[EN] || country.names[ZH] || ''] = iso.toLowerCase()
  }
  return codes
}
