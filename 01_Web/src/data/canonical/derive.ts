/**
 * 从 Canonical Model 派生 App 今天的全部导出（RFC-LOC-1 PR2 规格 §2.4）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。`deriveAppDataFromCanonical` 的结果与 PR1 的
 * 旧派生 `deriveAppData` 【同名、同形状】（`AppData`，PR5b 删除旧派生时从 `../derive/appData.ts` 移到本文件），
 * UI 与 Core 一行不改。
 *
 * 规则与计算逐条对应 PR1 旧派生（`../derive/*.ts`，PR5b 删除）的实现，只是「按名字」换成「按地点」：
 * - 分组（国家 / 城市）、editor 隐藏、城市所属国家、行程日与路线的城市 id —— 按地点 id；
 * - 分类与导航隐藏 —— 按 Canonical 显示规则里的地点 id（`./classify.ts`）；
 * - 国旗 —— 地点的 ISO；国家中心、城市坐标 —— 地点的 location；
 * - UI 与 Core 读到的对象（记录、想去条目、媒体项、editor-state 的手动添加国家）由地点重建（`./reconstruct.ts`）；
 * - 其余展示用的计算（标题、摘要、「N 个城市」、路线是否跨国）照抄今天的代码，作用在重建后的记录上。
 * 能复用的 PR1 函数直接复用：`orderBySavedIds`、`formatDateRange`、`coordinateForRecord`、国旗与配色、
 * 媒体与无人机派生、三个 Core 适配器与 `mergeWorldGraphSnapshots`（经 `deriveWorldGraph`）。
 *
 * 本文件不 import 任何按名字推导身份的旧规则（eslint 拦截）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { PlaceInput } from '../../worldgraph/adapters/places.ts'
import type { PlannedRecordInput } from '../../worldgraph/adapters/plannedRecords.ts'
import type { EntityId } from '../../worldgraph/types.ts'
import { deriveDroneMedia, type DroneMediaDerived } from '../derive/droneMedia.ts'
import { orderBySavedIds, type TravelAtlasEditorState } from '../derive/editorState.ts'
import { deriveMediaCatalog, getMediaSource, type MediaCatalogDerived } from '../derive/mediaCatalog.ts'
import {
  coordinateForRecord,
  countryAccent,
  flagEmojiForCode,
  formatDateRange,
  unique,
} from '../derive/travelAtlas.ts'
import {
  plannedConvertBlockReason,
  type WantToGoDataSource,
  type WantToGoItem,
  type WantToGoTravelInput,
} from '../derive/wantToGo.ts'
import { deriveWorldGraph, type WorldGraphDerived } from '../derive/worldGraph.ts'
import type { City, CityId, Country, CountryId, JourneyDay, Route, TravelMapRecord } from '../../types/travel.ts'
import { classifyByPlace, displaySets, hiddenFromHomeFor } from './classify.ts'
import {
  countryPlaceOf,
  indexPlaces,
  isoOf,
  placeTitle,
  rebuildCountryCodes,
  reconstructEditorState,
  reconstructMediaItem,
  reconstructRecord,
  reconstructWantToGoItem,
  type PlaceIndex,
} from './reconstruct.ts'
import type { CanonicalData, CanonicalPlace, CanonicalTravelRecord, CanonicalWantToGo, PlaceId } from './types.ts'

export interface CanonicalDeriveOptions {
  /** 快照的 createdAt / updatedAt（App 里是 worldGraphSessionNow）。 */
  now: string
}

/** 足迹派生的全部导出（`travelAtlasDataSource` 除外：它是 Canonical 的来源）。 */
export type TravelAtlasDerived = ReturnType<typeof deriveTravelAtlasFromCanonical>

/** 想去派生的全部导出（`wantToGoDataSource` 除外）。 */
export type WantToGoDerived = ReturnType<typeof deriveWantToGoFromCanonical>

/** 六个模块今天的全部导出（名字相同），按模块分组（RFC-LOC-1 PR1 §2.3）。 */
export interface AppData {
  travelAtlas: { travelAtlasDataSource: 'local' | 'sample' } & TravelAtlasDerived
  editorState: { travelAtlasEditorState: TravelAtlasEditorState; orderBySavedIds: typeof orderBySavedIds }
  mediaCatalog: { getMediaSource: typeof getMediaSource } & MediaCatalogDerived
  droneMedia: DroneMediaDerived
  wantToGo: { wantToGoDataSource: WantToGoDataSource } & WantToGoDerived
  worldGraph: { worldGraphSessionNow: string } & WorldGraphDerived
}

/** 显示中的一条记录：重建后的记录 + 它的城市与国家地点 id。 */
interface PlacedRecord {
  record: TravelMapRecord
  cityId: PlaceId
  countryId: PlaceId
}

/** 与 PR1 旧派生 `deriveTravelAtlas`（PR5b 删除）逐条对应；分组按地点 id。 */
const deriveTravelAtlasFromCanonical = (
  canonical: CanonicalData,
  places: PlaceIndex,
  editorState: TravelAtlasEditorState,
) => {
  const { meta, display, records: canonicalRecords } = canonical.travel
  const sets = displaySets(display)

  const travelAtlasDisplay = {
    overviewTarget: display.overviewTarget ?? { lat: 20, lng: 0 },
  }

  const countryIdOf = (cityId: PlaceId): PlaceId => countryPlaceOf(places, places.get(cityId))?.id ?? ''

  // FR-TA-5：planned 记录照旧不进足迹，原样（名称由地点重建）交给 Core 的 plannedRecords 适配器。
  const plannedRecords: TravelMapRecord[] = canonicalRecords
    .filter((record) => record.status === 'planned')
    .map((record) => reconstructRecord(record, places))
  const travelAtlasCountryCodes: Record<string, string> = rebuildCountryCodes(canonicalRecords, places)

  const allPlaced: PlacedRecord[] = canonicalRecords
    .filter((record) => record.status !== 'planned')
    .map((canonicalRecord) => {
      const countryId = countryIdOf(canonicalRecord.placeId)
      const record = reconstructRecord(canonicalRecord, places)
      const travelCategory = classifyByPlace(record, countryId, sets)
      return {
        record: {
          ...record,
          journeyId: canonicalRecord.journeyId,
          travelCategory,
          hiddenFromHome: hiddenFromHomeFor(record, travelCategory),
        },
        cityId: canonicalRecord.placeId,
        countryId,
      }
    })
  const allRecords = allPlaced.map(({ record }) => record)
  const hiddenEditorCountryIds = new Set(editorState.hiddenCountryIds)
  const hiddenEditorCityIds = new Set(editorState.hiddenCityIds)
  const placed = allPlaced.filter(({ record, countryId, cityId }) => (
    !record.hiddenFromHome
    && !hiddenEditorCountryIds.has(countryId)
    && !hiddenEditorCityIds.has(cityId)
  ))
  const records = placed.map(({ record }) => record)

  // 与今天一样用普通对象分组：键的遍历顺序（含整数键优先的规则）与旧派生一致。
  const placedByCountry = placed.reduce(
    (acc, entry) => {
      acc[entry.countryId] = [...(acc[entry.countryId] ?? []), entry]
      return acc
    },
    {} as Record<CountryId, PlacedRecord[]>,
  )

  const placedByCity = placed.reduce(
    (acc, entry) => {
      acc[entry.cityId] = [...(acc[entry.cityId] ?? []), entry]
      return acc
    },
    {} as Record<CityId, PlacedRecord[]>,
  )

  const travelAtlasMeta = {
    schemaVersion: meta.schemaVersion,
    generatedAt: meta.generatedAt,
    privacyLevel: meta.privacyLevel,
    intendedUse: meta.intendedUse,
    totalRecords: records.length,
    importedRecords: allRecords.length,
    hiddenHomeRecords: allRecords.length - records.length,
    recordsWithCoordinates: records.filter((record) => Boolean(coordinateForRecord(record))).length,
    recordsMissingCoordinates: records.filter((record) => !coordinateForRecord(record)).length,
  }

  const hiddenHomeRecords = allRecords.filter((record) => record.hiddenFromHome)

  const recordCountries: Country[] = Object.entries(placedByCountry).map(([countryId, countryPlaced], index) => {
    const place = places.get(countryId)
    const countryRecords = countryPlaced.map(({ record }) => record)
    const first = countryRecords[0]
    const centerLat = place?.location?.lat ?? null
    const centerLng = place?.location?.lng ?? null
    const cityIds = unique(countryPlaced.map(({ cityId }) => cityId))
    const cityNames = unique(countryRecords.map((record) => record.city_en || record.city)).filter(Boolean)
    const tripTitles = unique(countryRecords.map((record) => record.trip_title).filter((title): title is string => Boolean(title)))
    const flagCode = isoOf(place)?.toLowerCase()

    return {
      id: countryId,
      nameZh: first.country,
      nameEn: first.country_en || first.country,
      centerLat,
      centerLng,
      visitedDateRange: formatDateRange(countryRecords),
      summary: `${cityNames.length} visited cities collected from Archive export.`,
      memory: tripTitles.length > 0 ? tripTitles.slice(0, 3).join(' / ') : 'Travel memory imported from Archive export.',
      keywords: unique(countryRecords.map((record) => record.region).filter((region): region is string => Boolean(region))).slice(0, 3),
      cityIds: orderBySavedIds(
        cityIds.map((id) => ({ id })),
        editorState.cityOrderByCountry[countryId],
      ).map(({ id }) => id),
      accent: countryAccent(index),
      flag: flagEmojiForCode(flagCode),
      flagCode,
      missingCoordinates: centerLat === null || centerLng === null,
      records: countryRecords,
    }
  })

  // 手动添加的国家：editor-state 条目经地点重建后（名称、代码、中心坐标取自地点），照抄今天的映射。
  const recordCountryIds = new Set(recordCountries.map((country) => country.id))
  const standaloneCountries: Country[] = editorState.addedCountries
    .filter((country) => !recordCountryIds.has(country.id) && !hiddenEditorCountryIds.has(country.id))
    .map((country, index) => ({
      id: country.id,
      nameZh: country.nameZh,
      nameEn: country.nameEn,
      centerLat: country.centerLat,
      centerLng: country.centerLng,
      visitedDateRange: country.visitedDate ?? 'Date unknown',
      summary: 'Country added locally. Add the first city from City Cards when ready.',
      memory: 'Awaiting the first city record.',
      keywords: country.region ? [country.region] : [],
      cityIds: [],
      accent: countryAccent(recordCountries.length + index),
      flag: flagEmojiForCode(country.countryCode),
      flagCode: country.countryCode.toLowerCase(),
      missingCoordinates: false,
      records: [],
    }))
  const unorderedCountries = [...recordCountries, ...standaloneCountries]

  const countries = orderBySavedIds(unorderedCountries, editorState.countryOrder)

  const cities: City[] = Object.entries(placedByCity).map(([cityId, cityPlaced]) => {
    const place = places.get(cityId)
    const cityRecords = cityPlaced.map(({ record }) => record)
    const first = cityRecords[0]
    const coordinate = place?.location
    const tripTitles = unique(cityRecords.map((record) => record.trip_title).filter((title): title is string => Boolean(title)))
    const dateRange = formatDateRange(cityRecords)

    return {
      id: cityId,
      nameZh: first.city,
      nameEn: first.city_en || first.city,
      countryId: cityPlaced[0].countryId,
      lat: coordinate?.lat ?? null,
      lng: coordinate?.lng ?? null,
      visitedDateRange: dateRange,
      summary: tripTitles.length > 0 ? tripTitles.slice(0, 2).join(' / ') : `Visited on ${dateRange}.`,
      memory: first.notes || undefined,
      keywords: unique(cityRecords.map((record) => record.region).filter((region): region is string => Boolean(region))).slice(0, 3),
      missingCoordinates: !coordinate,
      records: cityRecords,
    }
  })

  const journeyDays: JourneyDay[] = placed.map(({ record, cityId, countryId }) => ({
    id: record.id,
    date: record.start_date,
    countryId,
    cityId,
    title: record.trip_title || `${record.city_en || record.city} visit`,
    journeyId: record.journeyId,
    summary: record.end_date && record.end_date !== record.start_date
      ? `${record.city_en || record.city}, ${record.start_date} - ${record.end_date}`
      : `${record.city_en || record.city}, ${record.start_date}`,
    isHighlight: Boolean(record.notes),
  }))

  const placedByJourney = placed.reduce(
    (acc, entry) => {
      const journeyId = entry.record.journeyId ?? 'unknown-journey'
      acc[journeyId] = [...(acc[journeyId] ?? []), entry]
      return acc
    },
    {} as Record<string, PlacedRecord[]>,
  )

  const routes: Route[] = Object.entries(placedByJourney).flatMap(([journeyId, journeyPlaced]) => {
    const ordered = [...journeyPlaced].sort((a, b) =>
      `${a.record.start_date}-${a.record.id}`.localeCompare(`${b.record.start_date}-${b.record.id}`),
    )

    return ordered.slice(1).flatMap((entry, index) => {
      const previous = ordered[index]
      const fromCityId = previous.cityId
      const toCityId = entry.cityId
      if (fromCityId === toCityId) return []

      return [{
        id: `${journeyId}__${previous.record.id}__${entry.record.id}`,
        fromCityId,
        toCityId,
        journeyId,
        // 照抄今天的判断：比较（由地点重建的）国家英文名。两个国家都没有英文名时仍视为同一国家——
        // 与今天的行为一致，保证与 PR1 派生在统一写法后的数据上逐字节相同。
        type: previous.record.country_en === entry.record.country_en ? 'main' : 'flight',
      }]
    })
  })

  const countryById = countries.reduce(
    (acc, country) => {
      acc[country.id] = country
      return acc
    },
    {} as Record<CountryId, Country>,
  )

  const cityById = cities.reduce(
    (acc, city) => {
      acc[city.id] = city
      return acc
    },
    {} as Record<CityId, City>,
  )

  const getCitiesForCountry = (countryId: CountryId) =>
    countryById[countryId]?.cityIds.map((cityId) => cityById[cityId]).filter(Boolean) ?? []

  const shouldHideCityFromNavigation = (city: City) => sets.navigationHiddenCities.has(city.id)

  const missingCoordinateCities = cities.filter((city) => city.missingCoordinates)

  // RFC-LOC-1 PR3b-1 §2.5：城市 → 所属国家，覆盖【全部】城市地点（含被 editor 隐藏的：它们不在 cityById 里），
  // 取城市地点的 partOf。不是城市地点（国家、不存在的 id）为 undefined。
  const countryIdOfCity = (cityId: CityId): CountryId | undefined => {
    const place = places.get(cityId)
    return place?.subtype === 'city' ? place.partOf : undefined
  }

  return {
    travelAtlasDisplay,
    plannedRecords,
    travelAtlasCountryCodes,
    travelAtlasMeta,
    hiddenHomeRecords,
    countries,
    cities,
    journeyDays,
    routes,
    countryById,
    cityById,
    getCitiesForCountry,
    shouldHideCityFromNavigation,
    missingCoordinateCities,
    countryIdOfCity,
  }
}

// ---- 想去（照抄 PR1 旧派生 deriveWantToGo 解析之后的部分；PR5b 删除了旧派生，解析在 V2 Reader 里）----

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const deriveWantToGoFromCanonical = (
  wantToGo: CanonicalWantToGo,
  places: PlaceIndex,
  travel: WantToGoTravelInput,
  canonicalPlannedRecords: readonly CanonicalTravelRecord[],
) => {
  const { cities, plannedRecords } = travel

  const wantToGoItems: WantToGoItem[] = wantToGo.items.map((item) => reconstructWantToGoItem(item, places))

  const wantToGoProblems: string[] = wantToGo.problems

  const hiddenWantToGoItems: WantToGoItem[] = wantToGoItems
    .filter((item) => item.hidden)
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))

  // 过渡（RFC-LOC-1 Core-A A2 的第一个提交）：实体 id 已是地点 id，这两张表暂按地点 id 建（同一地点第一条胜出），
  // 下一个提交（想去卡片改为按记录取）删除它们。重建的条目与 Canonical 条目一一对应、顺序相同。
  const wantToGoItemByEntityId = new Map<EntityId, WantToGoItem>()
  wantToGo.items.forEach((item, index) => {
    if (!wantToGoItemByEntityId.has(item.placeId)) wantToGoItemByEntityId.set(item.placeId, wantToGoItems[index])
  })

  const plannedRecordByEntityId = new Map<EntityId, TravelMapRecord>()
  canonicalPlannedRecords.forEach((record, index) => {
    if (!plannedRecordByEntityId.has(record.placeId)) plannedRecordByEntityId.set(record.placeId, plannedRecords[index])
  })

  // 按记录 id 的两张表（Core 方案 C3 / C5）：成员关系的 recordId 就是这里的键。同一 id 第一条胜出。
  const wantToGoItemById = new Map<string, WantToGoItem>()
  for (const item of wantToGoItems) {
    if (!wantToGoItemById.has(item.id)) wantToGoItemById.set(item.id, item)
  }

  const plannedRecordById = new Map<string, TravelMapRecord>()
  for (const record of plannedRecords) {
    if (!plannedRecordById.has(record.id)) plannedRecordById.set(record.id, record)
  }

  // 「这个城市已经在足迹里了」按地点 id 判断（Core 方案 C5）：V2 下足迹城市的 id 就是地点 id。
  // 想去条目的 placeId 取自 Canonical 条目（Core 的 WantToGoItem 不带它），同一 id 第一条胜出。
  const footprintCityIds = new Set(cities.map((city) => city.id))
  const placeIdByWantToGoId = new Map<string, PlaceId>()
  for (const item of wantToGo.items) {
    if (!placeIdByWantToGoId.has(item.id)) placeIdByWantToGoId.set(item.id, item.placeId)
  }

  const wantToGoConvertBlockReason = (item: WantToGoItem): string | undefined => {
    if (item.place.kind !== 'city') return '整个国家的想去需要先具体到城市，暂不支持直接转为足迹。'
    if (!isFiniteNumber(item.place.lat) || !isFiniteNumber(item.place.lng)) return '这个地点没有坐标，无法转为足迹。'
    const placeId = placeIdByWantToGoId.get(item.id)
    if (placeId !== undefined && footprintCityIds.has(placeId)) {
      return '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。'
    }
    return undefined
  }

  return {
    wantToGoItems,
    wantToGoProblems,
    hiddenWantToGoItems,
    wantToGoItemByEntityId,
    plannedRecordByEntityId,
    wantToGoItemById,
    plannedRecordById,
    wantToGoConvertBlockReason,
    plannedConvertBlockReason,
  }
}

// ---- World Graph（RFC-LOC-1 Core-A：Core 的地点实体由注册表构造，想去与 planned 只按地点 id 引用它）----

/**
 * 注册表地点 → Core 的 `PlaceInput`：标题见 `placeTitle`；国家代码取 ISO（国家取自身，城市取所属国家，大写）；
 * `partOf`、`location` 照搬（`location.approximate` 不进 Core）。
 */
const placeInputOf = (place: CanonicalPlace, places: PlaceIndex): PlaceInput => {
  const input: PlaceInput = { id: place.id, subtype: place.subtype, title: placeTitle(place) }
  const iso = isoOf(countryPlaceOf(places, place))
  if (iso) input.countryCode = iso.toUpperCase()
  if (place.partOf !== undefined) input.partOf = place.partOf
  if (place.location) input.location = { lat: place.location.lat, lng: place.location.lng }
  return input
}

/** planned 足迹记录 → Core 的 `PlannedRecordInput`：只要 id、地点、日期与备注（名称与坐标属于地点）。 */
const plannedRecordInputOf = (record: CanonicalTravelRecord): PlannedRecordInput => {
  const input: PlannedRecordInput = { id: record.id, placeId: record.placeId, start_date: record.start_date }
  if (record.notes !== undefined) input.notes = record.notes
  return input
}

/**
 * Canonical → App 今天的全部导出（与 PR1 旧派生 `deriveAppData` 同名、同形状）。依赖顺序与 PR1 相同：
 * editor-state → 足迹 → 媒体 → 无人机 → 想去 → World Graph。
 */
export function deriveAppDataFromCanonical(canonical: CanonicalData, options: CanonicalDeriveOptions): AppData {
  const places = indexPlaces(canonical.places)
  const travelAtlasEditorState = reconstructEditorState(canonical.editorState, places)
  const travelAtlas = deriveTravelAtlasFromCanonical(canonical, places, travelAtlasEditorState)
  const mediaCatalog = deriveMediaCatalog(
    { schemaVersion: 2, items: canonical.media.items.map((item) => reconstructMediaItem(item, places)) },
    travelAtlasEditorState,
  )
  const droneMedia = deriveDroneMedia(mediaCatalog.importedDroneMediaCatalogItems)
  const canonicalPlannedRecords = canonical.travel.records.filter((record) => record.status === 'planned')
  const wantToGo = deriveWantToGoFromCanonical(canonical.wantToGo, places, travelAtlas, canonicalPlannedRecords)
  const worldGraph = deriveWorldGraph({
    places: canonical.places.map((place) => placeInputOf(place, places)),
    countries: travelAtlas.countries,
    cities: travelAtlas.cities,
    journeyDays: travelAtlas.journeyDays,
    routes: travelAtlas.routes,
    wantToGoItems: canonical.wantToGo.items,
    plannedRecords: canonicalPlannedRecords.map(plannedRecordInputOf),
  }, options.now)

  return {
    travelAtlas: { travelAtlasDataSource: canonical.travel.source, ...travelAtlas },
    editorState: { travelAtlasEditorState, orderBySavedIds },
    mediaCatalog: { getMediaSource, ...mediaCatalog },
    droneMedia,
    wantToGo: { wantToGoDataSource: canonical.wantToGo.source, ...wantToGo },
    worldGraph: { worldGraphSessionNow: options.now, ...worldGraph },
  }
}
