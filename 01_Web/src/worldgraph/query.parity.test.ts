/**
 * 对等测试：证明"快照 → queryVisiblePlaces"与"领域对象 → PR3 之前的 Globe 逻辑"
 * 在样例数据上产出【完全相同】的城市列表、访问计数、路线段与标记主色（AC-1 零回归）。
 *
 * 做法：把 PR3 之前 `src/components/CesiumAtlasGlobe.tsx` 里三个 useMemo 的逻辑
 * 逐字复制成本文件内的三个纯函数（参数就是它们原来闭包引用的模块级变量），
 * 去掉 `createRoutePositions` 那一项（Cesium 相关，不在对比范围）。
 * 这些 legacy 函数【只存在于本测试文件里】，不进生产代码——它们是"旧行为"的活化石，
 * 一旦 query.ts 改变行为，这里就会变红。
 *
 * fixture 与 adapters/travel.test.ts 共用 adapters/travel.fixture.ts，
 * 那边有一个测试把 fixture 逐字段钉回 tracked 的 travel-map.sample.json。
 *
 * 下面这行 reference 不能删，理由同 adapters/travel.test.ts：
 * tsconfig.app.json 的 types 是 ["vite/client"]，不含 "node"。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { City, CityId, Country, CountryId, JourneyDay, Route, TravelMapRecord } from '../types/travel.ts'
import {
  JOURNEY_ID,
  sampleCities,
  sampleCountries,
  sampleInput,
  sampleJourneyDays,
  sampleRoutes,
} from './adapters/travel.fixture.ts'
import { travelToWorldGraph } from './adapters/travel.ts'
import { queryVisiblePlaces } from './query.ts'

const NOW = '2026-09-20T00:00:00.000Z'

// ---------------------------------------------------------------------------
// PR3 之前的 Globe 逻辑（逐字复制，只把闭包变量改成参数）
// ---------------------------------------------------------------------------

/** CesiumAtlasGlobe.tsx 的 `type MappedCity = City & { lat: number; lng: number }`。 */
type MappedCity = City & {
  lat: number
  lng: number
}

/** 原 `mappedCities` useMemo（闭包引用模块级 `cities`）。 */
const legacyMappedCities = (cities: City[]): MappedCity[] =>
  cities.filter(
    (city): city is MappedCity =>
      typeof city.lat === 'number' && typeof city.lng === 'number',
  )

/** 原 `journeyVisitCounts` useMemo（闭包引用模块级 `journeyDays`）。 */
const legacyVisitCounts = (journeyDays: JourneyDay[]): Record<CityId, number> =>
  journeyDays.reduce(
    (counts, day) => {
      counts[day.cityId] = (counts[day.cityId] ?? 0) + 1
      return counts
    },
    {} as Record<CityId, number>,
  )

/**
 * 原 `mappedRoutes` useMemo（闭包引用模块级 `countries` / `cityById` / `routes`），
 * 去掉 `positions: createRoutePositions(...)` 一项。
 * `cityById` 的构造逐字来自 travelAtlas.ts，这样四个输入都是领域对象，不必从生产代码里借。
 */
const legacyMappedRoutes = (countries: Country[], cities: City[], routes: Route[]) => {
  const cityById = cities.reduce(
    (acc, city) => {
      acc[city.id] = city
      return acc
    },
    {} as Record<CityId, City>,
  )

  const orderedCountryRoutes = countries.flatMap((country) =>
    country.cityIds.slice(1).flatMap((toCityId, index) => {
      const fromCityId = country.cityIds[index]
      const from = cityById[fromCityId]
      const to = cityById[toCityId]

      if (!from || !to) return []

      const existingRoute = routes.find(
        (route) =>
          route.fromCityId === fromCityId &&
          route.toCityId === toCityId,
      )
      const fromJourneyIds = new Set(
        from.records?.map((record) => record.journeyId).filter(Boolean),
      )
      const sharedJourneyId = to.records
        ?.map((record) => record.journeyId)
        .find((journeyId) => journeyId && fromJourneyIds.has(journeyId))

      return [{
        id: existingRoute?.id ?? `country-order__${country.id}__${fromCityId}__${toCityId}`,
        fromCityId,
        toCityId,
        journeyId: existingRoute?.journeyId ?? sharedJourneyId,
        type: existingRoute?.type ?? 'main' as const,
      }]
    }),
  )
  const crossCountryRoutes = routes.filter((route) => {
    const from = cityById[route.fromCityId]
    const to = cityById[route.toCityId]
    return from?.countryId && to?.countryId && from.countryId !== to.countryId
  })

  return [...orderedCountryRoutes, ...crossCountryRoutes].flatMap((route) => {
    const from = cityById[route.fromCityId]
    const to = cityById[route.toCityId]

    if (
      !route.journeyId ||
      !from ||
      !to ||
      typeof from.lat !== 'number' ||
      typeof from.lng !== 'number' ||
      typeof to.lat !== 'number' ||
      typeof to.lng !== 'number'
    ) {
      return []
    }

    return [{
      ...route,
      fromLat: from.lat,
      fromLng: from.lng,
      toLat: to.lat,
      toLng: to.lng,
      fromCountryId: from.countryId,
      toCountryId: to.countryId,
    }]
  })
}

/** 原 Globe 第 1801 行：`countryById[city.countryId]?.accent ?? '#38bdf8'`。 */
const legacyCountryById = (countries: Country[]): Record<CountryId, Country> =>
  countries.reduce(
    (acc, country) => {
      acc[country.id] = country
      return acc
    },
    {} as Record<CountryId, Country>,
  )

// ---------------------------------------------------------------------------
// 投影：把两边压成同一个形状再 deepEqual
// ---------------------------------------------------------------------------

const legacyCityShape = (cities: MappedCity[]) =>
  cities.map((city) => ({
    id: city.id,
    countryId: city.countryId,
    lat: city.lat,
    lng: city.lng,
    nameZh: city.nameZh,
    nameEn: city.nameEn,
  }))

const queryCityShape = (places: ReturnType<typeof queryVisiblePlaces>['places']) =>
  places.map((place) => ({
    id: place.sourceId,
    countryId: place.countryId,
    lat: place.lat,
    lng: place.lng,
    nameZh: place.title.zh,
    nameEn: place.title.en,
  }))

const legacyRouteShape = (routes: ReturnType<typeof legacyMappedRoutes>) =>
  routes.map((route) => ({
    id: route.id,
    fromCityId: route.fromCityId,
    toCityId: route.toCityId,
    journeyId: route.journeyId,
    type: route.type,
    fromLat: route.fromLat,
    fromLng: route.fromLng,
    toLat: route.toLat,
    toLng: route.toLng,
    fromCountryId: route.fromCountryId,
    toCountryId: route.toCountryId,
  }))

const queryRouteShape = (routes: ReturnType<typeof queryVisiblePlaces>['routes']) =>
  routes.map((route) => ({
    id: route.id,
    fromCityId: route.fromSourceId,
    toCityId: route.toSourceId,
    journeyId: route.journeyId,
    type: route.kind,
    fromLat: route.fromLat,
    fromLng: route.fromLng,
    toLat: route.toLat,
    toLng: route.toLng,
    fromCountryId: route.fromCountryId,
    toCountryId: route.toCountryId,
  }))

const querySnapshot = (input: ReturnType<typeof sampleInput>) =>
  queryVisiblePlaces(travelToWorldGraph(input, { now: NOW }), ['travel'])

// ---------------------------------------------------------------------------
// 1. 样例数据：城市 / 访问计数 / 路线 / 主色 四项全等
// ---------------------------------------------------------------------------

test('对等：places 与 legacy mappedCities 的投影逐条相同（含顺序）', () => {
  const input = sampleInput()
  const legacy = legacyCityShape(legacyMappedCities(input.cities))
  const actual = queryCityShape(querySnapshot(sampleInput()).places)

  assert.equal(legacy.length, 5, '样例上 N 应为 5；这里变了说明 fixture 变了')
  assert.deepEqual(actual, legacy)
})

test('对等：visitCount 与 legacy journeyVisitCounts 对齐（0 按 Globe 的显示语义记为 1）', () => {
  const input = sampleInput()
  const legacyCounts = legacyVisitCounts(input.journeyDays)
  const places = querySnapshot(sampleInput()).places

  // Globe 用的是 `journeyVisitCounts[city.id] ?? 1`：没有记录的城市显示 1。
  // PR3 之后是 `city.visitCount || 1`，语义相同，所以这里把 query 的 0 映射成 1 再比。
  const actual = places.map((place) => place.visitCount || 1)
  const expected = places.map((place) => legacyCounts[place.sourceId] ?? 1)

  assert.deepEqual(actual, expected)
  assert.deepEqual(expected, [1, 1, 1, 1, 1], '样例里每个城市恰好一条记录')
})

test('对等：routes 与 legacy mappedRoutes（去掉 positions）逐条相同（含顺序）', () => {
  const input = sampleInput()
  const legacy = legacyRouteShape(legacyMappedRoutes(input.countries, input.cities, input.routes))
  const actual = queryRouteShape(querySnapshot(sampleInput()).routes)

  assert.equal(legacy.length, 4, '样例上 M 应为 4；这里变了说明 fixture 变了')
  assert.deepEqual(actual, legacy)
})

test('对等：每个 place 的 accent 等于 countryById[countryId].accent', () => {
  const input = sampleInput()
  const countryById = legacyCountryById(input.countries)
  const places = querySnapshot(sampleInput()).places

  assert.ok(places.length > 0)
  for (const place of places) {
    const country = place.countryId ? countryById[place.countryId] : undefined
    assert.equal(place.accent, country?.accent, `${place.sourceId} 的 accent 与国家不一致`)
    // Globe 的兜底色也必须一致：两边都会落到同一个 '#38bdf8'。
    assert.equal(place.accent ?? '#38bdf8', country?.accent ?? '#38bdf8')
  }
})

test('对等：样例上的 N / M 与状态药丸一致', () => {
  const result = querySnapshot(sampleInput())
  assert.equal(result.places.length, 5, 'N = mapped cities')
  assert.equal(result.routes.length, 4, 'M = journey route segments')
})

// ---------------------------------------------------------------------------
// 2. sharedJourneyId 分支：fixture 没有 records，单独造一份带 records 的输入
// ---------------------------------------------------------------------------

/**
 * travel-map.sample.json 派生出来的 City 在 travelAtlas.ts 里是带 `records` 的
 * （travelAtlas.ts:`records: cityRecords`），但 fixture 为了钉住 JSON 只保留了展示字段。
 * legacy 的 `sharedJourneyId` 正是从 `city.records[].journeyId` 求交集而来，
 * query.ts 则改从 visited Relation 指向的 journey Entity 的 metadata.journeyId 求交集。
 * 这一分支在 fixture 上永远走不到（`existingRoute` 总能命中），所以这里单独造一份
 * 带 records、但【没有任何 Route】的输入，把两种推断方式正面对上。
 */
const withRecords = (cities: City[], journeyDays: JourneyDay[]): City[] =>
  cities.map((city) => ({
    ...city,
    records: journeyDays
      .filter((day) => day.cityId === city.id)
      .map((day): TravelMapRecord => ({
        id: day.id,
        country: city.countryId ?? '',
        country_en: city.countryId ?? '',
        city: city.nameZh ?? '',
        city_en: city.nameEn ?? '',
        start_date: day.date,
        lat: city.lat,
        lng: city.lng,
        journeyId: day.journeyId,
      })),
  }))

test('对等：没有 Route 时，两边都靠"两端共享的 journeyId"补出国家内顺序段', () => {
  const countries = sampleCountries()
  const journeyDays = sampleJourneyDays()
  const cities = withRecords(sampleCities(), journeyDays)

  const legacy = legacyRouteShape(legacyMappedRoutes(countries, cities, []))
  const actual = queryRouteShape(
    queryVisiblePlaces(
      travelToWorldGraph({ countries, cities, journeyDays, routes: [] }, { now: NOW }),
      ['travel'],
    ).routes,
  )

  assert.deepEqual(
    legacy.map((route) => route.id),
    [
      'country-order__iceland__iceland__reykjavik__iceland__vik',
      'country-order__iceland__iceland__vik__iceland__akureyri',
      'country-order__faroe-islands__faroe-islands__torshavn__faroe-islands__gjogv',
    ],
    'legacy 必须真的走到 sharedJourneyId 分支，否则这个测试没有意义',
  )
  assert.ok(legacy.every((route) => route.journeyId === JOURNEY_ID))
  assert.deepEqual(actual, legacy)
})

test('对等：两端没有共享 journeyId 时，两边都丢弃该段', () => {
  const countries = sampleCountries()
  // 把每一天放进各自独立的 journey，于是任何一对城市都不共享 journeyId。
  const journeyDays = sampleJourneyDays().map((day) => ({ ...day, journeyId: `journey-${day.id}` }))
  const cities = withRecords(sampleCities(), journeyDays)

  const legacy = legacyRouteShape(legacyMappedRoutes(countries, cities, []))
  const actual = queryRouteShape(
    queryVisiblePlaces(
      travelToWorldGraph({ countries, cities, journeyDays, routes: [] }, { now: NOW }),
      ['travel'],
    ).routes,
  )

  assert.deepEqual(legacy, [])
  assert.deepEqual(actual, legacy)
})

// ---------------------------------------------------------------------------
// 3. 图层关掉时的行为（legacy 没有这个概念，单独断言）
// ---------------------------------------------------------------------------

test('travel 关掉时 places 与 routes 都为空，等价于 PR2 的 showTravelLayer = false', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const hidden = queryVisiblePlaces(snapshot, [])
  assert.deepEqual(hidden.places, [])
  assert.deepEqual(hidden.routes, [])

  const shown = queryVisiblePlaces(snapshot, ['travel'])
  assert.equal(shown.places.length, legacyMappedCities(sampleInput().cities).length)
  assert.equal(
    shown.routes.length,
    legacyMappedRoutes(sampleCountries(), sampleCities(), sampleRoutes()).length,
  )
})
