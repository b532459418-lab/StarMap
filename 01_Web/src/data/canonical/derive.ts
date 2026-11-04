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
 * - 其余展示用的计算（标题、摘要）照抄今天的代码，作用在重建后的记录上；「N 个城市」按城市地点 id 计数，
 *   路线是否跨国比较两端城市所属国家的地点 id，行程内的先后按码点比较（审查 C3，见 ./journeyRoutes.ts）。
 * 能复用的 PR1 函数直接复用：`orderBySavedIds`、`formatDateRange`、`coordinateForRecord`、国旗与配色、
 * 媒体与无人机派生、Core 适配器与 `mergeWorldGraphSnapshots`（经 `deriveWorldGraph`；RFC-LOC-1 Core-A 起多了
 * 地点适配器：Core 的地点实体由注册表构造，见文件末尾的 `placeInputOf`）。
 *
 * 本文件不 import 任何按名字推导身份的旧规则（eslint 拦截）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { PlaceInput } from '../../worldgraph/adapters/places.ts'
import type { PlannedRecordInput } from '../../worldgraph/adapters/plannedRecords.ts'
import { copyLocalizedText } from '../../worldgraph/localizedText.ts'
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
import type { WantToGoDataSource, WantToGoItem, WantToGoTravelInput } from '../derive/wantToGo.ts'
import { mergeWorldGraph, placesWorldGraph, plannedWorldGraph, travelWorldGraph, wantToGoWorldGraph, type WorldGraphDerived } from '../derive/worldGraph.ts'
import { messageFor } from '../editor/errors.ts'
import type { City, CityId, Country, CountryId, JourneyDay, Route, TravelMapRecord } from '../../types/travel.ts'
import { classifyByPlace, displaySets, hiddenFromHomeFor } from './classify.ts'
import { convertRuleDataOfCanonical, convertRules, type ConvertRules } from './convertRules.ts'
import { compareJourneyRecords, routeTypeBetween } from './journeyRoutes.ts'
import {
  countryPlaceOf,
  indexPlaces,
  isoOf,
  rebuildCountryCodes,
  reconstructAddedCountry,
  reconstructEditorStateWith,
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
export type TravelAtlasDerived = ReturnType<typeof travelAtlasOf>

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

/**
 * 与 PR1 旧派生 `deriveTravelAtlas`（PR5b 删除）逐条对应；分组按地点 id。③（scope-incremental）起分成几步，各步只读它真正
 * 用到的输入，由 `deriveAppDataFromCanonical` 按输入缓存（见文件末尾的 `step`）；每一步的代码与原来相同，只是搬了位置：
 * - `deriveTravelPlaced`：显示中的记录及由它们分出的城市、行程日、路线与各计数（读足迹文件、地点、编辑器隐藏的国家与城市）；
 * - `deriveRecordCountries`：有记录的国家（另读手动添加国家的大洲、城市顺序）；
 * - `deriveStandaloneCountries`：只有手动添加、没有记录的国家；
 * - `deriveCountries`：按保存的国家顺序排好的全部国家，`countryById` 与 `getCitiesForCountry`；
 * - `travelAtlasOf`：拼成今天的导出（键的顺序与原来相同）。
 */
const deriveTravelPlaced = (
  travel: CanonicalData['travel'],
  places: PlaceIndex,
  hiddenCountryIds: readonly CountryId[],
  hiddenCityIds: readonly CityId[],
) => {
  const { meta, display, records: canonicalRecords } = travel
  const sets = displaySets(display)

  const travelAtlasDisplay = {
    overviewTarget: display.overviewTarget ?? { lat: 20, lng: 0 },
  }

  const countryIdOf = (cityId: PlaceId): PlaceId => countryPlaceOf(places, places.get(cityId))?.id ?? ''

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
  const hiddenEditorCountryIds = new Set(hiddenCountryIds)
  const hiddenEditorCityIds = new Set(hiddenCityIds)
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
    const ordered = [...journeyPlaced].sort((a, b) => compareJourneyRecords(a.record, b.record))

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
        // 两端城市所属国家的地点 id 相同为国内（审查 C3）；原来比较国家英文名，两个国家都没有英文名时会被当成同一个国家。
        type: routeTypeBetween(previous.countryId, entry.countryId),
      }]
    })
  })

  const cityById = cities.reduce(
    (acc, city) => {
      acc[city.id] = city
      return acc
    },
    {} as Record<CityId, City>,
  )

  const shouldHideCityFromNavigation = (city: City) => sets.navigationHiddenCities.has(city.id)

  const missingCoordinateCities = cities.filter((city) => city.missingCoordinates)

  // RFC-LOC-1 PR3b-1 §2.5：城市 → 所属国家，覆盖【全部】城市地点（含被 editor 隐藏的：它们不在 cityById 里），
  // 取城市地点的 partOf。不是城市地点（国家、不存在的 id）为 undefined。
  const countryIdOfCity = (cityId: CityId): CountryId | undefined => {
    const place = places.get(cityId)
    return place?.subtype === 'city' ? place.partOf : undefined
  }

  return {
    travelAtlasDisplay, travelAtlasMeta, hiddenHomeRecords, placedByCountry, cities, journeyDays, routes, cityById,
    shouldHideCityFromNavigation, missingCoordinateCities, countryIdOfCity,
  }
}
type TravelPlaced = ReturnType<typeof deriveTravelPlaced>

/** FR-TA-5：planned 记录照旧不进足迹，原样（名称由地点重建）交给 Core 的 plannedRecords 适配器。 */
const derivePlannedRecords = (canonicalRecords: readonly CanonicalTravelRecord[], places: PlaceIndex): TravelMapRecord[] => canonicalRecords
  .filter((record) => record.status === 'planned')
  .map((record) => reconstructRecord(record, places))

/** 有记录的国家（配色按它在分组里的下标）。 */
const deriveRecordCountries = (
  placedByCountry: TravelPlaced['placedByCountry'],
  places: PlaceIndex,
  addedCountries: TravelAtlasEditorState['addedCountries'],
  cityOrderByCountry: TravelAtlasEditorState['cityOrderByCountry'],
): Country[] => {
  const addedCountryRegions = new Map(addedCountries.map((country) => [country.id, country.region]))

  return Object.entries(placedByCountry).map(([countryId, countryPlaced], index) => {
    const place = places.get(countryId)
    const countryRecords = countryPlaced.map(({ record }) => record)
    const first = countryRecords[0]
    const centerLat = place?.location?.lat ?? null
    const centerLng = place?.location?.lng ?? null
    const cityIds = unique(countryPlaced.map(({ cityId }) => cityId))
    const tripTitles = unique(countryRecords.map((record) => record.trip_title).filter((title): title is string => Boolean(title)))
    const flagCode = isoOf(place)?.toLowerCase()
    const recordRegions = unique(countryRecords.map((record) => record.region).filter((region): region is string => Boolean(region)))
    const addedRegion = addedCountryRegions.get(countryId)

    return {
      id: countryId,
      nameZh: first.country,
      nameEn: first.country_en || first.country,
      centerLat,
      centerLng,
      visitedDateRange: formatDateRange(countryRecords),
      // 按城市地点 id 计数（审查 C3）：同名的两个城市各算一个。
      summary: `${cityIds.length} visited cities collected from Archive export.`,
      memory: tripTitles.length > 0 ? tripTitles.slice(0, 3).join(' / ') : 'Travel memory imported from Archive export.',
      // 新增城市没有 region；保留该国家创建时已保存的大洲，不修改旅行记录。
      keywords: recordRegions.length > 0 ? recordRegions.slice(0, 3) : addedRegion ? [addedRegion] : [],
      cityIds: orderBySavedIds(
        cityIds.map((id) => ({ id })),
        cityOrderByCountry[countryId],
      ).map(({ id }) => id),
      accent: countryAccent(index),
      flag: flagEmojiForCode(flagCode),
      flagCode,
      missingCoordinates: centerLat === null || centerLng === null,
      records: countryRecords,
    }
  })
}

/** 手动添加的国家：editor-state 条目经地点重建后（名称、代码、中心坐标取自地点），照抄今天的映射。 */
const deriveStandaloneCountries = (
  addedCountries: TravelAtlasEditorState['addedCountries'],
  recordCountries: readonly Country[],
  hiddenCountryIds: readonly CountryId[],
): Country[] => {
  const recordCountryIds = new Set(recordCountries.map((country) => country.id))
  const hiddenEditorCountryIds = new Set(hiddenCountryIds)
  return addedCountries
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
}

/** 全部国家按保存的国家顺序；按 id 查国家；一个国家的城市（按国家的 cityIds）。 */
const deriveCountries = (
  recordCountries: readonly Country[],
  standaloneCountries: readonly Country[],
  countryOrder: TravelAtlasEditorState['countryOrder'],
  cityById: TravelPlaced['cityById'],
) => {
  const unorderedCountries = [...recordCountries, ...standaloneCountries]

  const countries = orderBySavedIds(unorderedCountries, countryOrder)

  const countryById = countries.reduce(
    (acc, country) => {
      acc[country.id] = country
      return acc
    },
    {} as Record<CountryId, Country>,
  )

  const getCitiesForCountry = (countryId: CountryId) =>
    countryById[countryId]?.cityIds.map((cityId) => cityById[cityId]).filter(Boolean) ?? []

  return { countries, countryById, getCitiesForCountry }
}

/** 足迹派生的导出（与 PR1 旧派生同名、同形状、同键序）。 */
const travelAtlasOf = (
  placed: TravelPlaced,
  plannedRecords: TravelMapRecord[],
  travelAtlasCountryCodes: Record<string, string>,
  { countries, countryById, getCitiesForCountry }: ReturnType<typeof deriveCountries>,
) => ({
  travelAtlasDisplay: placed.travelAtlasDisplay,
  plannedRecords,
  travelAtlasCountryCodes,
  travelAtlasMeta: placed.travelAtlasMeta,
  hiddenHomeRecords: placed.hiddenHomeRecords,
  countries,
  cities: placed.cities,
  journeyDays: placed.journeyDays,
  routes: placed.routes,
  countryById,
  cityById: placed.cityById,
  getCitiesForCountry,
  shouldHideCityFromNavigation: placed.shouldHideCityFromNavigation,
  missingCoordinateCities: placed.missingCoordinateCities,
  countryIdOfCity: placed.countryIdOfCity,
})


// ---- 想去（照抄 PR1 旧派生 deriveWantToGo 解析之后的部分；PR5b 删除了旧派生，解析在 V2 Reader 里）----

const deriveWantToGoFromCanonical = (
  wantToGo: CanonicalWantToGo,
  places: PlaceIndex,
  travel: WantToGoTravelInput,
  rules: ConvertRules,
) => {
  const { plannedRecords } = travel

  const wantToGoItems: WantToGoItem[] = wantToGo.items.map((item) => reconstructWantToGoItem(item, places))

  const wantToGoProblems: string[] = wantToGo.problems

  const hiddenWantToGoItems: WantToGoItem[] = wantToGoItems
    .filter((item) => item.hidden)
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))

  // 按记录 id 的两张表（Core 方案 C3 / C5）：成员关系的 recordId 就是这里的键。同一 id 第一条胜出。
  // 按实体 id 查条目的两张表在 RFC-LOC-1 Core-A 删除：实体 id 是地点 id，一个地点可以有几条记录；
  // 想去卡片按地点取一条可见记录（../derive/wantToGo.ts 的 wantToGoCardRecordOf）。
  const wantToGoItemById = new Map<string, WantToGoItem>()
  for (const item of wantToGoItems) {
    if (!wantToGoItemById.has(item.id)) wantToGoItemById.set(item.id, item)
  }

  const plannedRecordById = new Map<string, TravelMapRecord>()
  for (const record of plannedRecords) {
    if (!plannedRecordById.has(record.id)) plannedRecordById.set(record.id, record)
  }

  // 「标记为去过」的前置条件（审查 C2）：与写入端点同一份规则（./convertRules.ts），在 Canonical 的全部足迹记录上判断，
  // 按条目 / 记录 id 查（同一 id 第一条胜出）。返回端点拒绝时的同一句文案，Collection 与想去卡片显示时再按码译成当前语言。
  const wantToGoConvertBlockReason = (item: WantToGoItem): string | undefined => {
    const code = rules.wantToGoConvertBlockCode(item.id)
    return code === undefined ? undefined : messageFor(code)
  }

  const plannedConvertBlockReason = (record: TravelMapRecord): string | undefined => {
    const code = rules.plannedConvertBlockCode(record.id)
    return code === undefined ? undefined : messageFor(code)
  }

  return {
    wantToGoItems,
    wantToGoProblems,
    hiddenWantToGoItems,
    wantToGoItemById,
    plannedRecordById,
    wantToGoConvertBlockReason,
    plannedConvertBlockReason,
  }
}

// ---- World Graph（RFC-LOC-1 Core-A：Core 的地点实体由注册表构造，想去与 planned 只按地点 id 引用它）----

/**
 * 注册表地点 → Core 的 `PlaceInput`：多语言名称原样复制，不预先回退；国家代码取 ISO（国家取自身，城市取所属国家，大写）；
 * `partOf`、`location` 照搬（`location.approximate` 不进 Core）。
 */
const placeInputOf = (place: CanonicalPlace, places: PlaceIndex): PlaceInput => {
  const input: PlaceInput = { id: place.id, subtype: place.subtype, title: copyLocalizedText(place) }
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
 * 3C-5 D: the steps of a derivation remembered with their inputs (by identity). Passed to deriveAppDataFromCanonical
 * again with a Canonical whose unchanged sections are the same objects (../appStoreCore.ts), a step whose inputs did
 * not change gives its previous result: less work after a save, and the sections of the App's data that did not change
 * keep their identity (the components that read only them do not render again).
 */
export interface DeriveCache {
  readonly steps: Map<string, { readonly inputs: readonly unknown[]; readonly output: unknown }>
}
export const createDeriveCache = (): DeriveCache => ({ steps: new Map() })

function step<T>(cache: DeriveCache | undefined, name: string, inputs: readonly unknown[], compute: () => T): T {
  if (!cache) return compute()
  const last = cache.steps.get(name)
  if (last && last.inputs.length === inputs.length && last.inputs.every((input, index) => Object.is(input, inputs[index]))) return last.output as T
  const output = compute()
  cache.steps.set(name, { inputs, output })
  return output
}

/**
 * Canonical → App 今天的全部导出（与 PR1 旧派生 `deriveAppData` 同名、同形状）。依赖顺序与 PR1 相同：
 * editor-state → 足迹 → 媒体 → 无人机 → 想去 → World Graph。`cache`（3C-5 D）见上。
 *
 * ③（scope-incremental）：每一步的输入是它真正读的部分（官方视图的段与编辑状态的字段，它们在对账之后保持身份），所以一次
 * 保存只让读到改动的那几步重算：例如只改国家顺序时，媒体目录、无人机、想去与地点、想去、planned 三份快照都保持原对象；只改
 * 封面或照片列表时，足迹派生与地图快照都保持。值与整体派生相同（派生锁、基线锁）。
 */
export function deriveAppDataFromCanonical(canonical: CanonicalData, options: CanonicalDeriveOptions, cache?: DeriveCache): AppData {
  const places = step(cache, 'places', [canonical.places], () => indexPlaces(canonical.places))
  const canonicalEditorState = canonical.editorState
  const addedCountries = step(cache, 'addedCountries', [canonicalEditorState.addedCountries, places],
    () => canonicalEditorState.addedCountries.map((entry) => reconstructAddedCountry(entry, places)))
  const editorState = step(cache, 'editorState', [canonicalEditorState, addedCountries], () => reconstructEditorStateWith(canonicalEditorState, addedCountries))
  // The editor state's fields are those of the official view (the same arrays and maps), so they keep their identity too.
  const plannedRecords = step(cache, 'plannedRecords', [canonical.travel.records, places], () => derivePlannedRecords(canonical.travel.records, places))
  const travelAtlasCountryCodes = step(cache, 'travelAtlasCountryCodes', [canonical.travel.records, places], () => rebuildCountryCodes(canonical.travel.records, places))
  const placed = step(cache, 'travelPlaced', [canonical.travel, places, editorState.hiddenCountryIds, editorState.hiddenCityIds],
    () => deriveTravelPlaced(canonical.travel, places, editorState.hiddenCountryIds, editorState.hiddenCityIds))
  const recordCountries = step(cache, 'recordCountries', [placed, places, editorState.addedCountries, editorState.cityOrderByCountry],
    () => deriveRecordCountries(placed.placedByCountry, places, editorState.addedCountries, editorState.cityOrderByCountry))
  const standaloneCountries = step(cache, 'standaloneCountries', [editorState.addedCountries, recordCountries, editorState.hiddenCountryIds],
    () => deriveStandaloneCountries(editorState.addedCountries, recordCountries, editorState.hiddenCountryIds))
  const countries = step(cache, 'countries', [recordCountries, standaloneCountries, editorState.countryOrder, placed.cityById],
    () => deriveCountries(recordCountries, standaloneCountries, editorState.countryOrder, placed.cityById))
  const travelAtlas = step(cache, 'travelAtlas', [placed, plannedRecords, travelAtlasCountryCodes, countries], () => travelAtlasOf(placed, plannedRecords, travelAtlasCountryCodes, countries))
  // deriveMediaCatalog reads these five lists of the editor state (and keeps it for its functions: they read only them).
  const mediaCatalog = step(cache, 'mediaCatalog', [canonical.media, places, editorState.hiddenMediaIds, editorState.hiddenDroneMediaIds, editorState.mediaOrderByCity, editorState.coverMediaByCity, editorState.droneOrderByCity], () => deriveMediaCatalog(
    { schemaVersion: 2, items: canonical.media.items.map((item) => reconstructMediaItem(item, places)) },
    editorState,
  ))
  const droneMedia = step(cache, 'droneMedia', [mediaCatalog], () => deriveDroneMedia(mediaCatalog.importedDroneMediaCatalogItems))
  // Of the travel derivation the want-to-go derivation reads the planned records only.
  const wantToGo = step(cache, 'wantToGo', [canonical.wantToGo, canonical.places, canonical.travel, places, plannedRecords],
    () => deriveWantToGoFromCanonical(canonical.wantToGo, places, { plannedRecords }, convertRules(convertRuleDataOfCanonical(canonical))))
  // The world graph: its four snapshots each from its own inputs, then merged.
  const placesSnapshot = step(cache, 'placesSnapshot', [canonical.places, places, options.now],
    () => placesWorldGraph(canonical.places.map((place) => placeInputOf(place, places)), options.now))
  const travelSnapshot = step(cache, 'travelSnapshot', [travelAtlas.countries, travelAtlas.cities, travelAtlas.journeyDays, travelAtlas.routes, options.now],
    () => travelWorldGraph({ countries: travelAtlas.countries, cities: travelAtlas.cities, journeyDays: travelAtlas.journeyDays, routes: travelAtlas.routes }, options.now))
  const wantToGoSnapshot = step(cache, 'wantToGoSnapshot', [canonical.wantToGo.items], () => wantToGoWorldGraph(canonical.wantToGo.items))
  const plannedSnapshot = step(cache, 'plannedSnapshot', [canonical.travel.records],
    () => plannedWorldGraph(canonical.travel.records.filter((record) => record.status === 'planned').map(plannedRecordInputOf)))
  const worldGraph = step(cache, 'worldGraph', [placesSnapshot, travelSnapshot, wantToGoSnapshot, plannedSnapshot],
    () => mergeWorldGraph({ placesSnapshot, travelSnapshot, wantToGoSnapshot, plannedSnapshot }))

  return {
    travelAtlas: step(cache, 'travelAtlasSection', [canonical.travel.source, travelAtlas], () => ({ travelAtlasDataSource: canonical.travel.source, ...travelAtlas })),
    editorState: step(cache, 'editorStateSection', [editorState], () => ({ travelAtlasEditorState: editorState, orderBySavedIds })),
    mediaCatalog: step(cache, 'mediaCatalogSection', [mediaCatalog], () => ({ getMediaSource, ...mediaCatalog })),
    droneMedia,
    wantToGo: step(cache, 'wantToGoSection', [canonical.wantToGo.source, wantToGo], () => ({ wantToGoDataSource: canonical.wantToGo.source, ...wantToGo })),
    worldGraph: step(cache, 'worldGraphSection', [options.now, worldGraph], () => ({ worldGraphSessionNow: options.now, ...worldGraph })),
  }
}
