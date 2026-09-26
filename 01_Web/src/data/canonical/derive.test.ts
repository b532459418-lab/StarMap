/**
 * Canonical 派生（canonical/derive.ts）的单元测试（RFC-LOC-1 PR2 规格 §2.1、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 三条路径（见 ./legacy.fixture.ts）：
 *   A = PR1 的 deriveAppData(原始数据)
 *   B = PR1 的 deriveAppData(normalizeLegacy(原始数据))
 *   C = deriveAppDataFromCanonical(legacyAdapter(原始数据))
 * - 公开样例：C ≡ A（字节），且等于 PR1 公布的基线哈希；
 * - 下面每个 fixture：B ≡ C（字节），没有任何条件；
 * - 没有不一致的 fixture 另外 A ≡ C。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { deriveAppData, type RawAppInputs } from '../derive/appData.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import {
  NOW,
  SAMPLE_BASELINE_SHA256,
  baselineText,
  consistentPersonalRaw,
  nameInconsistencyRaw,
  pathA,
  rawInputs,
  record,
  sampleRaw,
  sampleTravelMap,
} from './legacy.fixture.ts'
import { normalizeLegacy } from './normalizeLegacy.ts'

/** B：旧路径跑 normalizeLegacy(原始数据)。 */
const pathB = (raw: RawAppInputs) => baselineText(deriveAppData(normalizeLegacy(raw).normalized))

/** C：新路径跑原始数据。 */
const pathC = (raw: RawAppInputs) => baselineText(deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW }))

const assertBEqualsC = (raw: RawAppInputs) => {
  const b = pathB(raw)
  const c = pathC(raw)
  assert.ok(b === c, 'B 与 C 不是逐字节相同')
  return c
}

/** 两份基线之间不同的 JSON 路径（只用于断言差异落在哪里）。 */
const diffPaths = (left: unknown, right: unknown, where = '$', out: string[] = []): string[] => {
  if (Object.is(left, right)) return out
  const isObject = (value: unknown) => typeof value === 'object' && value !== null
  if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) {
    out.push(where)
    return out
  }
  const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)])
  for (const key of keys) {
    diffPaths((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${where}.${key}`, out)
  }
  return out
}

const sha256 = (text: string) => createHash('sha256').update(`${text}\n`).digest('hex')

// ---------------------------------------------------------------------------
// 公开样例：C ≡ A
// ---------------------------------------------------------------------------

test('公开样例：C 与 A 逐字节相同，等于 PR1 公布的基线', () => {
  const a = pathA(sampleRaw())
  const c = pathC(sampleRaw())
  assert.ok(c === a, 'C 与 A 不是逐字节相同')
  assert.equal(sha256(c), SAMPLE_BASELINE_SHA256)
  assert.equal(pathB(sampleRaw()), c)
})

test('公开样例：导出名与 PR1 的 deriveAppData 完全相同', () => {
  const legacy = deriveAppData(sampleRaw())
  const canonical = deriveAppDataFromCanonical(legacyAdapter(sampleRaw()), { now: NOW })
  for (const moduleName of Object.keys(legacy) as (keyof typeof legacy)[]) {
    assert.deepEqual(Object.keys(canonical[moduleName]).sort(), Object.keys(legacy[moduleName]).sort(), moduleName)
  }
})

// ---------------------------------------------------------------------------
// B ≡ C：各 fixture
// ---------------------------------------------------------------------------

test('PR1 审查记录的名称不一致数据（七类）：B ≡ C；A 与 B 的差异来自统一写法', () => {
  const raw = nameInconsistencyRaw()
  const c = assertBEqualsC(raw)
  assert.notEqual(pathA(raw), c)
  const canonical = deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW }).travelAtlas
  // 统一写法后：行程日标题用地点名称；拆分城市仍是两个城市。
  assert.equal(canonical.journeyDays.find((day) => day.id === 'mismatch_city_en_case')?.title, 'Reykjavik visit')
  assert.ok(canonical.cityById['faroe-islands__tórshavn'])
  assert.ok(canonical.cityById['faroe-islands__torshavn'])
  // 国旗取代表记录（样例的 fo），不受 dk 记录影响。
  assert.equal(canonical.countryById['faroe-islands'].flagCode, 'fo')
  assert.equal(canonical.cityById['faroe-islands__gjogv'].records?.find((item) => item.id === 'mismatch_country_code')?.country_code, 'fo')
})

test('国家别名 + regionSuffix：B ≡ C ≡ A', () => {
  const raw = rawInputs({
    records: [
      record({ id: 'a', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn', region: 'North Atlantic' }),
      record({ id: 'b', country: '法羅群島', country_en: 'Faeroe Islands', country_code: 'fo', city: '克拉克斯维克', city_en: 'Klaksvik', start_date: '2025-06-02' }),
      record({ id: 'c', country: '法羅群島', country_en: 'Faeroe Islands', country_code: 'fo', city: '维德', city_en: 'Vidoy', region: 'Islands', status: 'planned', start_date: '2026-01-01' }),
    ],
    display: {
      countryAliases: { 'Faeroe Islands': { country: '法罗群岛', country_en: 'Faroe Islands', regionSuffix: 'Nordoyar' } },
      countryCodes: { 'Faroe Islands': 'fo' },
    },
  })
  const c = assertBEqualsC(raw)
  assert.equal(pathA(raw), c)
  const derived = deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW }).travelAtlas
  assert.deepEqual(derived.countries.map((country) => [country.id, country.cityIds, country.keywords]), [
    ['faroe-islands', ['faroe-islands__torshavn', 'faroe-islands__klaksvik'], ['North Atlantic', 'Nordoyar']],
  ])
  assert.equal(derived.plannedRecords[0].region, 'Islands / Nordoyar')
  assert.equal(derived.routes[0].type, 'main')
})

test('hiddenCountries / originCountries / regionMatchers 分类（含变体写法与 region 子串）：B ≡ C', () => {
  const records: TravelMapRecord[] = [
    record({ id: 'home', country: '丹麦', country_en: 'Denmark', country_code: 'dk', city: '哥本哈根', city_en: 'Copenhagen', start_date: '2025-05-30' }),
    record({ id: 'is1' }),
    record({ id: 'is2', country_en: 'iceland', city: '维克', city_en: 'Vik', start_date: '2025-06-02' }),
    record({ id: 'fo', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn', region: 'North Atlantic', start_date: '2025-06-03' }),
    record({ id: 'no', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen', region: 'Iceland Highlands', start_date: '2025-06-04' }),
    record({ id: 'se', country: '瑞典', country_en: 'Sweden', country_code: 'se', city: '斯德哥尔摩', city_en: 'Stockholm', type: 'daytrip', start_date: '2025-06-05' }),
    record({ id: 'override', country: '瑞典', country_en: 'Sweden', country_code: 'se', city: '哥德堡', city_en: 'Gothenburg', travelCategory: 'destination', hiddenFromHome: true, start_date: '2025-06-06' }),
  ]
  for (const display of [
    { hiddenCountries: ['Denmark', 'iceland'], originCountries: ['Denmark'], regionMatchers: ['Atlantic', 'Sweden', 'Ghost'] },
    { hiddenCountries: ['Iceland'], originCountries: ['iceland'], regionMatchers: ['iceland'] },
    { regionMatchers: ['Iceland'] },
    { hiddenCountries: ['Norway', 'Nowhere'], regionMatchers: ['Norway'], hiddenCityNames: ['Torshavn', '卑尔根', 'Atlantis'] },
  ]) {
    assertBEqualsC(rawInputs({ records, display }))
  }
  // 一致的写法（没有变体、没有无效值，countryCodes 与记录一致）：A 也相同。
  const consistent = rawInputs({
    records: records.map((item) => (item.id === 'is2' ? { ...item, country_en: 'Iceland' } : item)),
    display: {
      hiddenCountries: ['Denmark'],
      originCountries: ['Denmark'],
      regionMatchers: ['Atlantic'],
      hiddenCityNames: ['Torshavn'],
      countryCodes: { Denmark: 'dk', Iceland: 'is', 'Faroe Islands': 'fo', Norway: 'no', Sweden: 'se' },
    },
  })
  assert.equal(pathA(consistent), assertBEqualsC(consistent))
  const derived = deriveAppDataFromCanonical(legacyAdapter(consistent), { now: NOW }).travelAtlas
  assert.deepEqual(derived.hiddenHomeRecords.map((item) => [item.id, item.travelCategory]), [['home', 'origin'], ['override', 'destination']])
  assert.equal(derived.shouldHideCityFromNavigation(derived.cityById['faroe-islands__torshavn']), true)
  assert.equal(derived.shouldHideCityFromNavigation(derived.cityById['iceland__reykjavik']), false)
})

test('journeyRules（含空关键词、空 id）与 slug 回落：B ≡ C', () => {
  const records = [
    record({ id: 'a', trip_title: 'Ring Road 2025' }),
    record({ id: 'b', trip_title: 'Ring Road 2025', city: '维克', city_en: 'Vik', start_date: '2025-06-02' }),
    record({ id: 'c', trip_title: undefined, city: '阿克雷里', city_en: 'Akureyri', start_date: '2025-06-03' }),
    record({ id: 'd', journeyId: 'own', start_date: '2025-06-04' }),
    record({ id: 'e', trip_title: 'Harbour days', city: '胡萨维克', city_en: 'Husavik', start_date: '2025-06-05' }),
  ]
  for (const journeyRules of [
    [{ includes: ['Ring'], id: 'ring' }],
    [{ includes: [''], id: 'everything' }],
    [{ includes: ['Harbour'], id: '' }, { includes: ['Ring'], id: 'ring' }],
  ]) {
    const raw = rawInputs({ records, display: { journeyRules, countryCodes: { Iceland: 'is' } } })
    assert.equal(pathA(raw), assertBEqualsC(raw))
  }
})

test('editor 隐藏国家与城市、排序：B ≡ C ≡ A', () => {
  const sample = sampleTravelMap()
  const raw = rawInputs({
    records: sample.records,
    display: sample.display,
    editorState: {
      schemaVersion: 1,
      countryOrder: ['faroe-islands', 'iceland'],
      hiddenCountryIds: ['faroe-islands'],
      cityOrderByCountry: { iceland: ['iceland__akureyri', 'iceland__reykjavik'] },
      hiddenCityIds: ['iceland__vik'],
    },
  })
  const c = assertBEqualsC(raw)
  assert.equal(pathA(raw), c)
  const derived = deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW }).travelAtlas
  assert.deepEqual(derived.countries.map((country) => [country.id, country.cityIds]), [['iceland', ['iceland__akureyri', 'iceland__reykjavik']]])
  assert.deepEqual(derived.cities.map((city) => city.id), ['iceland__reykjavik', 'iceland__akureyri'])
})

test('addedCountries：独立国家与同键国家（含国家全部隐藏时同键条目作为独立国家出现）：B ≡ C', () => {
  const addedCountries = [
    { id: 'greenland', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'gl', centerLat: 72, centerLng: -40, region: 'Arctic', visitedDate: '2024-08-01' },
    { id: 'norway', nameZh: '挪威', nameEn: 'Norway', countryCode: '', centerLat: 60, centerLng: 8 },
    { id: 'iceland', nameZh: '冰岛（手动）', nameEn: 'Iceland', countryCode: 'IS', centerLat: 65, centerLng: -18 },
  ]
  const records = [
    record({ id: 'a' }),
    record({ id: 'n', country: '挪威', country_en: 'Norway', country_code: undefined, city: '卑尔根', city_en: 'Bergen', lat: null, lng: null }),
  ]
  const consistent = rawInputs({
    records: [record({ id: 'a' })],
    display: { countryCodes: { Iceland: 'is' } },
    editorState: { schemaVersion: 1, addedCountries: [addedCountries[0]], countryOrder: ['greenland'] },
  })
  assert.equal(pathA(consistent), assertBEqualsC(consistent))

  for (const hiddenFromHome of [false, true]) {
    const raw = rawInputs({
      records: records.map((item) => ({ ...item, hiddenFromHome })),
      editorState: { schemaVersion: 1, addedCountries, countryOrder: ['iceland', 'greenland', 'norway'] },
    })
    assertBEqualsC(raw)
    const derived = deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW }).travelAtlas
    const standalone = derived.countries.filter((country) => country.records?.length === 0).map((country) => [country.id, country.nameZh, country.flagCode, country.centerLat])
    if (hiddenFromHome) {
      // 足迹记录都不上首页：同键条目作为独立国家出现，名称、代码、坐标取自地点（没有的才用条目自己的）。
      assert.deepEqual(standalone, [['iceland', '冰岛', 'is', 64.1466], ['greenland', '格陵兰', 'gl', 72], ['norway', '挪威', '', 60]])
    } else {
      assert.deepEqual(standalone, [['greenland', '格陵兰', 'gl', 72]])
    }
  }
})

test('planned 记录：与 visited 同城、只有 planned 的城市与国家：B ≡ C ≡ A', () => {
  const raw = rawInputs({
    records: [
      record({ id: 'visited' }),
      record({ id: 'same-city', status: 'planned', start_date: '2026-03-01', notes: 'again' }),
      record({ id: 'planned-only', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen', status: 'planned', lat: 60.39, lng: 5.32 }),
      record({ id: 'planned-no-coordinate', country: '挪威', country_en: 'Norway', country_code: 'no', city: '奥斯陆', city_en: 'Oslo', status: 'planned', lat: null, lng: null }),
    ],
    display: { countryCodes: { Iceland: 'is', Norway: 'no' } },
  })
  const c = assertBEqualsC(raw)
  assert.equal(pathA(raw), c)
  const derived = deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW })
  assert.deepEqual(derived.travelAtlas.plannedRecords.map((item) => item.id), ['same-city', 'planned-only', 'planned-no-coordinate'])
  assert.deepEqual(derived.travelAtlas.countries.map((country) => country.id), ['iceland'])
  assert.equal(derived.wantToGo.plannedConvertBlockReason(derived.travelAtlas.plannedRecords[2]), '这条旅行计划没有坐标，无法转为足迹。')
  assert.equal(derived.worldGraph.plannedSnapshot.entities.length, 3)
})

test('媒体：城市照片、封面、无人机、隐藏、悬空引用、坏条目：B ≡ C', () => {
  const media = (overrides: Record<string, unknown>) => ({
    kind: 'photo', scope: 'city', countryId: 'iceland', countryName: 'Iceland', cityId: 'iceland__reykjavik', cityName: 'Reykjavik',
    src: '/m.jpg', originalFileName: 'm.jpg', isCover: false, status: 'ready', ...overrides,
  })
  const raw = rawInputs({
    records: [record({ id: 'a' }), record({ id: 'b', city: '维克', city_en: 'Vik', start_date: '2025-06-02' })],
    editorState: {
      schemaVersion: 1,
      mediaOrderByCity: { iceland__reykjavik: ['p3', 'p1'] },
      coverMediaByCity: { iceland__reykjavik: 'p3' },
      hiddenMediaIds: ['p2'],
      droneOrderByCity: { iceland__vik: ['d2', 'd1'] },
      hiddenDroneMediaIds: ['d3'],
    },
    mediaCatalog: {
      schemaVersion: 2,
      items: [
        media({ id: 'p1', isCover: true, titleZh: '港口' }),
        media({ id: 'p2' }),
        media({ id: 'p3', variants: { thumb: { src: '/t.webp' }, original: { src: '/o.jpg' } } }),
        media({ id: 'p4', status: 'needsMetadata' }),
        media({ id: 'd1', kind: 'aerialPhoto', cityId: 'iceland__vik', cityName: 'Vik', date: '2025-06-02', resolution: '4K', titleEn: 'Coast' }),
        media({ id: 'd2', kind: 'panorama360', cityId: 'iceland__vik', cityName: 'Vik', date: '2025-06-02', resolution: '8K', position: { lat: 63.4, lng: -19 } }),
        media({ id: 'd3', kind: 'aerialPhoto', cityId: 'iceland__vik', cityName: 'Vik', date: '2025-06-02', resolution: '4K' }),
        media({ id: 'v1', kind: 'video', cityId: 'iceland__vik', cityName: 'Vik' }),
        media({ id: 'ghost', countryId: 'atlantis', countryName: 'Atlantis', cityId: 'atlantis__ghost', cityName: 'Ghost', kind: 'aerialPhoto', date: '2025-01-01', resolution: '4K' }),
        null,
        media({ id: 'weird', kind: 'sticker' }),
      ],
    },
  })
  assertBEqualsC(raw)
  const derived = deriveAppDataFromCanonical(legacyAdapter(raw), { now: NOW })
  assert.deepEqual(derived.mediaCatalog.getCityPhotos('iceland__reykjavik').map((item) => item.id), ['p3', 'p1'])
  assert.equal(derived.mediaCatalog.getCityCoverPhoto('iceland__reykjavik')?.id, 'p3')
  assert.deepEqual(derived.droneMedia.getDroneMediaForCity('iceland__vik').map((item) => item.id), ['d2', 'd1'])
  // 悬空引用保留：仍在目录与无人机列表里，只是没有国家 id 与名称（城市名回落到 cityId）。
  const ghost = derived.droneMedia.droneMediaById.ghost
  assert.deepEqual([ghost.city, ghost.country], ['atlantis__ghost', undefined])
  assert.deepEqual(derived.mediaCatalog.allImportedMediaItems.map((item) => item.id), ['p1', 'p2', 'p3', 'p4', 'd1', 'd2', 'd3', 'v1', 'ghost'])
})

test('没有名称不一致的个人数据：A ≡ B ≡ C；只多一张悬空媒体时，A 与 C 只差在这张媒体上', () => {
  const clean = consistentPersonalRaw()
  assert.equal(pathA(clean), assertBEqualsC(clean))

  const dangling = consistentPersonalRaw({ withDanglingMedia: true })
  const c = assertBEqualsC(dangling)
  // 悬空引用的媒体项（第 4 项、城市定义域里的第 6 个城市）删去国家 id 与名称（规格 §2.5），别的都不变。
  const paths = diffPaths(JSON.parse(pathA(dangling)), JSON.parse(c)).sort()
  const fields = ['cityName', 'countryId', 'countryName']
  assert.deepEqual(paths, [
    ...fields.map((field) => `$.modules.mediaCatalog.allImportedMediaItems.3.${field}`),
    ...fields.map((field) => `$.modules.mediaCatalog.getCityCoverPhoto.5.1.${field}`),
    ...fields.map((field) => `$.modules.mediaCatalog.getCityPhotos.5.1.0.${field}`),
    ...fields.map((field) => `$.modules.mediaCatalog.importedMediaItems.3.${field}`),
  ])
})

test('全部 fixture 合在一起（名称不一致 + 显示规则 + editor + 媒体 + 想去）：B ≡ C', () => {
  const personal = consistentPersonalRaw({ withDanglingMedia: true })
  const inconsistent = nameInconsistencyRaw()
  const raw: RawAppInputs = {
    ...personal,
    travelMap: {
      ...personal.travelMap,
      records: [...personal.travelMap.records, ...inconsistent.travelMap.records.slice(5)],
      display: { ...personal.travelMap.display, hiddenCountries: ['iceland'], regionMatchers: ['Nordoyar', 'Nowhere'], hiddenCityNames: ['Akureyri'] },
    },
  }
  assertBEqualsC(raw)
})
