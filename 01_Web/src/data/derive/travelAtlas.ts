/**
 * 足迹（travel-map）的纯派生（RFC-LOC-1 PR1）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * 这里的逻辑原样搬自 `src/data/travelAtlas.ts`，包括看起来可以简化或像有问题的地方——
 * PR2 要证明派生结果与 PR1 基线逐字节相同，所以本 PR 只搬不改。「读哪份数据」
 * （私有文件还是样例、?data=sample、VITE_TRAVEL_ATLAS_DATA_MODE）仍留在原文件。
 *
 * 【旧键规则】`slugify`、`getJourneyId`、`countryKeyForRecord`、`cityKeyForRecord`
 * 是 RFC-LOC-1 §1.1 所列「按名字推导身份的旧规则」，在 PR5 删除；新代码不得引用。
 * eslint 限制它们只能在 `src/data/derive/**` 内部使用（PR2 的 Legacy Adapter 届时加入白名单）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { getCityCoordinate, getCountryCoordinate } from '../geoCoordinates.ts'
import { orderBySavedIds, type TravelAtlasEditorState } from './editorState.ts'
import type { City, CityId, Country, CountryId, JourneyDay, Route, TravelMapRecord, TravelRecordCategory } from '../../types/travel.ts'

export type TravelMapExport = {
  schema_version: number
  generated_at: string
  privacy_level?: string
  intended_use?: string
  safety_notes?: string[]
  display?: TravelMapDisplay
  records: TravelMapRecord[]
}

export type CountryAlias = {
  country: string
  country_en: string
  regionSuffix?: string
}

export type JourneyRule = {
  includes: string[]
  id: string
}

export type TravelMapDisplay = {
  overviewTarget?: { lat: number; lng: number }
  hiddenCountries?: string[]
  originCountries?: string[]
  regionMatchers?: string[]
  hiddenCityNames?: string[]
  countryAliases?: Record<string, CountryAlias>
  countryCodes?: Record<string, string>
  journeyRules?: JourneyRule[]
}

/** 私有 travel-map 是否可用（有 records 数组）。原文件据此在私有文件与样例之间选择。 */
export const isTravelMapExport = (value: unknown): value is TravelMapExport => {
  if (!value || typeof value !== 'object') return false
  return Array.isArray((value as Partial<TravelMapExport>).records)
}

export const normalizeRecordCountry = (record: TravelMapRecord, display: TravelMapDisplay): TravelMapRecord => {
  const alias = display.countryAliases?.[record.country_en]
  if (!alias) return record

  return {
    ...record,
    country: alias.country,
    country_en: alias.country_en,
    region: alias.regionSuffix
      ? [record.region, alias.regionSuffix].filter(Boolean).join(' / ')
      : record.region,
  }
}

export const homeVisibleCategories = new Set<TravelRecordCategory>(['destination', 'dayTrip', 'region'])

export const classifyRecord = (record: TravelMapRecord, display: TravelMapDisplay): TravelRecordCategory => {
  const hiddenCountries = new Set(display.hiddenCountries ?? [])
  const originCountries = new Set(display.originCountries ?? [])
  const regionMatchers = display.regionMatchers ?? []

  if (record.travelCategory) return record.travelCategory
  if (regionMatchers.some((matcher) => record.country_en === matcher || record.region?.includes(matcher))) return 'region'
  if (hiddenCountries.has(record.country_en)) {
    return originCountries.has(record.country_en) ? 'origin' : 'transit'
  }
  if (record.type === 'daytrip') return 'dayTrip'
  return 'destination'
}

const withDisplayCategory = (record: TravelMapRecord, display: TravelMapDisplay): TravelMapRecord => {
  const travelCategory = classifyRecord(record, display)
  const journeyId = getJourneyId(record, display)

  return {
    ...record,
    journeyId,
    travelCategory,
    hiddenFromHome: typeof record.hiddenFromHome === 'boolean'
      ? record.hiddenFromHome
      : !homeVisibleCategories.has(travelCategory),
  }
}

export function getJourneyId(record: TravelMapRecord, display: TravelMapDisplay) {
  if (record.journeyId) return record.journeyId
  const title = record.trip_title ?? ''
  const matchedRule = display.journeyRules?.find((rule) =>
    rule.includes.some((keyword) => title.includes(keyword)),
  )
  if (matchedRule) return matchedRule.id

  return slugify(title || `${record.country_en}-${record.year ?? 'unknown'}`)
}

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')

export const countryKeyForRecord = (record: TravelMapRecord) =>
  slugify(record.country_en || record.country || 'unknown-country')

export const cityKeyForRecord = (record: TravelMapRecord) =>
  `${countryKeyForRecord(record)}__${slugify(record.city_en || record.city || record.id)}`

export const formatDateRange = (items: TravelMapRecord[]) => {
  const dates = items
    .flatMap((item) => [item.start_date, item.end_date])
    .filter((date): date is string => Boolean(date))
    .sort()

  if (dates.length === 0) return 'Date unknown'

  const first = dates[0] ?? 'Date unknown'
  const last = dates[dates.length - 1] ?? first
  return first === last ? first : `${first} - ${last}`
}

export const unique = <T,>(items: T[]) => [...new Set(items)]

export const hasCoordinates = (item: { lat: number | null; lng: number | null }) =>
  typeof item.lat === 'number' && typeof item.lng === 'number'

export const coordinateForRecord = (record: TravelMapRecord) => {
  if (hasCoordinates(record)) return { lat: record.lat, lng: record.lng, approximate: false }

  return (
    getCityCoordinate(record.city_en || record.city) ??
    getCityCoordinate(record.city) ??
    getCountryCoordinate(record.country_en || record.country)
  )
}

export const countryAccent = (index: number) => {
  const accents = [
    '#66c7a8',
    '#f28b82',
    '#7dd3fc',
    '#8ecae6',
    '#c77dff',
    '#ffb703',
    '#b8c0ff',
    '#80ed99',
    '#57cc99',
    '#48cae4',
    '#e9c46a',
    '#d8b26e',
    '#f0d7a3',
    '#f07f5f',
    '#76a9d8',
    '#a7c957',
    '#90dbf4',
    '#ffafcc',
    '#bde0fe',
  ]
  return accents[index % accents.length]
}

export const flagEmojiForCode = (code?: string) =>
  code?.length === 2
    ? [...code.toUpperCase()].map((character) => String.fromCodePoint(127397 + character.charCodeAt(0))).join('')
    : undefined

/**
 * 选好的 travel-map（私有或样例）+ 解析后的 editor-state → `travelAtlas.ts` 今天的全部派生导出
 * （`travelAtlasDataSource` 除外：它是「选了哪份数据」的结果，由调用方给出）。
 */
export const deriveTravelAtlas = (exportData: TravelMapExport, editorState: TravelAtlasEditorState) => {
  const display = exportData.display ?? {}

  const travelAtlasDisplay = {
    overviewTarget: display.overviewTarget ?? { lat: 20, lng: 0 },
  }

  const hiddenCityNames = new Set(display.hiddenCityNames ?? [])

  const rawRecords = exportData.records.filter((record) => record.status !== 'planned')

  // FR-TA-5：上面那条 `planned` 过滤【保持不变】。planned 记录由
  // src/worldgraph/adapters/plannedRecords.ts 消费（FR-WTG-7），所以这里额外导出
  // 未经过滤的原始 planned 记录与国家代码表，供调用方传给那个纯函数 Adapter。
  // Core 不能 import 本文件，因此这两份数据只能由调用方以参数传入。
  // planned 记录与 rawRecords 走同一道国家别名归一：否则 country_en 仍是别名前的写法，
  // 在 display.countryCodes 里查不到代码，planned 条目就没有 countryCode 可用。
  const plannedRecords: TravelMapRecord[] = exportData.records
    .filter((record) => record.status === 'planned')
    .map((record) => normalizeRecordCountry(record, display))
  const travelAtlasCountryCodes: Record<string, string> = display.countryCodes ?? {}

  const allRecords = rawRecords
    .map((record) => normalizeRecordCountry(record, display))
    .map((record) => withDisplayCategory(record, display))
  const hiddenEditorCountryIds = new Set(editorState.hiddenCountryIds)
  const hiddenEditorCityIds = new Set(editorState.hiddenCityIds)
  const records = allRecords.filter((record) => (
    !record.hiddenFromHome
    && !hiddenEditorCountryIds.has(countryKeyForRecord(record))
    && !hiddenEditorCityIds.has(cityKeyForRecord(record))
  ))

  const recordsByCountry = records.reduce(
    (acc, record) => {
      const countryId = countryKeyForRecord(record)
      acc[countryId] = [...(acc[countryId] ?? []), record]
      return acc
    },
    {} as Record<CountryId, TravelMapRecord[]>,
  )

  const recordsByCity = records.reduce(
    (acc, record) => {
      const cityId = cityKeyForRecord(record)
      acc[cityId] = [...(acc[cityId] ?? []), record]
      return acc
    },
    {} as Record<CityId, TravelMapRecord[]>,
  )

  const travelAtlasMeta = {
    schemaVersion: exportData.schema_version,
    generatedAt: exportData.generated_at,
    privacyLevel: exportData.privacy_level,
    intendedUse: exportData.intended_use,
    totalRecords: records.length,
    importedRecords: allRecords.length,
    hiddenHomeRecords: allRecords.length - records.length,
    recordsWithCoordinates: records.filter((record) => Boolean(coordinateForRecord(record))).length,
    recordsMissingCoordinates: records.filter((record) => !coordinateForRecord(record)).length,
  }

  const hiddenHomeRecords = allRecords.filter((record) => record.hiddenFromHome)

  const recordCountries: Country[] = Object.entries(recordsByCountry).map(([countryId, countryRecords], index) => {
    const first = countryRecords[0]
    const countryCoordinate = getCountryCoordinate(first.country_en || first.country)
    const coordinateRecords = countryRecords
      .map(coordinateForRecord)
      .filter((coordinate): coordinate is { lat: number; lng: number; approximate?: boolean } => Boolean(coordinate))
    const centerLat = countryCoordinate?.lat ?? (
      coordinateRecords.length > 0
        ? coordinateRecords.reduce((sum, coordinate) => sum + coordinate.lat, 0) / coordinateRecords.length
        : null
    )
    const centerLng = countryCoordinate?.lng ?? (
      coordinateRecords.length > 0
        ? coordinateRecords.reduce((sum, coordinate) => sum + coordinate.lng, 0) / coordinateRecords.length
        : null
    )
    const cityIds = unique(countryRecords.map(cityKeyForRecord))
    const cityNames = unique(countryRecords.map((record) => record.city_en || record.city)).filter(Boolean)
    const tripTitles = unique(countryRecords.map((record) => record.trip_title).filter((title): title is string => Boolean(title)))
    const flagCode = first.country_code?.toLowerCase()
      ?? display.countryCodes?.[first.country_en || first.country]?.toLowerCase()

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

  const cities: City[] = Object.entries(recordsByCity).map(([cityId, cityRecords]) => {
    const first = cityRecords[0]
    const coordinate = cityRecords.map(coordinateForRecord).find(Boolean)
    const tripTitles = unique(cityRecords.map((record) => record.trip_title).filter((title): title is string => Boolean(title)))
    const dateRange = formatDateRange(cityRecords)

    return {
      id: cityId,
      nameZh: first.city,
      nameEn: first.city_en || first.city,
      countryId: countryKeyForRecord(first),
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

  const journeyDays: JourneyDay[] = records.map((record) => ({
    id: record.id,
    date: record.start_date,
    countryId: countryKeyForRecord(record),
    cityId: cityKeyForRecord(record),
    title: record.trip_title || `${record.city_en || record.city} visit`,
    journeyId: record.journeyId,
    summary: record.end_date && record.end_date !== record.start_date
      ? `${record.city_en || record.city}, ${record.start_date} - ${record.end_date}`
      : `${record.city_en || record.city}, ${record.start_date}`,
    isHighlight: Boolean(record.notes),
  }))

  const recordsByJourney = records.reduce(
    (acc, record) => {
      const journeyId = record.journeyId ?? 'unknown-journey'
      acc[journeyId] = [...(acc[journeyId] ?? []), record]
      return acc
    },
    {} as Record<string, TravelMapRecord[]>,
  )

  const routes: Route[] = Object.entries(recordsByJourney).flatMap(([journeyId, journeyRecords]) => {
    const ordered = [...journeyRecords].sort((a, b) =>
      `${a.start_date}-${a.id}`.localeCompare(`${b.start_date}-${b.id}`),
    )

    return ordered.slice(1).flatMap((record, index) => {
      const previous = ordered[index]
      const fromCityId = cityKeyForRecord(previous)
      const toCityId = cityKeyForRecord(record)
      if (fromCityId === toCityId) return []

      return [{
        id: `${journeyId}__${previous.id}__${record.id}`,
        fromCityId,
        toCityId,
        journeyId,
        type: previous.country_en === record.country_en ? 'main' : 'flight',
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

  const shouldHideCityFromNavigation = (city: City) =>
    hiddenCityNames.has(city.nameEn ?? '') || hiddenCityNames.has(city.nameZh ?? '')

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

export type TravelAtlasDerived = ReturnType<typeof deriveTravelAtlas>
