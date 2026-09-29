/**
 * Canonical 派生（canonical/derive.ts）的单元测试（RFC-LOC-1 PR2 规格 §2.1、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 三条路径（见 ./legacy.fixture.ts）：
 *   A = PR1 的 deriveAppData(原始数据)
 *   B = PR1 的 deriveAppData(normalizeLegacy(原始数据))
 *   C = deriveAppDataFromCanonical(legacyAdapter(原始数据))
 * - 公开样例：C ≡ A（字节），且等于公布的基线哈希（@2；去掉 PR3b-1 新增的 countryIdOfCity 后等于 PR1 的 @1 哈希）；
 * - 下面每个 fixture：B ≡ C（字节），没有任何条件；
 * - 没有不一致的 fixture 另外 A ≡ C。
 *
 * RFC-LOC-1 PR5b：每个 fixture 的 C 输入（旧 id 空间的 Canonical）冻结成静态数据（./frozen.fixture.ts），
 * 这里逐一断言冻结值就是 legacyAdapter(本文件的原始数据) 经 JSON 往返的结果；文件末尾的锁定测试钉住全部冻结夹具
 * 与公开 V2 样例的派生基线哈希（删除旧派生之后，由它们取代上面的 B ≡ C）。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { deriveAppData, type RawAppInputs } from '../derive/appData.ts'
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import { canonicalForInputs, type V2FileInputs } from './canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import {
  LEGACY_ID_CANONICAL_NAMES,
  MIGRATED_CANONICAL_NAMES,
  V2_SPACE_CANONICAL_NAMES,
  canonicalForInputsFixture,
  countryOfCityUuidOf,
  legacyIdCanonical,
  migratedCanonical,
  v2SpaceCanonical,
  type LegacyIdCanonicalName,
} from './frozen.fixture.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import {
  NOW,
  SAMPLE_BASELINE_SHA256,
  SAMPLE_BASELINE_SHA256_V1,
  baselineText,
  consistentPersonalRaw,
  nameInconsistencyRaw,
  pathA,
  rawInputs,
  record,
  sampleRaw,
  sampleTravelMap,
  sampleWantToGo,
} from './legacy.fixture.ts'
import { normalizeLegacy } from './normalizeLegacy.ts'
import type { CanonicalData } from './types.ts'
import { jsonClone } from './v2Serializer.ts'

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

/** 冻结的旧 id 空间 Canonical 就是 legacyAdapter(原始数据) 经 JSON 往返的结果（PR5b 冻结时的对照）。 */
const assertFrozenIs = (name: LegacyIdCanonicalName, raw: RawAppInputs) => {
  assert.deepStrictEqual(legacyIdCanonical(name), jsonClone(legacyAdapter(raw)), `冻结的 ${name}`)
}

// ---------------------------------------------------------------------------
// 公开样例：C ≡ A
// ---------------------------------------------------------------------------

test('公开样例：C 与 A 逐字节相同，等于公布的基线（@2）', () => {
  assertFrozenIs('sample', sampleRaw())
  const a = pathA(sampleRaw())
  const c = pathC(sampleRaw())
  assert.ok(c === a, 'C 与 A 不是逐字节相同')
  assert.equal(sha256(c), SAMPLE_BASELINE_SHA256)
  assert.equal(pathB(sampleRaw()), c)
})

test('基线 @2：删掉 countryIdOfCity、format 改回 @1 之后，公开样例仍等于 PR1 公布的 @1 哈希', () => {
  const baseline = buildBaseline(deriveAppDataFromCanonical(legacyAdapter(sampleRaw()), { now: NOW }), { now: NOW }) as {
    format: string
    modules: { travelAtlas: Record<string, unknown> }
  }
  assert.equal(baseline.format, 'starmap-legacy-baseline@2')
  assert.equal(sha256(stableStringify(baseline)), SAMPLE_BASELINE_SHA256)
  assert.deepEqual(baseline.modules.travelAtlas.countryIdOfCity, [
    ['iceland__reykjavik', 'iceland'],
    ['iceland__vik', 'iceland'],
    ['iceland__akureyri', 'iceland'],
    ['faroe-islands__torshavn', 'faroe-islands'],
    ['faroe-islands__gjogv', 'faroe-islands'],
  ])

  delete baseline.modules.travelAtlas.countryIdOfCity
  baseline.format = 'starmap-legacy-baseline@1'
  assert.equal(sha256(stableStringify(baseline)), SAMPLE_BASELINE_SHA256_V1)
})

/**
 * countryIdOfCity 的数据：显示中的城市、被 editor 隐藏的城市、hiddenFromHome 的城市、只有 planned 的城市、
 * 国家别名（Faeroe Islands → Faroe Islands），另在 hiddenCityIds 里放一个陈旧 id（前缀是 iceland__，但没有这座城市）。
 */
const countryOfCityRaw = () => rawInputs({
  records: [
    record({ id: 'shown' }),
    record({ id: 'hidden-by-editor', city: '维克', city_en: 'Vik', start_date: '2025-06-02' }),
    record({ id: 'hidden-from-home', city: '阿克雷里', city_en: 'Akureyri', start_date: '2025-06-03', hiddenFromHome: true }),
    record({ id: 'planned-only', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen', status: 'planned', start_date: '2026-07-01' }),
    record({ id: 'alias', country: '法羅群島', country_en: 'Faeroe Islands', country_code: 'fo', city: '克拉克斯维克', city_en: 'Klaksvik', start_date: '2025-06-04' }),
  ],
  display: {
    countryAliases: { 'Faeroe Islands': { country: '法罗群岛', country_en: 'Faroe Islands' } },
    countryCodes: { Iceland: 'is', Norway: 'no', 'Faroe Islands': 'fo' },
  },
  editorState: { schemaVersion: 1, hiddenCityIds: ['iceland__vik', 'iceland__atlantis'] },
  wantToGo: sampleWantToGo(),
})

const COUNTRY_OF_CITY_EXPECTED: [string, string | undefined][] = [
  ['iceland__reykjavik', 'iceland'],
  ['iceland__vik', 'iceland'],
  ['iceland__akureyri', 'iceland'],
  ['norway__bergen', 'norway'],
  ['faroe-islands__klaksvik', 'faroe-islands'],
  // 陈旧 id：旧写法按前缀会算进 iceland，countryIdOfCity 不算（规格 §2.5 接受的唯一差异）。
  ['iceland__atlantis', undefined],
  // 别名前的写法、国家 id、不存在的 id 都不是城市。
  ['faeroe-islands__klaksvik', undefined],
  ['iceland', undefined],
  ['', undefined],
]

test('countryIdOfCity（Canonical 路径）：显示中、被 editor 隐藏、hiddenFromHome、只有 planned 的城市都查得到；陈旧 id 为 undefined；与旧路径逐项相同', () => {
  const raw = countryOfCityRaw()
  assertFrozenIs('countryOfCity', raw)
  const canonical = legacyAdapter(raw)
  const derived = deriveAppDataFromCanonical(canonical, { now: NOW }).travelAtlas
  const legacy = deriveAppData(raw).travelAtlas
  for (const [cityId, countryId] of COUNTRY_OF_CITY_EXPECTED) {
    assert.equal(derived.countryIdOfCity(cityId), countryId, `Canonical：${cityId}`)
    assert.equal(legacy.countryIdOfCity(cityId), countryId, `旧路径：${cityId}`)
  }
  // 被隐藏的城市不在 cityById 里——这正是 InfoCard 不能用 cityById 的原因。
  assert.equal(derived.cityById.iceland__vik, undefined)
  assert.equal(derived.cityById.norway__bergen, undefined)
  // 想去地点（legacy 模式下每个条目一个）也是城市地点，按 partOf 回答。
  assert.equal(derived.countryIdOfCity('wtg:wtg_2026-08-12_akureyri'), 'iceland')

  // 基线的定义域 = 城市级函数的定义域 ∪ hiddenCityIds；A ≡ B ≡ C。
  const c = assertBEqualsC(raw)
  assert.equal(pathA(raw), c)
  assert.deepEqual(JSON.parse(c).modules.travelAtlas.countryIdOfCity, [
    ['iceland__reykjavik', 'iceland'],
    ['faroe-islands__klaksvik', 'faroe-islands'],
    ['iceland__vik', 'iceland'],
    ['iceland__atlantis', null],
  ])
})

test('countryIdOfCity（V2 id 空间）：地点 id 换成 UUID 后按 partOf 回答，被隐藏的城市同样查得到', () => {
  // 上一个测试的数据直接搬进 V2 的 id 空间（不合并），PR5b 起是冻结的静态数据。
  const data = v2SpaceCanonical('countryOfCity')
  const uuidOf = countryOfCityUuidOf()
  const derived = deriveAppDataFromCanonical(data, { now: NOW }).travelAtlas
  for (const [cityId, countryId] of COUNTRY_OF_CITY_EXPECTED) {
    const uuid = uuidOf.get(cityId)
    if (uuid === undefined) continue
    assert.equal(derived.countryIdOfCity(uuid), countryId === undefined ? undefined : uuidOf.get(countryId), cityId)
  }
  assert.equal(derived.countryIdOfCity(uuidOf.get('iceland')!), undefined)
  assert.equal(derived.countryIdOfCity('iceland__vik'), undefined)
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
  assertFrozenIs('nameInconsistency', raw)
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
  assertFrozenIs('alias', raw)
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
  for (const [index, display] of [
    { hiddenCountries: ['Denmark', 'iceland'], originCountries: ['Denmark'], regionMatchers: ['Atlantic', 'Sweden', 'Ghost'] },
    { hiddenCountries: ['Iceland'], originCountries: ['iceland'], regionMatchers: ['iceland'] },
    { regionMatchers: ['Iceland'] },
    { hiddenCountries: ['Norway', 'Nowhere'], regionMatchers: ['Norway'], hiddenCityNames: ['Torshavn', '卑尔根', 'Atlantis'] },
  ].entries()) {
    assertFrozenIs(`classification${index + 1}` as LegacyIdCanonicalName, rawInputs({ records, display }))
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
  assertFrozenIs('classificationConsistent', consistent)
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
  for (const [index, journeyRules] of [
    [{ includes: ['Ring'], id: 'ring' }],
    [{ includes: [''], id: 'everything' }],
    [{ includes: ['Harbour'], id: '' }, { includes: ['Ring'], id: 'ring' }],
  ].entries()) {
    const raw = rawInputs({ records, display: { journeyRules, countryCodes: { Iceland: 'is' } } })
    assertFrozenIs(`journeyRules${index + 1}` as LegacyIdCanonicalName, raw)
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
  assertFrozenIs('editorHidden', raw)
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
  assertFrozenIs('addedCountriesConsistent', consistent)
  assert.equal(pathA(consistent), assertBEqualsC(consistent))

  for (const hiddenFromHome of [false, true]) {
    const raw = rawInputs({
      records: records.map((item) => ({ ...item, hiddenFromHome })),
      editorState: { schemaVersion: 1, addedCountries, countryOrder: ['iceland', 'greenland', 'norway'] },
    })
    assertFrozenIs(hiddenFromHome ? 'addedCountriesHomeHidden' : 'addedCountriesShown', raw)
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
  assertFrozenIs('planned', raw)
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
  assertFrozenIs('media', raw)
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
  assertFrozenIs('personal', clean)
  assert.equal(pathA(clean), assertBEqualsC(clean))

  const dangling = consistentPersonalRaw({ withDanglingMedia: true })
  assertFrozenIs('personalDanglingMedia', dangling)
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
  assertFrozenIs('combined', raw)
  assertBEqualsC(raw)
})

// ---------------------------------------------------------------------------
// 锁定（RFC-LOC-1 PR5b §4.1）：冻结夹具与公开 V2 样例的派生基线
// ---------------------------------------------------------------------------

/**
 * 派生基线的 sha256：`stableStringify(buildBaseline(deriveAppDataFromCanonical(…)))` 加末尾换行，与 scripts 的基线工具
 * 写出的文件相同。冻结时（PR5b 第一个提交）旧 id 空间的每一份都等于旧路径 B（`deriveAppData(normalizeLegacy(原始数据))`），
 * 公开样例（旧 id）同时等于 PR1 起公布的 @2 基线 8caf2cfb…。派生代码改变了任何一处结果，这里就会变红。
 */
const baselineSha256 = (canonical: CanonicalData) =>
  sha256(stableStringify(buildBaseline(deriveAppDataFromCanonical(canonical, { now: NOW }), { now: NOW })))

const readJsonFile = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

/** 五个 V2 文件经 canonicalForInputs（V2 Reader）→ 派生 → 基线，与 App、基线工具的管线相同。 */
const v2FilesSha256 = (v2Files: V2FileInputs, source: 'local' | 'sample' = 'local') =>
  baselineSha256(canonicalForInputs({ v2Files, source }))

const LEGACY_ID_LOCKS: Record<LegacyIdCanonicalName, string> = {
  sample: '8caf2cfb4e0a4c3180aa004e0f65c919f9dcca4424e6bb0445943175fe38ac34',
  personal: '54017d7029604e4c14db91c62e81f489130e0c24330db05eb39cb887ea1b2080',
  personalDanglingMedia: '59f24d37bfbe782cb6eeaa7491fede350953f0f53b5b58eedae0baf2bcafc7fc',
  nameInconsistency: '596ec87d2148602f68fcfe2098d2d957e0e69135a53defb122ef2f9a92c400b8',
  countryOfCity: '0a0c03c87542a9220becd30a76182e11501723b9ff18e8502f9d713e91205c14',
  alias: 'f16470d7cef8e6609d095709b6ede76e9d661811954a47dc14ee49083520eaac',
  classification1: 'b1c2fd0a4c8d2a78716ddb9a82dbb950dd3bfba5a85053e451e70e47555131e9',
  classification2: '686f28fc21ba095c437be5fce32fc93712f8beabfcb73fea8c3eb2ab4f381e0b',
  classification3: '828e78e084264eae7b78430779e8d4353bb1df7ccb402e8c10dbb764ef112f28',
  classification4: '2f2dfd4ff3d920587a1de746cd5a2d814784c7cd76bdd0582bd0e4966f9fc5c7',
  classificationConsistent: 'a4360307440b41d4a714bba0d5a02ca22727e8590980dd4f4d5a187c20dd64e3',
  journeyRules1: 'e8f45fba6775c19f7345ddc372e0e82c26497b72390bc59bfd7090b8d2eb4393',
  journeyRules2: 'c3722e63f042921fc1605f1794f766c6bc9569d379c1b004e170bea5a9d4e83c',
  journeyRules3: 'ea67ad06a39a91e390dfc17e345dd25cd1396b6a8add86730a137a0f36b711f7',
  editorHidden: 'eceb333045fdb9afb62127be28145f2281b0acae3696d203a3271f5f4959cafd',
  addedCountriesConsistent: '23ae8ba6c3dcbb0d3bffe547c8880d3b0f70f11202b21ff4982045e3eb2147e5',
  addedCountriesShown: 'aa4de009730b969c85e6208356651a7a19524209c7846079f0b2048ab92a4032',
  addedCountriesHomeHidden: '91172e94e507b4cc016d5e84072686bd42dc28742ef5d48578e85d5fd8e061a4',
  planned: '8454afd13fe9b85896785f0b4446feab98274b8667980ea4a03e01525bfe8765',
  media: '456dd907354888a56cdbdbc9acae8cc89520e7b2b9d7427d2bcc074343aba80b',
  combined: 'c104bb019f3601b5098bc125b26e1649294c440a53f9c4f2785b524200e7aee6',
  duplicate: '5846a3ca5c77ff4eeee05cab8dab98729f14365c5c21674b26fe6a9b670f5bfc',
  caseAndDiacritic: 'a34571380d635f1b2160a7021d058dacac366033f9be276c0fd563d2e5fc2ab2',
}

/**
 * 同一批中性数据在 V2 id 空间里：不合并直接搬进来的（v2Space）与迁移规划合并之后的 M（migrated）。
 * 两者、以及迁移后的五个文件派生出的基线相同（这批数据的合并不改变任何显示结果）。
 */
const PERSONAL_V2_LOCK = '1e156a97bd16fd562509bbc9811668bfa41490c753183b65d73cd0571d9db3a2'
const SAMPLE_V2_SPACE_LOCK = 'ded08902173649f676acca2cc3b340abd6e606684e9e45aa693d82363c206d61'
const NAME_INCONSISTENCY_V2_LOCK = '1884a1535046802bc4479c265841f7d2f8daf504b740fe8b6e5ce395533543f8'

const V2_SPACE_LOCKS: Record<(typeof V2_SPACE_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_V2_SPACE_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
  recordCoordinates: '519d94b7dfee2bcbabe4fb9657aa2a76ddfc36af57095f61f4307f8b35b6c6c7',
  countryOfCity: '3ff79e8a82f77bfc5bfbe2b245d9664a4cb5a66378c2e6fad5fe9f93adf9b211',
}

const MIGRATED_LOCKS: Record<(typeof MIGRATED_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_V2_SPACE_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
}

/** 冻结的五个 V2 文件（相对本文件的路径）。前两份是同一批中性个人数据迁移后的文件，后三份是三个脚本测试的私人根。 */
const V2_FILES_LOCKS: [string, string][] = [
  ['../v2write/fixtures/migrated-files.json', PERSONAL_V2_LOCK],
  ['../../../scripts/fixtures/bak-files-v2.json', '2716f03b2a629eb208545cd5fdd37cface7aba04815c2b2f24fcbedca4621647'],
  ['../../../scripts/fixtures/baseline-v2.json', 'e2e50ba99ac26f074679118e4cede8dc63368e22162454946bd3ba3a4e7354db'],
  ['../../../scripts/fixtures/editor-store-v2.json', '749c5d4d5d16e64b0eb2f461db82dc49e9ccf963734c29819d6c137fd809f961'],
]

/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布；`node scripts/baseline.mjs --sample` 的输出）。 */
const V2_SAMPLE_BASELINE_SHA256 = '3b30ae9cc31d6d646546dadf048809edb1dfa4609c7045288f3402be9a96fbd4'

const V2_SAMPLE_FILE_NAMES = { places: 'places.json', travel: 'travel-map.json', wantToGo: 'want-to-go.json', editorState: 'editor-state.json', media: 'user-media.json' }

test('锁定：旧 id 空间的冻结 Canonical（本文件、placeResolver 与 derive/baseline 测试的输入）的派生基线', () => {
  assert.deepEqual(Object.keys(LEGACY_ID_LOCKS), [...LEGACY_ID_CANONICAL_NAMES])
  for (const name of LEGACY_ID_CANONICAL_NAMES) assert.equal(baselineSha256(legacyIdCanonical(name)), LEGACY_ID_LOCKS[name], name)
})

test('锁定：V2 id 空间的冻结 Canonical 与迁移后的 M（v2Reader / v2Schema / v2Serializer 与本文件的输入）的派生基线', () => {
  assert.deepEqual(Object.keys(V2_SPACE_LOCKS), [...V2_SPACE_CANONICAL_NAMES])
  for (const name of V2_SPACE_CANONICAL_NAMES) assert.equal(baselineSha256(v2SpaceCanonical(name)), V2_SPACE_LOCKS[name], name)
  assert.deepEqual(Object.keys(MIGRATED_LOCKS), [...MIGRATED_CANONICAL_NAMES])
  for (const name of MIGRATED_CANONICAL_NAMES) assert.equal(baselineSha256(migratedCanonical(name).canonical), MIGRATED_LOCKS[name], name)
})

test('锁定：冻结的五个 V2 文件（canonicalForInputs、V2 写入与三个脚本测试的输入）经 canonicalForInputs 的派生基线', () => {
  const { files, migrated } = canonicalForInputsFixture()
  assert.equal(v2FilesSha256(files), PERSONAL_V2_LOCK, 'canonical-for-inputs.json 的文件')
  assert.equal(baselineSha256(migrated), PERSONAL_V2_LOCK, 'canonical-for-inputs.json 的 M')
  for (const [relative, lock] of V2_FILES_LOCKS) assert.equal(v2FilesSha256(readJsonFile(relative) as V2FileInputs), lock, relative)
})

test('锁定：公开 V2 样例（src/data/v2-sample/，来源 sample）的派生基线为 3b30ae9c…', () => {
  const v2Files = Object.fromEntries(Object.entries(V2_SAMPLE_FILE_NAMES).map(([key, name]) => [key, readJsonFile(`../v2-sample/${name}`)]))
  assert.equal(v2FilesSha256(v2Files, 'sample'), V2_SAMPLE_BASELINE_SHA256)
})
