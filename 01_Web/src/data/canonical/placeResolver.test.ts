/**
 * 地点解析（canonical/placeResolver.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.2、§3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 第 2A 批删除了按名字「恰好一个就复用」的 `resolveCity` 与城市匹配键：它们的用例按新规则（`findCityCandidates`：
 * 名字只找候选，不决定身份）改写，旧断言与新断言的对照写在各用例的注释里。最后一个测试沿用 PR3a 的对拍数据
 * （旧 id 空间的 Canonical，PR5b 起冻结在 ./frozen.fixture.ts），改为断言每个想去城市在足迹城市里的候选。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { legacyIdCanonical, type LegacyIdCanonicalName } from './frozen.fixture.ts'
import {
  asCountryCode,
  STRONG_CANDIDATE_MAX_KM,
  distanceKm,
  findCityCandidates,
  resolveCountry,
} from './placeResolver.ts'
import type { CanonicalData, CanonicalPlace } from './types.ts'

/** 雷克雅未克的坐标（公开地理事实）。 */
const REYKJAVIK = { lat: 64.1466, lng: -21.9426 }

const country = (id: string, iso: string | undefined, en: string, zh = en): CanonicalPlace => ({
  id,
  subtype: 'country',
  names: { 'zh-Hans': zh, en },
  ...(iso ? { externalIds: { iso3166Alpha2: iso } } : {}),
})

const city = (id: string, partOf: string, names: Record<string, string>): CanonicalPlace => ({ id, subtype: 'city', names, partOf })

const PLACES: CanonicalPlace[] = [
  country('c-is', 'IS', 'Iceland', '冰岛'),
  country('c-fo', 'FO', 'Faroe Islands', '法罗群岛'),
  country('c-none', undefined, 'Nowhere'),
  city('t-reykjavik', 'c-is', { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }),
  city('t-vik-zh', 'c-is', { 'zh-Hans': '维克' }),
  city('t-torshavn', 'c-fo', { 'zh-Hans': '托尔斯港', en: 'Tórshavn' }),
  city('t-lonely', 'c-none', { 'zh-Hans': '某地', en: 'Somewhere' }),
]

// ---------------------------------------------------------------------------
// resolveCountry
// ---------------------------------------------------------------------------

test('resolveCountry：恰好一个 → found（代码不分大小写）', () => {
  assert.deepEqual(resolveCountry(PLACES, 'IS'), { status: 'found', place: PLACES[0] })
  assert.deepEqual(resolveCountry(PLACES, ' is '), { status: 'found', place: PLACES[0] })
})

test('resolveCountry：没有 → none（包括代码不是两位字母、只有城市带这个代码）', () => {
  assert.deepEqual(resolveCountry(PLACES, 'NO'), { status: 'none' })
  assert.deepEqual(resolveCountry(PLACES, ''), { status: 'none' })
  assert.deepEqual(resolveCountry(PLACES, 'ISL'), { status: 'none' })
  const cityWithIso: CanonicalPlace = { ...city('x', 'c-is', { en: 'X' }), externalIds: { iso3166Alpha2: 'NO' } }
  assert.deepEqual(resolveCountry([...PLACES, cityWithIso], 'NO'), { status: 'none' })
})

test('resolveCountry：多于一个 → ambiguous，列出全部候选', () => {
  const places = [...PLACES, country('c-is-2', 'IS', 'Iceland (copy)')]
  assert.deepEqual(resolveCountry(places, 'is'), { status: 'ambiguous', candidates: ['c-is', 'c-is-2'] })
})

// ---------------------------------------------------------------------------
// 旧 resolveCity 的用例，按新规则改写（findCityCandidates）
// ---------------------------------------------------------------------------

const idsOf = (candidates: { placeId: string }[]) => candidates.map((candidate) => candidate.placeId)

test('改写自「resolveCity：恰好一个 → found」：同名只得到候选，不再直接复用；中文名不同、英文名相同是候选但不是强候选', () => {
  // 旧：四种输入都 found 并直接复用雷克雅未克 / 维克。新：都只是候选，由用户选择。
  for (const names of [{ zh: '雷克雅未克', en: 'Reykjavik' }, { zh: '另一个写法', en: 'REYKJAVIK' }, { en: ' reykjavik! ' }]) {
    assert.deepEqual(idsOf(findCityCandidates(PLACES, 'c-is', names)), ['t-reykjavik'], JSON.stringify(names))
  }
  // 旧断言把「中文名不同、英文名相同」也当成同一个城市；新规则：是候选，但不是强候选（坐标再近也不是）。
  const located = PLACES.map((place) => (place.id === 't-reykjavik' ? { ...place, location: { ...REYKJAVIK } } : place))
  assert.equal(findCityCandidates(located, 'c-is', { zh: '另一个写法', en: 'REYKJAVIK' }, REYKJAVIK)[0].strong, false)
  assert.equal(findCityCandidates(located, 'c-is', { zh: '雷克雅未克', en: 'Reykjavik' }, REYKJAVIK)[0].strong, true)
  // 城市地点只有中文名：按中文名是候选（旧规则「英文名缺时按中文名」）。
  assert.deepEqual(idsOf(findCityCandidates(PLACES, 'c-is', { zh: '维克' })), ['t-vik-zh'])
  assert.deepEqual(idsOf(findCityCandidates(PLACES, 'c-is', { zh: '维克', en: '维克' })), ['t-vik-zh'])
})

test('改写自「resolveCity：没有 → none」：别的国家、变音符不同、countryId 不是国家、名字为空时仍没有候选；两处按新规则变成候选', () => {
  assert.deepEqual(findCityCandidates(PLACES, 'c-fo', { zh: '雷克雅未克', en: 'Reykjavik' }), [], '别的国家的同名城市')
  assert.deepEqual(findCityCandidates(PLACES, 'c-fo', { en: 'Torshavn' }), [], 'slugify 保留变音符')
  assert.deepEqual(findCityCandidates(PLACES, 'c-is', { en: 'Reykjavík' }), [])
  assert.deepEqual(findCityCandidates(PLACES, 'missing', { en: 'Reykjavik' }), [])
  assert.deepEqual(findCityCandidates(PLACES, 't-reykjavik', { en: 'Reykjavik' }), [], 'countryId 必须是国家地点')
  assert.deepEqual(findCityCandidates(PLACES, 'c-is', { zh: '', en: '---' }), [])
  // 旧：英文名在时只按英文名，中文名相同也算「没有」（于是新建一个同名地点）。新：中文名相同就是候选。
  assert.deepEqual(idsOf(findCityCandidates(PLACES, 'c-is', { zh: '维克', en: 'Vik' })), ['t-vik-zh'])
  // 旧：国家没有 ISO 时没有匹配键，一律新建。新：国家的身份是地点 id，照样找候选。
  assert.deepEqual(idsOf(findCityCandidates(PLACES, 'c-none', { en: 'Somewhere' })), ['t-lonely'])
})

test('改写自「resolveCity：多于一个 → ambiguous」：列出全部候选（不按距离猜），按规则排序', () => {
  const places = [
    ...PLACES,
    { ...city('t-reykjavik-2', 'c-is', { 'zh-Hans': '雷克雅未克市', en: 'reykjavik' }), location: { lat: REYKJAVIK.lat, lng: REYKJAVIK.lng } },
  ]
  // 旧：{ status: 'ambiguous', candidates: ['t-reykjavik', 't-reykjavik-2'] }。新：同样两个候选，都不是强候选（输入没有坐标）。
  const candidates = findCityCandidates(places, 'c-is', { en: 'Reykjavik' })
  assert.deepEqual(idsOf(candidates), ['t-reykjavik', 't-reykjavik-2'])
  assert.deepEqual(candidates.map((candidate) => candidate.strong), [false, false])
  // 输入带坐标时，名字一致、坐标相同的强候选排在前面。
  assert.deepEqual(idsOf(findCityCandidates(places, 'c-is', { en: 'Reykjavik' }, REYKJAVIK)), ['t-reykjavik-2', 't-reykjavik'])
})

// ---------------------------------------------------------------------------
// 国家代码与距离
// ---------------------------------------------------------------------------

test('国家代码：两位字母才算，统一大写（改写自「城市匹配键」：匹配键与 placeTitle 已随 resolveCity 删除）', () => {
  assert.equal(asCountryCode(' is '), 'IS')
  assert.equal(asCountryCode('isl'), undefined)
  assert.equal(asCountryCode(''), undefined)
  assert.equal(asCountryCode(undefined), undefined)
})

test('distanceKm：同一点为 0；同一经线上纬度相差 1 度约 111 km', () => {
  assert.equal(distanceKm(REYKJAVIK, REYKJAVIK), 0)
  const km = distanceKm({ lat: 64, lng: -21 }, { lat: 65, lng: -21 })
  assert.ok(km > 111 && km < 112, String(km))
})

// ---------------------------------------------------------------------------
// findCityCandidates（第 2A 批）：名字和坐标只用来找候选
// ---------------------------------------------------------------------------

/** 江苏苏州与安徽宿州的坐标（公开地理事实），两地相距约 400 km，英文名都是 Suzhou。 */
const SUZHOU_JS = { lat: 31.2989, lng: 120.5853 }
const SUZHOU_AH = { lat: 33.6461, lng: 116.9641 }

const CN_PLACES: CanonicalPlace[] = [
  country('c-cn', 'CN', 'China', '中国'),
  country('c-jp', 'JP', 'Japan', '日本'),
  { ...city('t-suzhou-js', 'c-cn', { 'zh-Hans': '苏州', en: 'Suzhou' }), location: { ...SUZHOU_JS } },
]

const candidateIds = (candidates: ReturnType<typeof findCityCandidates>) => candidates.map((candidate) => candidate.placeId)

test('findCityCandidates：同名远距离（苏州 / 宿州都叫 Suzhou）→ 是候选，但不是强候选；带上地点名称与距离', () => {
  const [suzhou] = findCityCandidates(CN_PLACES, 'c-cn', { zh: '宿州', en: 'Suzhou' }, SUZHOU_AH)
  assert.equal(suzhou.placeId, 't-suzhou-js')
  assert.equal(suzhou.strong, false)
  assert.deepEqual(suzhou.names, { 'zh-Hans': '苏州', en: 'Suzhou' })
  assert.ok(suzhou.distanceKm !== undefined && suzhou.distanceKm > 350 && suzhou.distanceKm < 500, String(suzhou.distanceKm))
  // 名字完全一致、坐标远：仍然只是候选。
  assert.equal(findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_AH)[0].strong, false)
})

test('findCityCandidates：同名近距离、名字完全一致 → 强候选（不分大小写与标点）', () => {
  const nearby = { lat: SUZHOU_JS.lat + 0.1, lng: SUZHOU_JS.lng }
  assert.deepEqual(findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: ' suzhou! ' }, nearby).map(({ placeId, strong }) => ({ placeId, strong })), [
    { placeId: 't-suzhou-js', strong: true },
  ])
  assert.equal(findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS)[0].distanceKm, 0)
})

test('findCityCandidates：距离门限是具名常量（≤ 50 km 才是强候选）', () => {
  assert.equal(STRONG_CANDIDATE_MAX_KM, 50)
  const north = (degrees: number) => ({ lat: SUZHOU_JS.lat + degrees, lng: SUZHOU_JS.lng })
  assert.equal(findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Suzhou' }, north(0.44))[0].strong, true, '约 49 km')
  assert.equal(findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Suzhou' }, north(0.46))[0].strong, false, '约 51 km')
})

test('findCityCandidates：只有中文名相同、英文名不同 → 是候选，但不是强候选；只比双方都有的语言', () => {
  const [byZh] = findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Soochow' }, SUZHOU_JS)
  assert.equal(byZh.placeId, 't-suzhou-js')
  assert.equal(byZh.strong, false)
  // 输入只给了英文名：只比英文名，名字一致、坐标近 → 强候选。
  assert.equal(findCityCandidates(CN_PLACES, 'c-cn', { en: 'Suzhou' }, SUZHOU_JS)[0].strong, true)
  // 地点只有英文名：同样只比英文名。
  const enOnly = [...CN_PLACES.slice(0, 2), { ...city('t-en-only', 'c-cn', { en: 'Suzhou' }), location: { ...SUZHOU_JS } }]
  assert.equal(findCityCandidates(enOnly, 'c-cn', { zh: '宿州', en: 'Suzhou' }, SUZHOU_JS)[0].strong, true)
  // 两种语言的名字都不同：不是候选。
  assert.deepEqual(findCityCandidates(CN_PLACES, 'c-cn', { zh: '宿州', en: 'Suzhou City' }, SUZHOU_JS), [])
})

test('findCityCandidates：没有坐标（任一方）→ 是候选，但不是强候选，也没有距离', () => {
  for (const candidates of [
    findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Suzhou' }),
    findCityCandidates([...CN_PLACES.slice(0, 2), city('t-suzhou-js', 'c-cn', { 'zh-Hans': '苏州', en: 'Suzhou' })], 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS),
  ]) {
    assert.deepEqual(candidates, [{ placeId: 't-suzhou-js', names: { 'zh-Hans': '苏州', en: 'Suzhou' }, strong: false }])
  }
})

test('findCityCandidates：approximate 坐标（地点或输入）→ 不是强候选', () => {
  const approximatePlace = [...CN_PLACES.slice(0, 2), { ...city('t-suzhou-js', 'c-cn', { 'zh-Hans': '苏州', en: 'Suzhou' }), location: { ...SUZHOU_JS, approximate: true as const } }]
  const [fromPlace] = findCityCandidates(approximatePlace, 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS)
  assert.equal(fromPlace.strong, false)
  assert.equal(fromPlace.distanceKm, 0, '距离照样给出')
  assert.equal(findCityCandidates(CN_PLACES, 'c-cn', { zh: '苏州', en: 'Suzhou' }, { ...SUZHOU_JS, approximate: true })[0].strong, false)
})

test('findCityCandidates：只在这个国家的城市里找；countryId 不是国家、输入的名字为空时没有候选', () => {
  const places = [
    ...CN_PLACES,
    { ...city('t-suzhou-jp', 'c-jp', { 'zh-Hans': '苏州', en: 'Suzhou' }), location: { ...SUZHOU_JS } },
    { id: 'c-suzhou-country', subtype: 'country' as const, names: { 'zh-Hans': '苏州', en: 'Suzhou' }, partOf: 'c-cn' },
  ]
  assert.deepEqual(candidateIds(findCityCandidates(places, 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS)), ['t-suzhou-js'])
  assert.deepEqual(candidateIds(findCityCandidates(places, 'c-jp', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS)), ['t-suzhou-jp'])
  assert.deepEqual(findCityCandidates(places, 't-suzhou-js', { en: 'Suzhou' }), [], 'countryId 必须是国家地点')
  assert.deepEqual(findCityCandidates(places, 'missing', { en: 'Suzhou' }), [])
  assert.deepEqual(findCityCandidates(places, 'c-cn', { zh: '', en: '---' }), [])
  assert.deepEqual(findCityCandidates(places, 'c-cn', {}), [])
  // 国家没有 ISO 也照样按 countryId 找（身份是 id，不是国家代码）。
  const noIso = [country('c-none', undefined, 'Nowhere'), city('t-lonely', 'c-none', { 'zh-Hans': '某地', en: 'Somewhere' })]
  assert.deepEqual(candidateIds(findCityCandidates(noIso, 'c-none', { en: 'somewhere' })), ['t-lonely'])
})

test('findCityCandidates：排序稳定——强候选在前，再按距离升序（没有距离的在后），再按地点 id；与注册表顺序无关', () => {
  const near = (id: string, degrees: number, names: Record<string, string> = { 'zh-Hans': '苏州', en: 'Suzhou' }): CanonicalPlace =>
    ({ ...city(id, 'c-cn', names), location: { lat: SUZHOU_JS.lat + degrees, lng: SUZHOU_JS.lng } })
  const places: CanonicalPlace[] = [
    CN_PLACES[0],
    city('t-b-none', 'c-cn', { en: 'Suzhou' }),
    near('t-far', 3),
    near('t-strong-2', 0.2),
    city('t-a-none', 'c-cn', { 'zh-Hans': '苏州' }),
    near('t-zh-only', 0.01, { 'zh-Hans': '苏州', en: 'Soochow' }),
    near('t-strong-1', 0.1),
    near('t-strong-1b', 0.1),
  ]
  const expected = ['t-strong-1', 't-strong-1b', 't-strong-2', 't-zh-only', 't-far', 't-a-none', 't-b-none']
  assert.deepEqual(candidateIds(findCityCandidates(places, 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS)), expected)
  assert.deepEqual(candidateIds(findCityCandidates([...places].reverse(), 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS)), expected)
  assert.deepEqual(findCityCandidates(places, 'c-cn', { zh: '苏州', en: 'Suzhou' }, SUZHOU_JS).map((candidate) => candidate.strong),
    [true, true, true, false, false, false, false])
})

// ---------------------------------------------------------------------------
// 对拍数据：想去城市在足迹城市里的候选（改写自「resolveCity 复用的足迹城市」）
// ---------------------------------------------------------------------------

/** 把每个想去城市按名称与坐标拿去足迹地点里找候选（V2 写入「按名字新增想去」的判断）。强候选标 `(strong)`。 */
const candidatePairs = (canonical: CanonicalData) => {
  const footprint = canonical.places.filter((place) => place.legacyKeys !== undefined)
  const placeById = new Map(canonical.places.map((place) => [place.id, place]))
  return canonical.wantToGo.items.flatMap((item) => {
    const place = placeById.get(item.placeId)
    if (place?.subtype !== 'city' || place.partOf === undefined) return []
    return findCityCandidates(footprint, place.partOf, { zh: place.names['zh-Hans'], en: place.names.en }, place.location)
      .map((candidate) => `${candidate.placeId} ← ${item.id}${candidate.strong ? ' (strong)' : ''}`)
  }).sort()
}

test('PR3a 的对拍数据：想去城市在足迹城市里的候选（旧期望值的每一对仍是候选，另有两对只按中文名相同的新候选）', () => {
  // 最后一份：足迹有雷克雅未克、维克（只有中文名）、胡萨维克（Húsavík）、托尔斯港（Tórshavn）；想去有
  // 小写的 reykjavik、英文名写成中文的维克、不带变音符的 Husavik、带变音符的 Tórshavn（FO 与 DK 各一条）。
  const fixtures: [string, LegacyIdCanonicalName][] = [
    ['公开样例', 'sample'],
    ['个人模式', 'personal'],
    ['疑似重复', 'duplicate'],
    ['大小写、变音符、只有中文名', 'caseAndDiacritic'],
  ]
  // 旧期望值（resolveCity 直接复用的足迹城市）：阿克雷里两份；疑似重复为空；最后一份是 tórshavn、reykjavik、维克三对。
  // 新期望值：这些对全部是候选，而且名字一致、坐标相近，都是强候选（界面默认选中）。另外两对是新增的普通候选：
  // 疑似重复里的「雷克雅未克 / Reykjavik City」与最后一份的「胡萨维克 / Husavik」，都是中文名相同、英文名不同——
  // 旧规则只比英文名，会悄悄新建一个同名地点；新规则列为候选，不是强候选（不预选）。
  const expected: string[][] = [
    ['iceland__akureyri ← wtg_2026-08-12_akureyri (strong)'],
    ['iceland__akureyri ← wtg_2026-08-12_akureyri (strong)'],
    ['iceland__reykjavik ← w_reykjavik_city'],
    [
      'faroe-islands__tórshavn ← w_torshavn_accent (strong)',
      'iceland__húsavík ← w_husavik_plain',
      'iceland__reykjavik ← w_reykjavik_lower (strong)',
      'iceland__维克 ← w_vik_zh (strong)',
    ],
  ]
  fixtures.forEach(([name, key], index) => {
    assert.deepEqual(candidatePairs(legacyIdCanonical(key)), expected[index], name)
  })
})
