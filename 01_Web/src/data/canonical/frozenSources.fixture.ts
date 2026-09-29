/**
 * 冻结夹具的原生成函数（RFC-LOC-1 PR5b §4.1）。不是测试文件，App 代码从不 import 它。
 *
 * PR5b 删除 Legacy Adapter 与迁移规划之前，先把测试用的 Canonical / V2 数据冻结成 `./fixtures/` 与
 * `../v2write/fixtures/` 下的静态 JSON。本模块只在冻结那一个提交里存在：它按今天的代码现场生成每份夹具，
 * `./frozen.equivalence.test.ts` 断言静态文件与这里的输出深相等；下一个提交删除旧代码时两者一起删除。
 *
 * 每个生成函数都与原来的调用点逐字相同（原调用点见各条注释）；全部是中性构造数据。
 */

/// <reference types="node" />

import type { RawAppInputs } from '../derive/appData.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import {
  NOW,
  consistentPersonalRaw,
  nameInconsistencyRaw,
  rawInputs,
  record,
  sampleRaw,
  sampleTravelMap,
  sampleWantToGo,
} from './legacy.fixture.ts'
import { sequentialUuids, toV2Space } from './v2.fixture.ts'
import { jsonClone } from './v2Serializer.ts'
import { REYKJAVIK, duplicateRaw, husavikRecord, personalRaw, plan, reykjavikRecord, vikRecord, wantToGoItem } from '../migration/migration.fixture.ts'
import { fileMetaFromRaw, planMigration } from '../migration/planMigration.ts'

// ---------------------------------------------------------------------------
// 原始输入（derive.test.ts 与 placeResolver.test.ts 里的现场数据，逐字搬来）
// ---------------------------------------------------------------------------

/** derive.test.ts：countryIdOfCity 的数据。 */
export const countryOfCityRaw = () => rawInputs({
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

/** derive.test.ts：国家别名 + regionSuffix。 */
const aliasRaw = () => rawInputs({
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

/** derive.test.ts：hiddenCountries / originCountries / regionMatchers 分类。 */
const classificationRecords = (): TravelMapRecord[] => [
  record({ id: 'home', country: '丹麦', country_en: 'Denmark', country_code: 'dk', city: '哥本哈根', city_en: 'Copenhagen', start_date: '2025-05-30' }),
  record({ id: 'is1' }),
  record({ id: 'is2', country_en: 'iceland', city: '维克', city_en: 'Vik', start_date: '2025-06-02' }),
  record({ id: 'fo', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn', region: 'North Atlantic', start_date: '2025-06-03' }),
  record({ id: 'no', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen', region: 'Iceland Highlands', start_date: '2025-06-04' }),
  record({ id: 'se', country: '瑞典', country_en: 'Sweden', country_code: 'se', city: '斯德哥尔摩', city_en: 'Stockholm', type: 'daytrip', start_date: '2025-06-05' }),
  record({ id: 'override', country: '瑞典', country_en: 'Sweden', country_code: 'se', city: '哥德堡', city_en: 'Gothenburg', travelCategory: 'destination', hiddenFromHome: true, start_date: '2025-06-06' }),
]

const CLASSIFICATION_DISPLAYS = [
  { hiddenCountries: ['Denmark', 'iceland'], originCountries: ['Denmark'], regionMatchers: ['Atlantic', 'Sweden', 'Ghost'] },
  { hiddenCountries: ['Iceland'], originCountries: ['iceland'], regionMatchers: ['iceland'] },
  { regionMatchers: ['Iceland'] },
  { hiddenCountries: ['Norway', 'Nowhere'], regionMatchers: ['Norway'], hiddenCityNames: ['Torshavn', '卑尔根', 'Atlantis'] },
]

const classificationRaw = (index: number) => () => rawInputs({ records: classificationRecords(), display: CLASSIFICATION_DISPLAYS[index] })

const classificationConsistentRaw = () => rawInputs({
  records: classificationRecords().map((item) => (item.id === 'is2' ? { ...item, country_en: 'Iceland' } : item)),
  display: {
    hiddenCountries: ['Denmark'],
    originCountries: ['Denmark'],
    regionMatchers: ['Atlantic'],
    hiddenCityNames: ['Torshavn'],
    countryCodes: { Denmark: 'dk', Iceland: 'is', 'Faroe Islands': 'fo', Norway: 'no', Sweden: 'se' },
  },
})

/** derive.test.ts：journeyRules（含空关键词、空 id）与 slug 回落。 */
const journeyRecords = () => [
  record({ id: 'a', trip_title: 'Ring Road 2025' }),
  record({ id: 'b', trip_title: 'Ring Road 2025', city: '维克', city_en: 'Vik', start_date: '2025-06-02' }),
  record({ id: 'c', trip_title: undefined, city: '阿克雷里', city_en: 'Akureyri', start_date: '2025-06-03' }),
  record({ id: 'd', journeyId: 'own', start_date: '2025-06-04' }),
  record({ id: 'e', trip_title: 'Harbour days', city: '胡萨维克', city_en: 'Husavik', start_date: '2025-06-05' }),
]

const JOURNEY_RULES = [
  [{ includes: ['Ring'], id: 'ring' }],
  [{ includes: [''], id: 'everything' }],
  [{ includes: ['Harbour'], id: '' }, { includes: ['Ring'], id: 'ring' }],
]

const journeyRulesRaw = (index: number) => () =>
  rawInputs({ records: journeyRecords(), display: { journeyRules: JOURNEY_RULES[index], countryCodes: { Iceland: 'is' } } })

/** derive.test.ts：editor 隐藏国家与城市、排序。 */
const editorHiddenRaw = () => {
  const sample = sampleTravelMap()
  return rawInputs({
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
}

/** derive.test.ts：addedCountries。 */
const ADDED_COUNTRIES = [
  { id: 'greenland', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'gl', centerLat: 72, centerLng: -40, region: 'Arctic', visitedDate: '2024-08-01' },
  { id: 'norway', nameZh: '挪威', nameEn: 'Norway', countryCode: '', centerLat: 60, centerLng: 8 },
  { id: 'iceland', nameZh: '冰岛（手动）', nameEn: 'Iceland', countryCode: 'IS', centerLat: 65, centerLng: -18 },
]

const addedCountriesConsistentRaw = () => rawInputs({
  records: [record({ id: 'a' })],
  display: { countryCodes: { Iceland: 'is' } },
  editorState: { schemaVersion: 1, addedCountries: [ADDED_COUNTRIES[0]], countryOrder: ['greenland'] },
})

const addedCountriesRaw = (hiddenFromHome: boolean) => () => rawInputs({
  records: [
    record({ id: 'a' }),
    record({ id: 'n', country: '挪威', country_en: 'Norway', country_code: undefined, city: '卑尔根', city_en: 'Bergen', lat: null, lng: null }),
  ].map((item) => ({ ...item, hiddenFromHome })),
  editorState: { schemaVersion: 1, addedCountries: ADDED_COUNTRIES, countryOrder: ['iceland', 'greenland', 'norway'] },
})

/** derive.test.ts：planned 记录。 */
const plannedRaw = () => rawInputs({
  records: [
    record({ id: 'visited' }),
    record({ id: 'same-city', status: 'planned', start_date: '2026-03-01', notes: 'again' }),
    record({ id: 'planned-only', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen', status: 'planned', lat: 60.39, lng: 5.32 }),
    record({ id: 'planned-no-coordinate', country: '挪威', country_en: 'Norway', country_code: 'no', city: '奥斯陆', city_en: 'Oslo', status: 'planned', lat: null, lng: null }),
  ],
  display: { countryCodes: { Iceland: 'is', Norway: 'no' } },
})

/** derive.test.ts：媒体。 */
const mediaRaw = () => {
  const media = (overrides: Record<string, unknown>) => ({
    kind: 'photo', scope: 'city', countryId: 'iceland', countryName: 'Iceland', cityId: 'iceland__reykjavik', cityName: 'Reykjavik',
    src: '/m.jpg', originalFileName: 'm.jpg', isCover: false, status: 'ready', ...overrides,
  })
  return rawInputs({
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
}

/** derive.test.ts：全部 fixture 合在一起。 */
const combinedRaw = (): RawAppInputs => {
  const personal = consistentPersonalRaw({ withDanglingMedia: true })
  const inconsistent = nameInconsistencyRaw()
  return {
    ...personal,
    travelMap: {
      ...personal.travelMap,
      records: [...personal.travelMap.records, ...inconsistent.travelMap.records.slice(5)],
      display: { ...personal.travelMap.display, hiddenCountries: ['iceland'], regionMatchers: ['Nordoyar', 'Nowhere'], hiddenCityNames: ['Akureyri'] },
    },
  }
}

/** placeResolver.test.ts：大小写、变音符、只有中文名。 */
const caseAndDiacriticRaw = () => personalRaw({
  records: [
    reykjavikRecord(),
    vikRecord({ city_en: '' }),
    husavikRecord({ city_en: 'Húsavík' }),
    record({ id: 'r_torshavn', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Tórshavn', start_date: '2025-06-06', lat: 62.0079, lng: -6.79 }),
  ],
  wantToGo: [
    wantToGoItem('w_reykjavik_lower', { nameZh: '雷克雅未克', nameEn: 'reykjavik', countryCode: 'is', ...REYKJAVIK }),
    wantToGoItem('w_vik_zh', { nameZh: '维克', nameEn: '维克', countryCode: 'IS', lat: 63.42, lng: -19.0 }),
    wantToGoItem('w_husavik_plain', { nameZh: '胡萨维克', nameEn: 'Husavik', countryCode: 'IS', lat: 66.0449, lng: -17.3389 }),
    wantToGoItem('w_torshavn_accent', { nameZh: '托尔斯港', nameEn: 'Tórshavn', countryCode: 'FO', lat: 62.01, lng: -6.77 }),
    wantToGoItem('w_torshavn_other_country', { nameZh: '托尔斯港', nameEn: 'Tórshavn', countryCode: 'DK', lat: 62.01, lng: -6.77 }),
  ],
})

/** v2Serializer.test.ts：记录坐标（与城市相同、自身坐标、null、只有一半）。 */
const recordCoordinatesRaw = () => rawInputs({
  records: [
    record({ id: 'same', start_date: '2025-06-01' }),
    record({ id: 'own', start_date: '2025-06-02', lat: 64.2, lng: -21.8 }),
    record({ id: 'none', start_date: '2025-06-03', lat: null, lng: null }),
    record({ id: 'half', start_date: '2025-06-04', lat: 64.1466, lng: null }),
  ],
})

/**
 * 旧 id 空间的 Canonical（`legacyAdapter(原始数据)`）：derive.test.ts、placeResolver.test.ts 与 derive/baseline.test.ts 的输入。
 * 键是冻结文件里的键。
 */
export const LEGACY_ID_CANONICAL_SOURCES: Record<string, () => RawAppInputs> = {
  sample: sampleRaw,
  personal: () => consistentPersonalRaw(),
  personalDanglingMedia: () => consistentPersonalRaw({ withDanglingMedia: true }),
  nameInconsistency: nameInconsistencyRaw,
  countryOfCity: countryOfCityRaw,
  alias: aliasRaw,
  classification1: classificationRaw(0),
  classification2: classificationRaw(1),
  classification3: classificationRaw(2),
  classification4: classificationRaw(3),
  classificationConsistent: classificationConsistentRaw,
  journeyRules1: journeyRulesRaw(0),
  journeyRules2: journeyRulesRaw(1),
  journeyRules3: journeyRulesRaw(2),
  editorHidden: editorHiddenRaw,
  addedCountriesConsistent: addedCountriesConsistentRaw,
  addedCountriesShown: addedCountriesRaw(false),
  addedCountriesHomeHidden: addedCountriesRaw(true),
  planned: plannedRaw,
  media: mediaRaw,
  combined: combinedRaw,
  duplicate: duplicateRaw,
  caseAndDiacritic: caseAndDiacriticRaw,
}

/** V2 id 空间的 Canonical（`toV2Space(legacyAdapter(原始数据)).data`）：v2Reader / v2Schema / v2Serializer / derive 测试的输入。 */
export const V2_SPACE_SOURCES: Record<string, () => RawAppInputs> = {
  sample: sampleRaw,
  personal: () => consistentPersonalRaw(),
  nameInconsistency: nameInconsistencyRaw,
  recordCoordinates: recordCoordinatesRaw,
  countryOfCity: countryOfCityRaw,
}

/** v2Serializer.test.ts「经迁移规划」：三份 PR2 fixture。 */
export const MIGRATED_SOURCES: Record<string, () => RawAppInputs> = {
  sample: sampleRaw,
  personal: () => consistentPersonalRaw(),
  nameInconsistency: nameInconsistencyRaw,
}

/** 生成全部冻结文件：相对 `src/data/` 的路径 → JSON 值。 */
export const generateFrozenFixtures = (): Record<string, unknown> => {
  const legacyIdCanonical = Object.fromEntries(
    Object.entries(LEGACY_ID_CANONICAL_SOURCES).map(([name, raw]) => [name, jsonClone(legacyAdapter(raw()))]),
  )

  const v2Space = Object.fromEntries(
    Object.entries(V2_SPACE_SOURCES).map(([name, raw]) => [name, toV2Space(legacyAdapter(raw())).data]),
  )
  const countryOfCity = toV2Space(legacyAdapter(countryOfCityRaw()))

  // v2Serializer.test.ts：planMigration(sourceHash 'x', 2026-09-26) 的 M 与 roundTrip 用的文件级元数据。
  const migrated = Object.fromEntries(Object.entries(MIGRATED_SOURCES).map(([name, rawOf]) => {
    const raw = rawOf()
    const canonical = planMigration({
      raw,
      fileMeta: fileMetaFromRaw(raw),
      sourceHash: 'x',
      newId: sequentialUuids(),
      now: '2026-09-26T00:00:00.000Z',
    }).canonical.migrated!
    return [name, { canonical: jsonClone(canonical), fileMeta: jsonClone(fileMetaFromRaw(raw)) }]
  }))

  // canonicalForInputs.test.ts：consistentPersonalRaw 经 planMigration(sourceHash 'test', NOW) 的文件与 M。
  const cfiRaw = { ...consistentPersonalRaw(), now: NOW }
  const cfi = planMigration({
    raw: cfiRaw,
    fileMeta: fileMetaFromRaw(cfiRaw),
    sourceHash: 'test',
    newId: sequentialUuids(),
    now: NOW,
  })

  // v2write.fixture.ts：migratedFiles()。
  const v2writeFiles = plan(consistentPersonalRaw()).files

  return {
    'canonical/fixtures/legacy-id-canonical.json': legacyIdCanonical,
    'canonical/fixtures/v2-space-canonical.json': {
      ...v2Space,
      countryOfCityUuidOf: [...countryOfCity.uuidOf.entries()],
    },
    'canonical/fixtures/migrated-canonical.json': migrated,
    'canonical/fixtures/canonical-for-inputs.json': { files: jsonClone(cfi.files), migrated: jsonClone(cfi.canonical.migrated) },
    'v2write/fixtures/migrated-files.json': jsonClone(v2writeFiles),
  }
}
