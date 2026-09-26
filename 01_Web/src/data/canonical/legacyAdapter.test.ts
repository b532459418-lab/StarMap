/**
 * Legacy Adapter（canonical/legacyAdapter.ts）的单元测试（RFC-LOC-1 PR2 规格 §4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 覆盖：§2.2 的 id 规则；§2.3 的代表记录、名称、ISO、坐标；显示规则转换（四类，含匹配不到的值）；
 * journeyId 写入；editor-state 的 v2 形态；想去地点每条一个；媒体逐条校验与悬空引用保留。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cityKeyForRecord, countryKeyForRecord } from '../derive/travelAtlas.ts'
import { buildLegacyCanonical, legacyAdapter } from './legacyAdapter.ts'
import { NOW, rawInputs, record, sampleRaw } from './legacy.fixture.ts'
import type { CanonicalData, CanonicalPlace } from './types.ts'

const placeOf = (canonical: CanonicalData, id: string): CanonicalPlace => {
  const place = canonical.places.find((candidate) => candidate.id === id)
  assert.ok(place, `缺少地点 ${id}`)
  return place
}

const hasPlace = (canonical: CanonicalData, id: string) => canonical.places.some((place) => place.id === id)

// ---------------------------------------------------------------------------
// §2.2 地点 id
// ---------------------------------------------------------------------------

test('公开样例：足迹国家与城市的 id 是今天的 CountryId / CityId，城市 partOf 国家', () => {
  const canonical = legacyAdapter(sampleRaw())
  const sample = sampleRaw().travelMap.records

  for (const item of sample) {
    const city = placeOf(canonical, cityKeyForRecord(item))
    assert.equal(city.subtype, 'city')
    assert.equal(city.partOf, countryKeyForRecord(item))
    assert.deepEqual(city.legacyKeys, [city.id])
  }
  assert.deepEqual(
    canonical.places.filter((place) => place.subtype === 'country' && place.legacyKeys).map((place) => place.id),
    ['iceland', 'faroe-islands'],
  )
  assert.deepEqual(canonical.travel.records.map((item) => item.placeId), sample.map(cityKeyForRecord))
})

test('国家别名归一之后才推导 id；visited 与 planned 共用同一个城市地点', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'a', country: '法罗', country_en: 'Faeroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn' }),
      record({ id: 'b', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn', status: 'planned' }),
    ],
    display: { countryAliases: { 'Faeroe Islands': { country: '法罗群岛', country_en: 'Faroe Islands', regionSuffix: 'Streymoy' } } },
  }))

  assert.deepEqual(canonical.travel.records.map((item) => item.placeId), ['faroe-islands__torshavn', 'faroe-islands__torshavn'])
  assert.equal(canonical.places.filter((place) => place.subtype === 'city').length, 1)
  // 别名在适配器里消耗掉：region 带上后缀，名称取别名的写法。
  assert.equal(canonical.travel.records[0].region, 'Streymoy')
  assert.deepEqual(placeOf(canonical, 'faroe-islands').names, { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' })
})

test('addedCountries：id 取条目自带的；与同键足迹国家是同一个地点', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [record({ id: 'a' })],
    editorState: {
      schemaVersion: 1,
      addedCountries: [
        { id: 'greenland', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'gl', centerLat: 72, centerLng: -40, region: 'Arctic' },
        { id: 'iceland', nameZh: '冰岛（手动）', nameEn: 'Iceland Added', countryCode: 'is', centerLat: 1, centerLng: 2 },
      ],
    },
  }))

  assert.deepEqual(placeOf(canonical, 'greenland'), {
    id: 'greenland',
    subtype: 'country',
    names: { 'zh-Hans': '格陵兰', en: 'Greenland' },
    externalIds: { iso3166Alpha2: 'GL' },
    location: { lat: 72, lng: -40 },
    legacyKeys: ['greenland'],
  })
  // 同键：只有一个 iceland 地点，名称、代码、坐标来自足迹。
  assert.equal(canonical.places.filter((place) => place.id === 'iceland').length, 1)
  assert.deepEqual(placeOf(canonical, 'iceland').names, { 'zh-Hans': '冰岛', en: 'Iceland' })
  assert.deepEqual(placeOf(canonical, 'iceland').location, { lat: 64.1466, lng: -21.9426 })
  assert.deepEqual(canonical.editorState.addedCountries, [
    { placeId: 'greenland', region: 'Arctic' },
    { placeId: 'iceland' },
  ])
})

test('想去：每个条目一个地点 wtg:<item.id>，不与足迹合并；城市的所属国家按 ISO 找足迹国家', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'a' }),
      record({ id: 'n', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen' }),
      record({ id: 'n2', country: '挪威王国', country_en: 'Kingdom of Norway', country_code: 'NO', city: '奥斯陆', city_en: 'Oslo' }),
    ],
    wantToGo: {
      schema_version: 1,
      items: [
        // 与足迹城市同名同国：legacy 模式仍是两个地点。
        { id: 'w1', place: { kind: 'city', nameZh: '雷克雅未克', nameEn: 'Reykjavik', countryCode: 'IS', lat: 64.1, lng: -21.9 }, addedAt: '2026-01-01' },
        // 同一 ISO 有两个足迹国家（norway / kingdom-of-norway）：不是「恰好一个」→ iso:NO。
        { id: 'w2', place: { kind: 'city', nameZh: '特罗姆瑟', nameEn: 'Tromsø', countryCode: 'no' }, addedAt: '2026-01-02', hidden: true, note: '极光' },
        // 没有足迹国家具有该 ISO → iso:GL。
        { id: 'w3', place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL' }, addedAt: '2026-01-03' },
        // 国家条目：自身带 ISO。
        { id: 'w4', place: { kind: 'country', nameZh: '法罗群岛', nameEn: 'Faroe Islands', countryCode: 'FO', lat: 62, lng: -7 }, addedAt: '2026-01-04', source: 'manual' },
        // 同一 iso 地点被复用。
        { id: 'w5', place: { kind: 'city', nameEn: 'Ilulissat', countryCode: 'GL' }, addedAt: '2026-01-05' },
      ],
    },
  }))

  // 恰好一个足迹国家（iceland）具有 IS。
  assert.deepEqual(placeOf(canonical, 'wtg:w1'), {
    id: 'wtg:w1', subtype: 'city', names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }, partOf: 'iceland', location: { lat: 64.1, lng: -21.9 },
  })
  assert.notEqual(placeOf(canonical, 'wtg:w1').id, 'iceland__reykjavik')
  assert.equal(placeOf(canonical, 'wtg:w2').partOf, 'iso:NO')
  assert.equal(placeOf(canonical, 'wtg:w3').partOf, 'iso:GL')
  assert.equal(placeOf(canonical, 'wtg:w5').partOf, 'iso:GL')
  assert.equal(canonical.places.filter((place) => place.id === 'iso:GL').length, 1)
  assert.deepEqual(placeOf(canonical, 'iso:GL').externalIds, { iso3166Alpha2: 'GL' })
  assert.equal(placeOf(canonical, 'iso:GL').subtype, 'country')
  assert.equal(placeOf(canonical, 'iso:GL').legacyKeys, undefined)
  // iso 地点的名称来自 Intl.DisplayNames（与 UI 显示想去国家名的方式一致）。
  assert.equal(placeOf(canonical, 'iso:GL').names.en, new Intl.DisplayNames(['en'], { type: 'region' }).of('GL'))
  assert.equal(placeOf(canonical, 'iso:GL').names['zh-Hans'], new Intl.DisplayNames(['zh-Hans'], { type: 'region' }).of('GL'))
  assert.deepEqual(placeOf(canonical, 'wtg:w4'), {
    id: 'wtg:w4', subtype: 'country', names: { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' }, externalIds: { iso3166Alpha2: 'FO' }, location: { lat: 62, lng: -7 },
  })
  // 没有中文名时，Core 的解析把英文名当中文名。
  assert.deepEqual(placeOf(canonical, 'wtg:w5').names, { 'zh-Hans': 'Ilulissat', en: 'Ilulissat' })

  assert.deepEqual(canonical.wantToGo, {
    source: 'local',
    items: [
      { id: 'w1', placeId: 'wtg:w1', addedAt: '2026-01-01', hidden: false },
      { id: 'w2', placeId: 'wtg:w2', addedAt: '2026-01-02', hidden: true, note: '极光' },
      { id: 'w3', placeId: 'wtg:w3', addedAt: '2026-01-03', hidden: false },
      { id: 'w4', placeId: 'wtg:w4', addedAt: '2026-01-04', hidden: false, source: 'manual' },
      { id: 'w5', placeId: 'wtg:w5', addedAt: '2026-01-05', hidden: false },
    ],
    problems: [],
  })
})

test('想去：恰好一个足迹国家（含手动添加的国家）具有同一 ISO 时用它', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [record({ id: 'a' })],
    editorState: {
      schemaVersion: 1,
      addedCountries: [{ id: 'greenland', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'gl', centerLat: 72, centerLng: -40 }],
    },
    wantToGo: { schema_version: 1, items: [{ id: 'w', place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL' }, addedAt: '2026-01-01' }] },
  }))
  assert.equal(placeOf(canonical, 'wtg:w').partOf, 'greenland')
  assert.equal(hasPlace(canonical, 'iso:GL'), false)
})

test('想去：解析问题原样进 problems；私有文件不存在（none）时为空', () => {
  const broken = legacyAdapter(rawInputs({ records: [], wantToGo: { schema_version: 1, items: [{ id: 'x' }] } }))
  assert.equal(broken.wantToGo.items.length, 0)
  assert.equal(broken.wantToGo.problems.length, 1)

  const none = legacyAdapter(rawInputs({ records: [] }))
  assert.deepEqual(none.wantToGo, { source: 'none', items: [], problems: [] })
})

// ---------------------------------------------------------------------------
// §2.3 代表记录：名称、ISO、坐标
// ---------------------------------------------------------------------------

test('代表记录 = 第一条显示中的记录（非 planned、非 hiddenFromHome、未被 editor 隐藏）；名称只写非空值', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      // 所在城市被 editor 隐藏：不算显示中。
      record({ id: 'in-hidden-city', country: '冰岛（隐藏城市）', city: '维克', city_en: 'Vik' }),
      // planned：不算显示中。
      record({ id: 'planned', country: '冰岛（计划）', city: '雷克雅维克', status: 'planned' }),
      // hiddenFromHome：不算显示中。
      record({ id: 'transit', country: '冰岛（中转）', city: '雷克', hiddenFromHome: true }),
      record({ id: 'shown', country: '冰岛', country_en: 'Iceland', city: '雷克雅未克' }),
      record({ id: 'later', country: '冰島', country_en: 'ICELAND', city: '雷克雅未克市' }),
    ],
    editorState: { schemaVersion: 1, hiddenCityIds: ['iceland__vik'] },
  }))
  assert.deepEqual(placeOf(canonical, 'iceland').names, { 'zh-Hans': '冰岛', en: 'Iceland' })
  assert.deepEqual(placeOf(canonical, 'iceland__reykjavik').names, { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' })
  // 被隐藏的城市没有显示中的记录 → 第一条非 planned 记录。
  assert.deepEqual(placeOf(canonical, 'iceland__vik').names, { 'zh-Hans': '维克', en: 'Vik' })

  const noEnglish = legacyAdapter(rawInputs({ records: [record({ id: 'a', country_en: '', country: '冰岛', city_en: '' })] }))
  assert.deepEqual(placeOf(noEnglish, '冰岛').names, { 'zh-Hans': '冰岛' })
  assert.deepEqual(placeOf(noEnglish, '冰岛__雷克雅未克').names, { 'zh-Hans': '雷克雅未克' })
})

test('代表记录：没有显示中的记录 → 第一条非 planned；再没有 → 第一条', () => {
  const noneShown = legacyAdapter(rawInputs({
    records: [
      record({ id: 'planned', city: '计划名', status: 'planned' }),
      record({ id: 'transit', city: '中转名', hiddenFromHome: true }),
    ],
  }))
  assert.equal(placeOf(noneShown, 'iceland__reykjavik').names['zh-Hans'], '中转名')

  const plannedOnly = legacyAdapter(rawInputs({
    records: [
      record({ id: 'p1', country: '挪威', country_en: 'Norway', country_code: undefined, city: '卑尔根', city_en: 'Bergen', status: 'planned' }),
      record({ id: 'p2', country: '挪威王国', country_en: 'Norway', country_code: 'NO', city: '卑尔根市', city_en: 'Bergen', status: 'planned' }),
    ],
  }))
  assert.deepEqual(placeOf(plannedOnly, 'norway').names, { 'zh-Hans': '挪威', en: 'Norway' })
  // ISO 取代表记录：p1 没写代码，display.countryCodes 也没有 → 没有 ISO（不去别的记录上找）。
  assert.equal(placeOf(plannedOnly, 'norway').externalIds, undefined)
  assert.deepEqual(placeOf(plannedOnly, 'norway__bergen').names, { 'zh-Hans': '卑尔根', en: 'Bergen' })
})

test('城市代表记录跳过没有任何城市名的记录（否则旧键回落到记录 id，统一写法后城市会被拆开）', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'vik', city: '', city_en: '' }),
      record({ id: 'b', city: '维克', city_en: 'Vik' }),
    ],
  }))
  assert.deepEqual(canonical.travel.records.map((item) => item.placeId), ['iceland__vik', 'iceland__vik'])
  assert.deepEqual(placeOf(canonical, 'iceland__vik').names, { 'zh-Hans': '维克', en: 'Vik' })
})

test('ISO：代表记录的 country_code，否则 display.countryCodes[country_en || country]；统一大写；空值视为没有', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'a', country_code: 'is' }),
      record({ id: 'b', country: '法罗群岛', country_en: 'Faroe Islands', country_code: undefined, city_en: 'Torshavn' }),
      record({ id: 'c', country: '丹麦', country_en: '', country_code: undefined, city_en: 'Copenhagen' }),
      record({ id: 'd', country: '挪威', country_en: 'Norway', country_code: '', city_en: 'Oslo' }),
      record({ id: 'e', country: '瑞典', country_en: 'Sweden', country_code: undefined, city_en: 'Stockholm' }),
    ],
    display: { countryCodes: { 'Faroe Islands': 'fo', 丹麦: 'dk', Norway: 'no' } },
  }))
  assert.deepEqual(placeOf(canonical, 'iceland').externalIds, { iso3166Alpha2: 'IS' })
  assert.deepEqual(placeOf(canonical, 'faroe-islands').externalIds, { iso3166Alpha2: 'FO' })
  assert.deepEqual(placeOf(canonical, '丹麦').externalIds, { iso3166Alpha2: 'DK' })
  assert.deepEqual(placeOf(canonical, '丹麦').names, { 'zh-Hans': '丹麦' })
  // 与 flagCode 一样用 ??：记录上写了空字符串就不再回落到 countryCodes。
  assert.equal(placeOf(canonical, 'norway').externalIds, undefined)
  assert.equal(placeOf(canonical, 'sweden').externalIds, undefined)
})

test('坐标：城市取显示中记录里第一个可用坐标；国家取显示中记录坐标的平均；没有坐标就不写', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'transit', hiddenFromHome: true, lat: 1, lng: 1 }),
      record({ id: 'no-coordinate', lat: null, lng: null }),
      record({ id: 'first', lat: 10, lng: 20 }),
      record({ id: 'second', city_en: 'Vik', lat: 30, lng: 40 }),
      record({ id: 'nowhere', country: '甲', country_en: 'Alpha', city_en: 'Nowhere', lat: null, lng: null }),
    ],
  }))
  assert.deepEqual(placeOf(canonical, 'iceland__reykjavik').location, { lat: 10, lng: 20 })
  assert.deepEqual(placeOf(canonical, 'iceland').location, { lat: 20, lng: 30 })
  assert.equal(placeOf(canonical, 'alpha__nowhere').location, undefined)
  assert.equal(placeOf(canonical, 'alpha').location, undefined)
})

test('坐标：没有显示中的记录时，城市与国家取非 planned（再没有则全部）记录', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'planned', status: 'planned', lat: 1, lng: 2 }),
      record({ id: 'hidden', hiddenFromHome: true, lat: 3, lng: 4 }),
      record({ id: 'p-only', country: '挪威', country_en: 'Norway', city_en: 'Bergen', status: 'planned', lat: 60, lng: 5 }),
    ],
  }))
  assert.deepEqual(placeOf(canonical, 'iceland__reykjavik').location, { lat: 3, lng: 4 })
  assert.deepEqual(placeOf(canonical, 'norway__bergen').location, { lat: 60, lng: 5 })
  assert.deepEqual(placeOf(canonical, 'norway').location, { lat: 60, lng: 5 })
})

test('addedCountries 与同键足迹国家：地点没有 ISO / 坐标时，条目保留自己的代码与中心', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [record({ id: 'a', country_code: undefined, lat: null, lng: null })],
    editorState: {
      schemaVersion: 1,
      addedCountries: [{ id: 'iceland', nameZh: '冰岛', nameEn: 'Iceland', countryCode: 'is', centerLat: 65, centerLng: -18, visitedDate: '2024-01-01' }],
    },
  }))
  assert.equal(placeOf(canonical, 'iceland').externalIds, undefined)
  assert.equal(placeOf(canonical, 'iceland').location, undefined)
  assert.deepEqual(canonical.editorState.addedCountries, [
    { placeId: 'iceland', visitedDate: '2024-01-01', countryCode: 'is', center: { lat: 65, lng: -18 } },
  ])
})

// ---------------------------------------------------------------------------
// 显示规则转换
// ---------------------------------------------------------------------------

test('显示规则：四类转换为地点；变体写法命中整个地点；匹配不到的值丢弃', () => {
  const build = buildLegacyCanonical(rawInputs({
    records: [
      record({ id: 'is1', country_en: 'Iceland' }),
      record({ id: 'is2', country_en: 'iceland', city_en: 'Vik' }),
      record({ id: 'fo', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city_en: 'Torshavn', region: 'North Atlantic' }),
      record({ id: 'no', country: '挪威', country_en: 'Norway', country_code: 'no', city_en: 'Bergen', region: 'Vestland' }),
      record({ id: 'dk', country: '丹麦', country_en: 'Denmark', country_code: 'dk', city: '哥本哈根', city_en: 'Copenhagen' }),
    ],
    display: {
      // 'iceland' 只写中了变体记录 is2，但落到整个国家地点上。
      hiddenCountries: ['iceland', 'Nowhere'],
      originCountries: ['Iceland', 'Denmark'],
      // 'Norway' 命中国家；'Atlantic' 命中 region 子串；'Ghost' 两样都不命中。
      regionMatchers: ['Norway', 'Atlantic', 'Ghost'],
      // 按显示中城市的中文名或英文名匹配。
      hiddenCityNames: ['哥本哈根', 'Torshavn', 'Atlantis'],
    },
  }))
  const { display } = build.canonical.travel
  assert.deepEqual(display.homeHiddenCountryIds, ['iceland'])
  assert.deepEqual(display.originCountryIds, ['iceland', 'denmark'])
  assert.deepEqual(display.regionCountryIds, ['norway'])
  assert.deepEqual(display.regionIncludes, ['Atlantic'])
  assert.deepEqual(display.navigationHiddenCityIds, ['faroe-islands__torshavn', 'denmark__copenhagen'])
  assert.deepEqual(build.invalidDisplayPaths, [
    'display.hiddenCountries[1]',
    'display.regionMatchers[2]',
    'display.hiddenCityNames[2]',
  ])
  // 统一写法后的旧格式值（normalizeLegacy 写回旧文件用）。
  assert.deepEqual(build.legacyDisplay, {
    hiddenCountries: ['Iceland'],
    originCountries: ['Iceland', 'Denmark'],
    regionMatchers: ['Norway', 'Atlantic'],
    hiddenCityNames: ['哥本哈根', 'Torshavn'],
  })
  // 今天按字符串：只有 is2 命中 hiddenCountries 的 'iceland'，而它的 'iceland' 不在 originCountries 里 → transit；
  // 新分类按地点：两条冰岛记录都属于 hidden 且属于 origin 的国家 → origin。
  assert.deepEqual(build.legacyCategories.map((category) => category?.travelCategory), ['destination', 'transit', 'region', 'region', 'destination'])
  assert.deepEqual(build.canonicalCategories.map((category) => category?.travelCategory), ['origin', 'origin', 'region', 'region', 'destination'])
})

test('显示规则：hiddenCityNames 只匹配显示中的城市；overviewTarget 原样保留', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'a' }),
      record({ id: 'b', city_en: 'Vik', hiddenFromHome: true }),
    ],
    display: { overviewTarget: { lat: 1, lng: 2 }, hiddenCityNames: ['Vik'] },
  }))
  assert.deepEqual(canonical.travel.display.navigationHiddenCityIds, [])
  assert.deepEqual(canonical.travel.display.overviewTarget, { lat: 1, lng: 2 })
})

// ---------------------------------------------------------------------------
// journeyId、记录形状
// ---------------------------------------------------------------------------

test('journeyId：非 planned 记录按今天的规则写入（自带 → journeyRules → slug）；planned 不写', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [
      record({ id: 'own', journeyId: 'kept' }),
      record({ id: 'rule', trip_title: 'Ring Road 2025' }),
      record({ id: 'slug', trip_title: 'Winter Trip' }),
      record({ id: 'fallback', trip_title: undefined, country_en: 'Iceland', year: 2024 }),
      record({ id: 'planned', status: 'planned', trip_title: 'Ring Road later' }),
    ],
    display: { journeyRules: [{ includes: ['Ring'], id: 'ring-road' }] },
  }))
  assert.deepEqual(canonical.travel.records.map((item) => item.journeyId), ['kept', 'ring-road', 'winter-trip', 'iceland-2024', undefined])
})

test('记录：去掉五个名称 / 代码字段，其余事实字段（含未知字段）与自身坐标原样保留', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [{ ...record({ id: 'a', notes: 'n', region: 'R', travelCategory: 'transit', hiddenFromHome: false }), custom: 1 } as never],
  }))
  assert.deepEqual(canonical.travel.records[0], {
    id: 'a',
    start_date: '2025-06-01',
    year: 2025,
    trip_title: '2025 North Atlantic Demo',
    status: 'visited',
    lat: 64.1466,
    lng: -21.9426,
    notes: 'n',
    region: 'R',
    travelCategory: 'transit',
    hiddenFromHome: false,
    custom: 1,
    placeId: 'iceland__reykjavik',
    journeyId: '2025-north-atlantic-demo',
  })
  assert.deepEqual(canonical.travel.meta, {
    schemaVersion: 1,
    generatedAt: '2026-01-01',
    privacyLevel: 'local-only',
  })
  assert.equal(canonical.travel.source, 'local')
})

// ---------------------------------------------------------------------------
// editor-state v2
// ---------------------------------------------------------------------------

test('editor-state：v2 形态，键与值都是地点 id；解析不了时为空状态', () => {
  const editorState = {
    schemaVersion: 1,
    addedCountries: [{ id: 'greenland', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'gl', centerLat: 72, centerLng: -40, visitedDate: '2024-05-01' }],
    countryOrder: ['greenland', 'iceland'],
    hiddenCountryIds: ['x'],
    cityOrderByCountry: { iceland: ['iceland__vik', 'iceland__reykjavik'] },
    hiddenCityIds: ['iceland__vik'],
    mediaOrderByCity: { iceland__reykjavik: ['m2', 'm1'] },
    hiddenMediaIds: ['m3'],
    coverMediaByCity: { iceland__reykjavik: 'm2' },
    droneOrderByCity: { iceland__reykjavik: ['d1'] },
    hiddenDroneMediaIds: ['d2'],
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
  const canonical = legacyAdapter(rawInputs({ records: [record({ id: 'a' })], editorState }))
  assert.deepEqual(canonical.editorState, {
    schemaVersion: 2,
    addedCountries: [{ placeId: 'greenland', visitedDate: '2024-05-01' }],
    countryOrder: ['greenland', 'iceland'],
    hiddenCountryIds: ['x'],
    cityOrderByCountry: { iceland: ['iceland__vik', 'iceland__reykjavik'] },
    hiddenCityIds: ['iceland__vik'],
    mediaOrderByCity: { iceland__reykjavik: ['m2', 'm1'] },
    hiddenMediaIds: ['m3'],
    coverMediaByCity: { iceland__reykjavik: 'm2' },
    droneOrderByCity: { iceland__reykjavik: ['d1'] },
    hiddenDroneMediaIds: ['d2'],
    updatedAt: '2026-01-02T00:00:00.000Z',
  })

  const invalid = legacyAdapter(rawInputs({ records: [], editorState: { schemaVersion: 3 } }))
  assert.deepEqual(invalid.editorState, {
    schemaVersion: 2,
    addedCountries: [],
    countryOrder: [],
    hiddenCountryIds: [],
    cityOrderByCountry: {},
    hiddenCityIds: [],
    mediaOrderByCity: {},
    hiddenMediaIds: [],
    coverMediaByCity: {},
    droneOrderByCity: {},
    hiddenDroneMediaIds: [],
  })
})

// ---------------------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------------------

const photo = (overrides: Record<string, unknown>) => ({
  id: 'm1',
  kind: 'photo',
  scope: 'city',
  countryId: 'iceland',
  countryName: 'Iceland',
  cityId: 'iceland__reykjavik',
  cityName: 'Reykjavik',
  src: '/media/m1.jpg',
  originalFileName: 'm1.jpg',
  isCover: false,
  status: 'ready',
  ...overrides,
})

test('媒体：逐条校验，坏条目跳过并写进 problems（只写序号与原因，不写内容）', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [record({ id: 'a' })],
    mediaCatalog: {
      schemaVersion: 2,
      items: [
        photo({ id: 'ok' }),
        null,
        'secret-string',
        [],
        photo({ id: undefined }),
        photo({ id: '' }),
        photo({ id: 'bad-kind', kind: 'sticker' }),
        photo({ id: 'no-city', cityId: undefined }),
        photo({ id: 'empty-city', cityId: '' }),
        photo({ id: 'ok2' }),
      ],
    },
  }))
  assert.deepEqual(canonical.media.items.map((item) => item.id), ['ok', 'ok2'])
  assert.deepEqual(canonical.media.problems, [
    '第 2 条媒体记录不是一个对象，已跳过。',
    '第 3 条媒体记录不是一个对象，已跳过。',
    '第 4 条媒体记录不是一个对象，已跳过。',
    '第 5 条媒体记录缺少 id，已跳过。',
    '第 6 条媒体记录缺少 id，已跳过。',
    '第 7 条媒体记录的 kind 不是 photo / panorama360 / aerialPhoto / video 之一，已跳过。',
    '第 8 条媒体记录缺少 cityId，已跳过。',
    '第 9 条媒体记录缺少 cityId，已跳过。',
  ])
  assert.doesNotMatch(canonical.media.problems.join('\n'), /secret|bad-kind|no-city/)
})

test('媒体：引用城市地点，去掉国家 id / 名称，标题改为 LocalizedText；悬空引用保留', () => {
  const canonical = legacyAdapter(rawInputs({
    records: [record({ id: 'a' })],
    mediaCatalog: {
      schemaVersion: 1,
      items: [
        photo({ id: 'titled', titleZh: '港口', titleEn: 'Harbour', custom: true }),
        photo({ id: 'en-only', titleEn: 'Only', titleZh: '' }),
        photo({ id: 'dangling', countryId: 'atlantis', cityId: 'atlantis__city', cityName: 'Lost' }),
      ],
    },
  }))
  assert.deepEqual(canonical.media.items, [
    {
      id: 'titled', kind: 'photo', scope: 'city', src: '/media/m1.jpg', originalFileName: 'm1.jpg', isCover: false, status: 'ready', custom: true,
      placeId: 'iceland__reykjavik', title: { names: { 'zh-Hans': '港口', en: 'Harbour' } },
    },
    {
      id: 'en-only', kind: 'photo', scope: 'city', src: '/media/m1.jpg', originalFileName: 'm1.jpg', isCover: false, status: 'ready',
      placeId: 'iceland__reykjavik', title: { names: { en: 'Only' } },
    },
    {
      id: 'dangling', kind: 'photo', scope: 'city', src: '/media/m1.jpg', originalFileName: 'm1.jpg', isCover: false, status: 'ready',
      placeId: 'atlantis__city',
    },
  ])
  assert.equal(hasPlace(canonical, 'atlantis__city'), false)
  assert.deepEqual(canonical.media.problems, [])
})

test('媒体：不是媒体目录（schemaVersion 不对或没有 items）时为空，不报 problem（与今天一致）', () => {
  for (const mediaCatalog of [undefined, null, { schemaVersion: 3, items: [null] }, { schemaVersion: 2 }]) {
    const canonical = legacyAdapter(rawInputs({ records: [], mediaCatalog }))
    assert.deepEqual(canonical.media, { items: [], problems: [] })
  }
})

test('公开样例：来源、元数据、显示规则与想去原样进入 Canonical', () => {
  const canonical = legacyAdapter(sampleRaw())
  assert.equal(canonical.travel.source, 'sample')
  assert.equal(canonical.wantToGo.source, 'sample')
  assert.equal(canonical.wantToGo.items.length, 3)
  assert.deepEqual(canonical.travel.display, {
    overviewTarget: { lat: 64, lng: -13 },
    homeHiddenCountryIds: [],
    originCountryIds: [],
    regionCountryIds: [],
    regionIncludes: [],
    navigationHiddenCityIds: [],
  })
  // 想去的阿克雷里（IS）挂在唯一的足迹国家 iceland 下；努克、特罗姆瑟没有足迹国家。
  assert.deepEqual(
    canonical.wantToGo.items.map((item) => placeOf(canonical, item.placeId).partOf),
    ['iso:GL', 'iso:NO', 'iceland'],
  )
  assert.equal(NOW, sampleRaw().now)
})
