/**
 * 从 Canonical Model 派生 App 今天的全部导出（RFC-LOC-1 PR2 规格 §2.4）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。`deriveAppDataFromCanonical` 的结果与 PR1 的
 * `deriveAppData`（`../derive/appData.ts`）【同名、同形状】（`AppData`），UI 与 Core 一行不改。
 *
 * 规则与计算逐条对应 `../derive/*.ts` 的现有实现，只是「按名字」换成「按地点」：
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

import { plannedEntityId } from '../../worldgraph/adapters/plannedRecords.ts'
import { wantToGoEntityId, type WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import { slugify as coreSlugify } from '../../worldgraph/slug.ts'
import type { EntityId } from '../../worldgraph/types.ts'
import type { AppData } from '../derive/appData.ts'
import { deriveDroneMedia } from '../derive/droneMedia.ts'
import { orderBySavedIds, type TravelAtlasEditorState } from '../derive/editorState.ts'
import { deriveMediaCatalog, getMediaSource } from '../derive/mediaCatalog.ts'
import {
  coordinateForRecord,
  countryAccent,
  flagEmojiForCode,
  formatDateRange,
  unique,
} from '../derive/travelAtlas.ts'
import { plannedConvertBlockReason, type WantToGoTravelInput } from '../derive/wantToGo.ts'
import { deriveWorldGraph } from '../derive/worldGraph.ts'
import type { City, CityId, Country, CountryId, JourneyDay, Route, TravelMapRecord } from '../../types/travel.ts'
import { classifyByPlace, displaySets, hiddenFromHomeFor } from './classify.ts'
import {
  countryPlaceOf,
  indexPlaces,
  isoOf,
  rebuildCountryCodes,
  reconstructEditorState,
  reconstructMediaItem,
  reconstructRecord,
  reconstructWantToGoItem,
  type PlaceIndex,
} from './reconstruct.ts'
import type { CanonicalData, CanonicalWantToGo, PlaceId } from './types.ts'

export interface CanonicalDeriveOptions {
  /** 快照的 createdAt / updatedAt（App 里是 worldGraphSessionNow）。 */
  now: string
}

/** 显示中的一条记录：重建后的记录 + 它的城市与国家地点 id。 */
interface PlacedRecord {
  record: TravelMapRecord
  cityId: PlaceId
  countryId: PlaceId
}

/** 与 `../derive/travelAtlas.ts` 的 `deriveTravelAtlas` 逐条对应；分组按地点 id。 */
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
  }
}

// ---- 想去（照抄 ../derive/wantToGo.ts 解析之后的部分；解析已在 Legacy Adapter 里做过）----

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const footprintCityKey = (countryCode: string, nameEn: string) => `${countryCode.toUpperCase()}:${coreSlugify(nameEn)}`

const deriveWantToGoFromCanonical = (wantToGo: CanonicalWantToGo, places: PlaceIndex, travel: WantToGoTravelInput) => {
  const { cities, countryById, plannedRecords } = travel

  const wantToGoItems: WantToGoItem[] = wantToGo.items.map((item) => reconstructWantToGoItem(item, places))

  const wantToGoProblems: string[] = wantToGo.problems

  const hiddenWantToGoItems: WantToGoItem[] = wantToGoItems
    .filter((item) => item.hidden)
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))

  const wantToGoItemByEntityId = new Map<EntityId, WantToGoItem>()
  for (const item of wantToGoItems) {
    const entityId = wantToGoEntityId(item.place.countryCode, item.place.nameEn)
    if (!wantToGoItemByEntityId.has(entityId)) wantToGoItemByEntityId.set(entityId, item)
  }

  const plannedRecordByEntityId = new Map<EntityId, TravelMapRecord>()
  for (const record of plannedRecords) {
    const entityId = plannedEntityId(record.id)
    if (!plannedRecordByEntityId.has(entityId)) plannedRecordByEntityId.set(entityId, record)
  }

  const footprintCityKeys = new Set(cities.flatMap((city) => {
    const countryCode = city.countryId ? countryById[city.countryId]?.flagCode : undefined
    return countryCode && city.nameEn ? [footprintCityKey(countryCode, city.nameEn)] : []
  }))

  const wantToGoConvertBlockReason = (item: WantToGoItem): string | undefined => {
    if (item.place.kind !== 'city') return '整个国家的想去需要先具体到城市，暂不支持直接转为足迹。'
    if (!isFiniteNumber(item.place.lat) || !isFiniteNumber(item.place.lng)) return '这个地点没有坐标，无法转为足迹。'
    if (footprintCityKeys.has(footprintCityKey(item.place.countryCode, item.place.nameEn))) {
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
    wantToGoConvertBlockReason,
    plannedConvertBlockReason,
  }
}

/**
 * Canonical → App 今天的全部导出（与 `deriveAppData` 同名、同形状）。依赖顺序与 PR1 相同：
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
  const wantToGo = deriveWantToGoFromCanonical(canonical.wantToGo, places, travelAtlas)
  const worldGraph = deriveWorldGraph(travelAtlas, wantToGo.wantToGoItems, options.now)

  return {
    travelAtlas: { travelAtlasDataSource: canonical.travel.source, ...travelAtlas },
    editorState: { travelAtlasEditorState, orderBySavedIds },
    mediaCatalog: { getMediaSource, ...mediaCatalog },
    droneMedia,
    wantToGo: { wantToGoDataSource: canonical.wantToGo.source, ...wantToGo },
    worldGraph: { worldGraphSessionNow: options.now, ...worldGraph },
  }
}
