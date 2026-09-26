/**
 * normalizeLegacy（canonical/normalizeLegacy.ts）的单元测试（RFC-LOC-1 PR2 规格 §4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 覆盖：报告的每个类别至少一例；对没有不一致的数据是恒等变换（派生结果逐字节相同）；
 * 统一写法之后再跑一次不再改动任何东西；PR1 审查记录里名称不一致测试的结论（用户看得见的三种变化）。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveAppData, type RawAppInputs } from '../derive/appData.ts'
import {
  baselineText,
  consistentPersonalRaw,
  nameInconsistencyRaw,
  pathA,
  rawInputs,
  record,
  sampleRaw,
} from './legacy.fixture.ts'
import { normalizeLegacy, type NormalizeCategoryKey, type NormalizeLegacyReport } from './normalizeLegacy.ts'

/** B：旧路径跑 normalizeLegacy(原始数据)。 */
const pathB = (raw: RawAppInputs) => baselineText(deriveAppData(normalizeLegacy(raw).normalized))

const counts = (report: NormalizeLegacyReport) =>
  Object.fromEntries(report.categories.filter((category) => category.count > 0).map((category) => [category.key, category.count]))

const idsOf = (report: NormalizeLegacyReport, key: NormalizeCategoryKey) =>
  report.categories.find((category) => category.key === key)?.ids

// ---------------------------------------------------------------------------
// 恒等：没有不一致的数据
// ---------------------------------------------------------------------------

test('公开样例：报告全为 0，A 与 B 逐字节相同', () => {
  const { report } = normalizeLegacy(sampleRaw())
  assert.deepEqual(counts(report), {})
  assert.equal(pathB(sampleRaw()), pathA(sampleRaw()))
})

test('没有名称不一致的个人数据（别名、planned、editor-state、媒体、想去）：报告全为 0，A 与 B 逐字节相同', () => {
  const raw = consistentPersonalRaw()
  assert.deepEqual(counts(normalizeLegacy(raw).report), {})
  assert.equal(pathB(raw), pathA(raw))
})

test('统一写法：别名与行程规则被消耗掉，名称字段不变；不修改输入', () => {
  const raw = consistentPersonalRaw()
  const before = structuredClone(raw)
  const { normalized } = normalizeLegacy(raw)
  assert.deepEqual(raw, before)

  const display = normalized.travelMap.display
  assert.equal(display?.countryAliases, undefined)
  assert.equal(display?.journeyRules, undefined)
  assert.deepEqual(display?.countryCodes, { Iceland: 'is', 'Faroe Islands': 'fo', Norway: 'no' })
  const klaksvik = normalized.travelMap.records.find((item) => item.id === 'alias_klaksvik')
  assert.equal(klaksvik?.country, '法罗群岛')
  assert.equal(klaksvik?.country_en, 'Faroe Islands')
  assert.equal(klaksvik?.region, 'North Atlantic / Nordoyar')
  // 非 planned 记录写入 journeyId；planned 不写。
  assert.equal(klaksvik?.journeyId, '2025-north-atlantic-demo')
  assert.equal(normalized.travelMap.records.find((item) => item.id === 'planned_bergen')?.journeyId, undefined)
})

test('再跑一次不再改动：normalizeLegacy 的输出是不动点', () => {
  for (const raw of [consistentPersonalRaw({ withDanglingMedia: true }), nameInconsistencyRaw()]) {
    const once = normalizeLegacy(raw).normalized
    const twice = normalizeLegacy(once)
    assert.deepEqual(twice.normalized, once)
    // 第二次只剩「只报告、不改动」的类别（悬空引用仍然悬空，但它的国家 id 与名称第一次就删掉了）。
    for (const key of Object.keys(counts(twice.report))) {
      assert.ok(['suspectedSplitCity', 'placeWithoutEnglishName', 'countryWithoutIso', 'journeyRuleWithoutId', 'mediaDangling'].includes(key), key)
    }
  }
})

// ---------------------------------------------------------------------------
// PR1 审查记录的名称不一致测试（七类）
// ---------------------------------------------------------------------------

test('名称不一致测试：六类全部检出，列出记录 id', () => {
  const { report } = normalizeLegacy(nameInconsistencyRaw())
  assert.deepEqual(counts(report), {
    countryNameZh: 1,
    countryNameEn: 1,
    countryCode: 1,
    cityNameZh: 1,
    cityNameEn: 1,
    suspectedSplitCity: 2,
    placeWithoutEnglishName: 1,
  })
  assert.deepEqual(idsOf(report, 'countryNameZh'), ['mismatch_country_zh'])
  assert.deepEqual(idsOf(report, 'countryNameEn'), ['mismatch_country_en_case'])
  assert.deepEqual(idsOf(report, 'countryCode'), ['mismatch_country_code'])
  assert.deepEqual(idsOf(report, 'cityNameZh'), ['mismatch_city_zh'])
  assert.deepEqual(idsOf(report, 'cityNameEn'), ['mismatch_city_en_case'])
  // 托尔斯港 / Tórshavn（只差变音符）与 维克 / 维克镇（只差行政后缀）；维克 与 胡萨维克式的包含关系不算。
  assert.deepEqual(idsOf(report, 'suspectedSplitCity'), ['sample_vik', 'mismatch_country_zh', 'mismatch_city_empty_en', 'sample_torshavn', 'mismatch_city_diacritic'])
  assert.deepEqual(idsOf(report, 'placeWithoutEnglishName'), ['iceland__维克镇'])
})

test('名称不一致测试：统一写法后用户看得见的变化只有三种（行程日标题、「N 个城市」、路线类型）', () => {
  const raw = nameInconsistencyRaw()
  const before = deriveAppData(raw).travelAtlas
  const after = deriveAppData(normalizeLegacy(raw).normalized).travelAtlas

  const day = (data: typeof before) => data.journeyDays.find((item) => item.id === 'mismatch_city_en_case')
  assert.equal(day(before)?.title, 'reykjavik visit')
  assert.equal(day(after)?.title, 'Reykjavik visit')

  const iceland = (data: typeof before) => data.countryById.iceland.summary
  // 今天 Reykjavik 与 reykjavik 被数成两个城市。
  assert.equal(iceland(before), '5 visited cities collected from Archive export.')
  assert.equal(iceland(after), '4 visited cities collected from Archive export.')

  const routeInto = (data: typeof before) => data.routes.find((route) => route.id.endsWith('__mismatch_country_en_case'))?.type
  assert.equal(routeInto(before), 'flight')
  assert.equal(routeInto(after), 'main')

  // 显示名、标记数量与位置、国旗不变；拆分城市修不了（仍是两个城市）。
  const names = (data: typeof before) => data.cities.map((city) => [city.id, city.nameZh, city.nameEn, city.lat, city.lng])
  assert.deepEqual(names(after), names(before))
  const flags = (data: typeof before) => data.countries.map((country) => [country.id, country.nameZh, country.nameEn, country.flagCode])
  assert.deepEqual(flags(after), flags(before))
})

// ---------------------------------------------------------------------------
// 其余类别
// ---------------------------------------------------------------------------

test('报告：国家代码写法、addedCountries、媒体、显示规则、国家代码表、行程规则、缺英文名 / 缺代码', () => {
  const raw = rawInputs({
    records: [
      record({ id: 'is-lower', country_code: 'is' }),
      record({ id: 'is-upper', country_code: 'IS', city: '维克', city_en: 'Vik' }),
      record({ id: 'is-missing', country_code: undefined, city: '胡萨维克', city_en: 'Husavik' }),
      record({ id: 'iceland-variant', country_en: 'iceland', city: '阿克雷里', city_en: 'Akureyri' }),
      record({ id: 'no', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen' }),
      record({ id: 'nameless', country: '某国', country_en: '', country_code: undefined, city: '某城', city_en: 'Somewhere' }),
      record({ id: 'rule', country: '丹麦', country_en: 'Denmark', country_code: 'dk', city: '哥本哈根', city_en: 'Copenhagen', trip_title: 'Harbour days' }),
    ],
    display: {
      hiddenCountries: ['iceland', 'Nowhere'],
      countryCodes: { Iceland: 'is', Atlantis: 'at' },
      journeyRules: [{ includes: ['Harbour'], id: '' }],
    },
    editorState: {
      schemaVersion: 1,
      addedCountries: [{ id: 'norway', nameZh: '挪威（手动）', nameEn: 'Norway', countryCode: 'no', centerLat: 1, centerLng: 2 }],
    },
    mediaCatalog: {
      schemaVersion: 2,
      items: [
        { id: 'm1', kind: 'photo', scope: 'city', countryId: 'iceland', countryName: 'iceland', cityId: 'iceland__reykjavik', cityName: 'Reykjavik', src: '/a.jpg', originalFileName: 'a.jpg', isCover: false, status: 'ready' },
        null,
        { id: 'm2', kind: 'photo', scope: 'city', countryId: 'atlantis', countryName: 'Atlantis', cityId: 'atlantis__x', cityName: 'X', src: '/b.jpg', originalFileName: 'b.jpg', isCover: false, status: 'ready' },
      ],
    },
  })
  const { report, normalized } = normalizeLegacy(raw)
  assert.deepEqual(counts(report), {
    countryNameEn: 1,
    countryCodeSpelling: 1,
    addedCountryMismatch: 1,
    mediaNameMismatch: 1,
    displayRuleVariant: 3,
    invalidDisplayRule: 1,
    countryCodesTable: 3,
    mediaInvalid: 1,
    mediaDangling: 1,
    journeyRuleWithoutId: 1,
    placeWithoutEnglishName: 1,
    countryWithoutIso: 1,
  })
  assert.deepEqual(idsOf(report, 'countryCodeSpelling'), ['is-upper', 'is-missing'])
  assert.deepEqual(idsOf(report, 'addedCountryMismatch'), ['norway'])
  assert.deepEqual(idsOf(report, 'mediaNameMismatch'), ['m1'])
  // hiddenCountries 的 'iceland' 今天只命中变体记录；统一后整个冰岛都不上首页。
  assert.deepEqual(idsOf(report, 'displayRuleVariant'), ['is-lower', 'is-upper', 'is-missing'])
  assert.deepEqual(idsOf(report, 'invalidDisplayRule'), ['display.hiddenCountries[1]'])
  // Atlantis 删去；Norway、Denmark 新增（某国没有代码，不进表）；Iceland 不变。
  assert.deepEqual(idsOf(report, 'countryCodesTable'), ['display.countryCodes#1', 'norway', 'denmark'])
  assert.deepEqual(idsOf(report, 'mediaInvalid'), ['items[1]'])
  assert.deepEqual(idsOf(report, 'mediaDangling'), ['m2'])
  assert.deepEqual(idsOf(report, 'journeyRuleWithoutId'), ['rule'])
  assert.deepEqual(idsOf(report, 'placeWithoutEnglishName'), ['某国'])
  assert.deepEqual(idsOf(report, 'countryWithoutIso'), ['某国'])

  const display = normalized.travelMap.display
  assert.deepEqual(display?.hiddenCountries, ['Iceland'])
  assert.deepEqual(display?.countryCodes, { Iceland: 'is', Norway: 'no', Denmark: 'dk' })
  // 行程 id 为空的规则无法写在记录上，保留 journeyRules。
  assert.deepEqual(display?.journeyRules, [{ includes: ['Harbour'], id: '' }])
  assert.deepEqual(
    normalized.travelMap.records.map((item) => [item.id, item.country_en, item.country_code]),
    [
      ['is-lower', 'Iceland', 'is'],
      ['is-upper', 'Iceland', 'is'],
      ['is-missing', 'Iceland', 'is'],
      ['iceland-variant', 'Iceland', 'is'],
      ['no', 'Norway', 'no'],
      ['nameless', '', undefined],
      ['rule', 'Denmark', 'dk'],
    ],
  )
  const editorState = normalized.editorState as { addedCountries: unknown[] }
  // 与足迹国家 norway 同键：名称、代码、中心坐标换成地点的值（条目原来写的是「挪威（手动）」与 1, 2）。
  assert.deepEqual(editorState.addedCountries, [
    { id: 'norway', nameZh: '挪威', nameEn: 'Norway', countryCode: 'no', centerLat: 64.1466, centerLng: -21.9426 },
  ])
  const items = (normalized.mediaCatalog as { items: Record<string, unknown>[] }).items
  assert.deepEqual(items.map((item) => [item.id, item.countryId, item.countryName, item.cityName]), [
    ['m1', 'iceland', 'Iceland', 'Reykjavik'],
    ['m2', undefined, undefined, undefined],
  ])
})
