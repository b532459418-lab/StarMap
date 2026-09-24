/**
 * 足迹纯派生（derive/travelAtlas.ts）的单元测试（RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 这些测试钉住的是「今天的行为」，包括看起来可以商榷的地方（PR1 只搬不改）：
 * PR2 的 Legacy Adapter 必须让同样的输入得到同样的输出。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import type { City, Country, TravelMapRecord } from '../../types/travel.ts'
import { cityCoordinates, countryCoordinates } from '../geoCoordinates.ts'
import {
  JOURNEY_ID,
  sampleCities,
  sampleCountries,
  sampleJourneyDays,
  sampleRoutes,
} from '../../worldgraph/adapters/travel.fixture.ts'
import { emptyEditorState, orderBySavedIds, type TravelAtlasEditorState } from './editorState.ts'
import {
  cityKeyForRecord,
  classifyRecord,
  coordinateForRecord,
  countryKeyForRecord,
  deriveTravelAtlas,
  getJourneyId,
  isTravelMapExport,
  normalizeRecordCountry,
  slugify,
  type TravelMapDisplay,
  type TravelMapExport,
} from './travelAtlas.ts'

const sampleTravelMap = (): TravelMapExport =>
  JSON.parse(readFileSync(new URL('../travel-map.sample.json', import.meta.url), 'utf8'))

const editor = (overrides: Partial<TravelAtlasEditorState> = {}): TravelAtlasEditorState => ({
  ...emptyEditorState,
  ...overrides,
})

const record = (overrides: Partial<TravelMapRecord> & { id: string }): TravelMapRecord => ({
  country: '甲国',
  country_en: 'Alpha',
  city: '一城',
  city_en: 'One',
  start_date: '2025-01-01',
  lat: 1,
  lng: 2,
  ...overrides,
})

const travelMap = (records: TravelMapRecord[], display?: TravelMapDisplay): TravelMapExport => ({
  schema_version: 1,
  generated_at: '2026-01-01',
  display,
  records,
})

const withoutRecords = <T extends { records?: unknown }>(items: T[]) =>
  items.map(({ records: _records, ...rest }) => {
    void _records
    return rest
  })

// ---------------------------------------------------------------------------
// 公开样例：钉住今天的输出
// ---------------------------------------------------------------------------

test('公开样例：国家、城市、行程日、路线与 Core 的 travel.fixture 逐字段相同', () => {
  const derived = deriveTravelAtlas(sampleTravelMap(), emptyEditorState)

  assert.deepEqual(withoutRecords(derived.countries), sampleCountries())
  assert.deepEqual(withoutRecords(derived.cities), sampleCities())
  assert.deepEqual(derived.journeyDays, sampleJourneyDays())
  assert.deepEqual(derived.routes, sampleRoutes())
})

test('公开样例：数量、元数据与其余导出', () => {
  const derived = deriveTravelAtlas(sampleTravelMap(), emptyEditorState)

  assert.equal(derived.countries.length, 2)
  assert.equal(derived.cities.length, 5)
  assert.equal(derived.journeyDays.length, 5)
  assert.equal(derived.routes.length, 4)
  assert.deepEqual(derived.countries.map((country) => country.records?.map((item) => item.id)), [
    ['sample_reykjavik', 'sample_vik', 'sample_akureyri'],
    ['sample_torshavn', 'sample_gjogv'],
  ])
  // 每条记录都补上了 journeyId / travelCategory / hiddenFromHome。
  assert.deepEqual(
    derived.cities.flatMap((city) => city.records ?? []).map((item) => [item.id, item.journeyId, item.travelCategory, item.hiddenFromHome]),
    [
      ['sample_reykjavik', JOURNEY_ID, 'destination', false],
      ['sample_vik', JOURNEY_ID, 'dayTrip', false],
      ['sample_akureyri', JOURNEY_ID, 'destination', false],
      ['sample_torshavn', JOURNEY_ID, 'destination', false],
      ['sample_gjogv', JOURNEY_ID, 'dayTrip', false],
    ],
  )
  assert.deepEqual(derived.travelAtlasDisplay, { overviewTarget: { lat: 64, lng: -13 } })
  assert.deepEqual(derived.travelAtlasMeta, {
    schemaVersion: 1,
    generatedAt: '2026-08-12',
    privacyLevel: 'public-sample',
    intendedUse: 'Neutral open-source StarMap demonstration data.',
    totalRecords: 5,
    importedRecords: 5,
    hiddenHomeRecords: 0,
    recordsWithCoordinates: 5,
    recordsMissingCoordinates: 0,
  })
  assert.deepEqual(derived.plannedRecords, [])
  assert.deepEqual(derived.travelAtlasCountryCodes, { Iceland: 'is', 'Faroe Islands': 'fo' })
  assert.deepEqual(derived.hiddenHomeRecords, [])
  assert.deepEqual(derived.missingCoordinateCities, [])
  assert.deepEqual(Object.keys(derived.countryById), ['iceland', 'faroe-islands'])
  assert.deepEqual(Object.keys(derived.cityById), sampleCities().map((city) => city.id))
  assert.deepEqual(derived.getCitiesForCountry('faroe-islands').map((city) => city.id), ['faroe-islands__torshavn', 'faroe-islands__gjogv'])
  assert.deepEqual(derived.getCitiesForCountry('nowhere'), [])
  assert.equal(derived.cities.some(derived.shouldHideCityFromNavigation), false)
})

test('isTravelMapExport 只看 records 是不是数组', () => {
  assert.equal(isTravelMapExport(sampleTravelMap()), true)
  assert.equal(isTravelMapExport({ records: [] }), true)
  assert.equal(isTravelMapExport({ records: {} }), false)
  assert.equal(isTravelMapExport(undefined), false)
  assert.equal(isTravelMapExport(null), false)
  assert.equal(isTravelMapExport('records'), false)
})

// ---------------------------------------------------------------------------
// 国家别名归一
// ---------------------------------------------------------------------------

test('国家别名在推导键之前改写国家名，regionSuffix 追加到 region；planned 记录走同一道归一', () => {
  const display: TravelMapDisplay = {
    countryAliases: { Faroes: { country: '法罗群岛', country_en: 'Faroe Islands', regionSuffix: 'North' } },
    countryCodes: { 'Faroe Islands': 'fo' },
  }
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'r1', country: '法罗', country_en: 'Faroes', city: '克拉克斯维克', city_en: 'Klaksvik', region: 'Atlantic' }),
    record({ id: 'p1', country: '法罗', country_en: 'Faroes', city: '维德', city_en: 'Vidareidi', status: 'planned' }),
  ], display), emptyEditorState)

  assert.deepEqual(derived.cities.map((city) => [city.id, city.countryId, city.keywords]), [
    ['faroe-islands__klaksvik', 'faroe-islands', ['Atlantic / North']],
  ])
  assert.deepEqual(derived.countries.map((country) => [country.id, country.nameZh, country.nameEn, country.flagCode]), [
    ['faroe-islands', '法罗群岛', 'Faroe Islands', 'fo'],
  ])
  assert.deepEqual(derived.plannedRecords.map((item) => [item.id, item.country, item.country_en, item.region]), [
    ['p1', '法罗群岛', 'Faroe Islands', 'North'],
  ])
})

test('normalizeRecordCountry：没有别名时原样返回同一个对象；没有 regionSuffix 时 region 不变', () => {
  const plain = record({ id: 'r1', region: 'Somewhere' })
  assert.equal(normalizeRecordCountry(plain, {}), plain)
  assert.deepEqual(
    normalizeRecordCountry(record({ id: 'r2', country_en: 'Alt', region: 'Somewhere' }), {
      countryAliases: { Alt: { country: '乙国', country_en: 'Beta' } },
    }),
    record({ id: 'r2', country: '乙国', country_en: 'Beta', region: 'Somewhere' }),
  )
})

// ---------------------------------------------------------------------------
// 分类与 hiddenFromHome
// ---------------------------------------------------------------------------

test('classifyRecord：travelCategory > regionMatchers > hiddenCountries（origin / transit）> daytrip > destination', () => {
  const display: TravelMapDisplay = {
    regionMatchers: ['Alps'],
    hiddenCountries: ['Home', 'Hub'],
    originCountries: ['Home'],
  }
  const cases: [TravelMapRecord, string][] = [
    [record({ id: 'a', country_en: 'Home', travelCategory: 'attraction' }), 'attraction'],
    [record({ id: 'b', country_en: 'Swiss', region: 'Central Alps' }), 'region'],
    [record({ id: 'c', country_en: 'Alps' }), 'region'],
    [record({ id: 'd', country_en: 'Home', region: 'Alps trip' }), 'region'],
    [record({ id: 'e', country_en: 'Home' }), 'origin'],
    [record({ id: 'f', country_en: 'Hub', type: 'daytrip' }), 'transit'],
    [record({ id: 'g', country_en: 'Norway', type: 'daytrip' }), 'dayTrip'],
    [record({ id: 'h', country_en: 'Norway', type: 'city' }), 'destination'],
  ]
  for (const [item, expected] of cases) assert.equal(classifyRecord(item, display), expected, item.id)
  // 没有任何 display 规则时只剩 daytrip / destination。
  assert.equal(classifyRecord(record({ id: 'i', country_en: 'Home' }), {}), 'destination')
})

test('hiddenFromHome：首页只显示 destination / dayTrip / region；记录上显式的布尔值优先', () => {
  const display: TravelMapDisplay = { hiddenCountries: ['Home', 'Hub'], originCountries: ['Home'] }
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'origin', country_en: 'Home', country: '家', city_en: 'Base' }),
    record({ id: 'transit', country_en: 'Hub', country: '中转', city_en: 'Gate' }),
    record({ id: 'attraction', travelCategory: 'attraction', city_en: 'Sight' }),
    record({ id: 'forced-visible', country_en: 'Hub', country: '中转', city_en: 'Lounge', hiddenFromHome: false }),
    record({ id: 'forced-hidden', city_en: 'Secret', hiddenFromHome: true }),
    record({ id: 'visible', city_en: 'Plain' }),
  ], display), emptyEditorState)

  assert.deepEqual(derived.hiddenHomeRecords.map((item) => [item.id, item.travelCategory]), [
    ['origin', 'origin'],
    ['transit', 'transit'],
    ['attraction', 'attraction'],
    ['forced-hidden', 'destination'],
  ])
  assert.deepEqual(derived.journeyDays.map((day) => day.id), ['forced-visible', 'visible'])
  assert.deepEqual(
    [derived.travelAtlasMeta.totalRecords, derived.travelAtlasMeta.importedRecords, derived.travelAtlasMeta.hiddenHomeRecords],
    [2, 6, 4],
  )
})

// ---------------------------------------------------------------------------
// 行程分组与 slug 回落
// ---------------------------------------------------------------------------

test('getJourneyId：显式 journeyId > journeyRules 关键词 > slug(trip_title) > slug(country_en-year)', () => {
  const display: TravelMapDisplay = { journeyRules: [{ includes: ['Spring', '春'], id: 'spring-trip' }] }
  assert.equal(getJourneyId(record({ id: 'a', journeyId: 'explicit', trip_title: 'Big Spring Tour' }), display), 'explicit')
  assert.equal(getJourneyId(record({ id: 'b', trip_title: 'Big Spring Tour' }), display), 'spring-trip')
  assert.equal(getJourneyId(record({ id: 'c', trip_title: '2024 春游' }), display), 'spring-trip')
  assert.equal(getJourneyId(record({ id: 'd', trip_title: 'Autumn in Kyoto!' }), display), 'autumn-in-kyoto')
  assert.equal(getJourneyId(record({ id: 'e', country_en: 'Japan', year: 2024 }), display), 'japan-2024')
  assert.equal(getJourneyId(record({ id: 'f', country_en: 'Japan' }), display), 'japan-unknown')
  assert.equal(getJourneyId(record({ id: 'g', trip_title: '', country_en: 'Japan', year: 2023 }), {}), 'japan-2023')
})

test('slugify 与键函数：NFKC、小写、非字母数字折成连字符；城市键回落到中文名再到记录 id', () => {
  assert.equal(slugify('  Ｔｏｋｙｏ  Trip! '), 'tokyo-trip')
  assert.equal(slugify('Tromsø'), 'tromsø')
  assert.equal(slugify('冬 季'), '冬-季')
  assert.equal(countryKeyForRecord(record({ id: 'a', country_en: 'Faroe Islands' })), 'faroe-islands')
  assert.equal(countryKeyForRecord(record({ id: 'b', country_en: '', country: '冰岛' })), '冰岛')
  assert.equal(countryKeyForRecord(record({ id: 'c', country_en: '', country: '' })), 'unknown-country')
  assert.equal(cityKeyForRecord(record({ id: 'd', city_en: 'New York' })), 'alpha__new-york')
  assert.equal(cityKeyForRecord(record({ id: 'e', city_en: '', city: '东京' })), 'alpha__东京')
  assert.equal(cityKeyForRecord(record({ id: 'Rec_9', city_en: '', city: '' })), 'alpha__rec-9')
})

// ---------------------------------------------------------------------------
// 坐标回落
// ---------------------------------------------------------------------------

test('coordinateForRecord 与国家中心：记录坐标 > 城市英文名查表 > 城市名查表 > 国家名查表；国家中心先查表、再取平均', () => {
  // 内置坐标表今天是空的（见 geoCoordinates.ts），这里临时填几条再清掉，只为覆盖回落路径。
  assert.equal(Object.keys(cityCoordinates).length, 0)
  assert.equal(Object.keys(countryCoordinates).length, 0)
  cityCoordinates['lookup city'] = { lat: 10, lng: 20, approximate: true }
  cityCoordinates['alt name'] = { lat: 11, lng: 21, approximate: true }
  countryCoordinates.beta = { lat: 30, lng: 40, approximate: true }
  try {
    const own = record({ id: 'own', country_en: 'Gamma', country: '丙', city_en: 'Lookup City', lat: 5, lng: 6 })
    const byCityEn = record({ id: 'by-city-en', country_en: 'Gamma', country: '丙', city_en: 'Lookup City', lat: null, lng: null })
    const byCity = record({ id: 'by-city', country_en: 'Gamma', country: '丙', city_en: 'Unknown', city: 'Alt Name', lat: null, lng: null })
    const byCountry = record({ id: 'by-country', country_en: 'Beta', country: '乙', city_en: 'Nowhere', lat: null, lng: null })
    const none = record({ id: 'none', country_en: 'Delta', country: '丁', city_en: 'Void', lat: null, lng: null })

    assert.deepEqual(coordinateForRecord(own), { lat: 5, lng: 6, approximate: false })
    assert.deepEqual(coordinateForRecord(byCityEn), { lat: 10, lng: 20, approximate: true })
    assert.deepEqual(coordinateForRecord(byCity), { lat: 11, lng: 21, approximate: true })
    assert.deepEqual(coordinateForRecord(byCountry), { lat: 30, lng: 40, approximate: true })
    assert.equal(coordinateForRecord(none), undefined)

    const derived = deriveTravelAtlas(travelMap([
      byCityEn,
      own,
      byCity,
      record({ id: 'beta-own', country_en: 'Beta', country: '乙', city_en: 'Harbor', lat: 1, lng: 1 }),
      byCountry,
      none,
    ]), emptyEditorState)

    const country = (id: string) => derived.countryById[id] as Country
    // Gamma 不在国家表里：中心 = 各记录（含查表来的近似坐标）的算术平均。
    assert.deepEqual([country('gamma').centerLat, country('gamma').centerLng], [(10 + 5 + 11) / 3, (20 + 6 + 21) / 3])
    // Beta 在国家表里：中心直接取表，不看记录坐标。
    assert.deepEqual([country('beta').centerLat, country('beta').centerLng], [30, 40])
    // Delta 没有任何坐标。
    assert.deepEqual([country('delta').centerLat, country('delta').centerLng, country('delta').missingCoordinates], [null, null, true])

    // 城市坐标 = 该城市各记录按顺序第一个可用坐标（不取平均）。
    const city = (id: string) => derived.cityById[id] as City
    assert.deepEqual([city('gamma__lookup-city').lat, city('gamma__lookup-city').lng], [10, 20])
    assert.deepEqual([city('gamma__unknown').lat, city('gamma__unknown').lng], [11, 21])
    assert.deepEqual([city('beta__nowhere').lat, city('beta__nowhere').lng], [30, 40])
    assert.deepEqual([city('delta__void').lat, city('delta__void').missingCoordinates], [null, true])
    assert.deepEqual(derived.missingCoordinateCities.map((item) => item.id), ['delta__void'])
    assert.deepEqual([derived.travelAtlasMeta.recordsWithCoordinates, derived.travelAtlasMeta.recordsMissingCoordinates], [5, 1])
  } finally {
    delete cityCoordinates['lookup city']
    delete cityCoordinates['alt name']
    delete countryCoordinates.beta
  }
})

// ---------------------------------------------------------------------------
// editor-state：隐藏、独立国家、排序
// ---------------------------------------------------------------------------

test('editor 隐藏的国家 / 城市在记录层被过滤，不进国家、城市、行程日与路线', () => {
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'a1', journeyId: 'j', start_date: '2025-01-01' }),
    record({ id: 'b1', journeyId: 'j', start_date: '2025-01-02', country_en: 'Beta', country: '乙', city_en: 'Two' }),
    record({ id: 'b2', journeyId: 'j', start_date: '2025-01-03', country_en: 'Beta', country: '乙', city_en: 'Three' }),
  ]), editor({ hiddenCountryIds: ['alpha'], hiddenCityIds: ['beta__two'] }))

  assert.deepEqual(derived.countries.map((country) => country.id), ['beta'])
  assert.deepEqual(derived.cities.map((city) => city.id), ['beta__three'])
  assert.deepEqual(derived.journeyDays.map((day) => day.id), ['b2'])
  assert.deepEqual(derived.routes, [])
  // 元数据的 hiddenHomeRecords 把 editor 隐藏的也算进去（= 导入数 - 显示数），而导出的 hiddenHomeRecords 列表只含首页隐藏的。
  assert.equal(derived.travelAtlasMeta.hiddenHomeRecords, 2)
  assert.deepEqual(derived.hiddenHomeRecords, [])
})

test('addedCountries：没有记录、也没被隐藏的国家追加在记录国家之后，配色序号接着排', () => {
  const added = (id: string, countryCode: string, extra: Partial<TravelAtlasEditorState['addedCountries'][number]> = {}) => ({
    id,
    nameZh: `${id}中文`,
    nameEn: id,
    countryCode,
    centerLat: 1,
    centerLng: 2,
    ...extra,
  })
  const derived = deriveTravelAtlas(travelMap([record({ id: 'a1' })]), editor({
    addedCountries: [
      added('alpha', 'AL'),
      added('zeta', 'ZE', { region: 'Somewhere', visitedDate: '2024-05' }),
      added('hidden-land', 'HL'),
      added('omega', 'OM'),
    ],
    hiddenCountryIds: ['hidden-land'],
  }))

  assert.deepEqual(derived.countries.map((country) => [country.id, country.accent, country.flagCode, country.flag]), [
    ['alpha', '#66c7a8', undefined, undefined],
    ['zeta', '#f28b82', 'ze', '🇿🇪'],
    ['omega', '#7dd3fc', 'om', '🇴🇲'],
  ])
  assert.deepEqual(derived.countryById.zeta, {
    id: 'zeta',
    nameZh: 'zeta中文',
    nameEn: 'zeta',
    centerLat: 1,
    centerLng: 2,
    visitedDateRange: '2024-05',
    summary: 'Country added locally. Add the first city from City Cards when ready.',
    memory: 'Awaiting the first city record.',
    keywords: ['Somewhere'],
    cityIds: [],
    accent: '#f28b82',
    flag: '🇿🇪',
    flagCode: 'ze',
    missingCoordinates: false,
    records: [],
  })
  assert.equal(derived.countryById.omega.visitedDateRange, 'Date unknown')
  assert.deepEqual(derived.getCitiesForCountry('omega'), [])
})

test('countryOrder / cityOrderByCountry 经 orderBySavedIds 排序；没列出的排在后面并保持原顺序', () => {
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'a1', city_en: 'One' }),
    record({ id: 'a2', city_en: 'Two' }),
    record({ id: 'a3', city_en: 'Three' }),
    record({ id: 'b1', country_en: 'Beta', country: '乙', city_en: 'Four' }),
    record({ id: 'c1', country_en: 'Gamma', country: '丙', city_en: 'Five' }),
  ]), editor({
    countryOrder: ['gamma', 'alpha'],
    cityOrderByCountry: { alpha: ['alpha__three'] },
  }))

  assert.deepEqual(derived.countries.map((country) => country.id), ['gamma', 'alpha', 'beta'])
  assert.deepEqual(derived.countryById.alpha.cityIds, ['alpha__three', 'alpha__one', 'alpha__two'])
  // cities 本身按记录首次出现的顺序，不受 editor 排序影响。
  assert.deepEqual(derived.cities.map((city) => city.id), ['alpha__one', 'alpha__two', 'alpha__three', 'beta__four', 'gamma__five'])
  // 配色按记录国家首次出现的顺序分配，排序之后不变。
  assert.deepEqual(derived.countries.map((country) => country.accent), ['#7dd3fc', '#66c7a8', '#f28b82'])
})

test('orderBySavedIds：空顺序返回同一个数组；已列出的按名次，未列出的放后面且相对顺序不变', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  assert.equal(orderBySavedIds(items), items)
  assert.equal(orderBySavedIds(items, []), items)
  const ordered = orderBySavedIds(items, ['c', 'x', 'a'])
  assert.deepEqual(ordered.map((item) => item.id), ['c', 'a', 'b', 'd'])
  assert.notEqual(ordered, items)
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c', 'd'])
})

// ---------------------------------------------------------------------------
// 路线与导航隐藏
// ---------------------------------------------------------------------------

test('路线：同一行程按 start_date-id 排序后相邻两城成段；同城不成段；同国 main、跨国 flight', () => {
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'b1', journeyId: 'j', start_date: '2025-01-04', country_en: 'Beta', country: '乙', city_en: 'Three' }),
    record({ id: 'a1', journeyId: 'j', start_date: '2025-01-01', city_en: 'One' }),
    record({ id: 'a2', journeyId: 'j', start_date: '2025-01-02', city_en: 'One' }),
    record({ id: 'a3', journeyId: 'j', start_date: '2025-01-03', city_en: 'Two' }),
    record({ id: 'solo', journeyId: 'k', start_date: '2025-02-01', city_en: 'Two' }),
  ]), emptyEditorState)

  assert.deepEqual(derived.routes, [
    { id: 'j__a2__a3', fromCityId: 'alpha__one', toCityId: 'alpha__two', journeyId: 'j', type: 'main' },
    { id: 'j__a3__b1', fromCityId: 'alpha__two', toCityId: 'beta__three', journeyId: 'j', type: 'flight' },
  ])
  assert.deepEqual(derived.journeyDays.map((day) => [day.id, day.cityId, day.journeyId]), [
    ['b1', 'beta__three', 'j'],
    ['a1', 'alpha__one', 'j'],
    ['a2', 'alpha__one', 'j'],
    ['a3', 'alpha__two', 'j'],
    ['solo', 'alpha__two', 'k'],
  ])
})

test('行程日与城市的文案字段', () => {
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'a1', start_date: '2025-01-01', end_date: '2025-01-03', trip_title: 'Winter', notes: 'note' }),
    record({ id: 'a2', start_date: '2025-02-01', end_date: '2025-02-01', city_en: 'Two' }),
  ]), emptyEditorState)

  assert.deepEqual(derived.journeyDays.map((day) => [day.title, day.summary, day.isHighlight]), [
    ['Winter', 'One, 2025-01-01 - 2025-01-03', true],
    ['Two visit', 'Two, 2025-02-01', false],
  ])
  assert.deepEqual(derived.cities.map((city) => [city.summary, city.memory, city.visitedDateRange]), [
    ['Winter', 'note', '2025-01-01 - 2025-01-03'],
    ['Visited on 2025-02-01.', undefined, '2025-02-01'],
  ])
})

test('shouldHideCityFromNavigation 按城市英文名或中文名匹配 display.hiddenCityNames', () => {
  const derived = deriveTravelAtlas(travelMap([
    record({ id: 'a1', city_en: 'One', city: '一城' }),
    record({ id: 'a2', city_en: 'Two', city: '二城' }),
    record({ id: 'a3', city_en: 'Three', city: '三城' }),
  ], { hiddenCityNames: ['One', '二城'] }), emptyEditorState)

  assert.deepEqual(derived.cities.map((city) => derived.shouldHideCityFromNavigation(city)), [true, true, false])
  // 隐藏只影响导航，城市仍在 cities 里。
  assert.equal(derived.cities.length, 3)
})
