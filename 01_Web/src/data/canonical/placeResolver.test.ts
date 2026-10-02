/**
 * 地点解析（canonical/placeResolver.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.2、§3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * PR3a 的迁移规划测试曾改为经本模块取合并键与距离（迁移工具与它的测试在 PR5b 删除）；
 * 这里另测两个解析函数。最后一个测试沿用 PR3a 的对拍数据（旧 id 空间的 Canonical，PR5b 起冻结在 ./frozen.fixture.ts）：
 * RFC-LOC-1 Core-A 之前它断言 `resolveCity` 复用的足迹城市正是地图按名字（FR-MR-5）并进的那些；Core-A 起地图按地点 id 合并，
 * 那次对拍的结果作为期望值冻结在这里。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { legacyIdCanonical, type LegacyIdCanonicalName } from './frozen.fixture.ts'
import {
  asCountryCode,
  cityMatchKeyOf,
  distanceKm,
  resolveCity,
  resolveCountry,
} from './placeResolver.ts'
import { placeTitle } from './reconstruct.ts'
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
// resolveCity
// ---------------------------------------------------------------------------

test('resolveCity：恰好一个 → found；英文名不分大小写与标点，英文名缺时按中文名', () => {
  const reykjavik = { status: 'found', place: PLACES[3] }
  assert.deepEqual(resolveCity(PLACES, 'c-is', { zh: '雷克雅未克', en: 'Reykjavik' }), reykjavik)
  assert.deepEqual(resolveCity(PLACES, 'c-is', { zh: '另一个写法', en: 'REYKJAVIK' }), reykjavik)
  assert.deepEqual(resolveCity(PLACES, 'c-is', { en: ' reykjavik! ' }), reykjavik)
  // 城市地点只有中文名；输入的英文名缺、或英文名写成同一个中文名，都按中文名取键。
  assert.deepEqual(resolveCity(PLACES, 'c-is', { zh: '维克' }), { status: 'found', place: PLACES[4] })
  assert.deepEqual(resolveCity(PLACES, 'c-is', { zh: '维克', en: '维克' }), { status: 'found', place: PLACES[4] })
})

test('resolveCity：没有 → none（别的国家的同名城市、变音符不同、国家没有 ISO、键为空）；不做模糊匹配', () => {
  assert.deepEqual(resolveCity(PLACES, 'c-fo', { zh: '雷克雅未克', en: 'Reykjavik' }), { status: 'none' })
  assert.deepEqual(resolveCity(PLACES, 'c-is', { zh: '维克', en: 'Vik' }), { status: 'none' }, '英文名在时按英文名，不回落到中文名')
  assert.deepEqual(resolveCity(PLACES, 'c-fo', { en: 'Torshavn' }), { status: 'none' }, 'slugify 保留变音符')
  assert.deepEqual(resolveCity(PLACES, 'c-none', { en: 'Somewhere' }), { status: 'none' }, '国家没有 ISO：没有合并键')
  assert.deepEqual(resolveCity(PLACES, 'missing', { en: 'Reykjavik' }), { status: 'none' })
  assert.deepEqual(resolveCity(PLACES, 't-reykjavik', { en: 'Reykjavik' }), { status: 'none' }, 'countryId 必须是国家地点')
  assert.deepEqual(resolveCity(PLACES, 'c-is', { zh: '', en: '---' }), { status: 'none' })
  assert.deepEqual(resolveCity(PLACES, 'c-is', { en: 'Reykjavík' }), { status: 'none' })
})

test('resolveCity：多于一个 → ambiguous，列出全部候选（不按距离猜）', () => {
  const places = [
    ...PLACES,
    { ...city('t-reykjavik-2', 'c-is', { 'zh-Hans': '雷克雅未克市', en: 'reykjavik' }), location: { lat: REYKJAVIK.lat, lng: REYKJAVIK.lng } },
  ]
  assert.deepEqual(resolveCity(places, 'c-is', { en: 'Reykjavik' }), { status: 'ambiguous', candidates: ['t-reykjavik', 't-reykjavik-2'] })
})

// ---------------------------------------------------------------------------
// 合并键与距离
// ---------------------------------------------------------------------------

test('城市匹配键：国家代码两位字母才算；title 取英文名，缺时取中文名；slug 为空时没有键', () => {
  assert.equal(asCountryCode(' is '), 'IS')
  assert.equal(asCountryCode('isl'), undefined)
  assert.equal(asCountryCode(''), undefined)
  assert.equal(asCountryCode(undefined), undefined)
  assert.equal(cityMatchKeyOf('IS', placeTitle(PLACES[3])), 'IS:reykjavik')
  assert.equal(cityMatchKeyOf('IS', placeTitle(PLACES[4])), 'IS:维克')
  assert.equal(cityMatchKeyOf(undefined, placeTitle(PLACES[3])), undefined)
  assert.equal(cityMatchKeyOf('IS', { zh: '', en: '' }), undefined)
  // 只有中文名的地点：标题的英文名用中文名（与 Core 地点实体的标题相同）。
  assert.deepEqual(placeTitle(PLACES[4]), { zh: '维克', en: '维克' })
})

test('distanceKm：同一点为 0；同一经线上纬度相差 1 度约 111 km', () => {
  assert.equal(distanceKm(REYKJAVIK, REYKJAVIK), 0)
  const km = distanceKm({ lat: 64, lng: -21 }, { lat: 65, lng: -21 })
  assert.ok(km > 111 && km < 112, String(km))
})

// ---------------------------------------------------------------------------
// 对拍数据：resolveCity 找到的足迹城市（冻结的期望值）
// ---------------------------------------------------------------------------

/** 把每个想去城市按名称拿去足迹地点里解析（V2 写入「新增想去」的判断），找到的就是它会复用的足迹城市。 */
const resolvedPairs = (canonical: CanonicalData) => {
  const footprint = canonical.places.filter((place) => place.legacyKeys !== undefined)
  const placeById = new Map(canonical.places.map((place) => [place.id, place]))
  return canonical.wantToGo.items.flatMap((item) => {
    const place = placeById.get(item.placeId)
    if (place?.subtype !== 'city' || place.partOf === undefined) return []
    const resolution = resolveCity(footprint, place.partOf, { zh: place.names['zh-Hans'], en: place.names.en })
    assert.notEqual(resolution.status, 'ambiguous', item.id)
    return resolution.status === 'found' ? [`${resolution.place.id} ← ${item.id}`] : []
  }).sort()
}

test('PR3a 的对拍数据：resolveCity 复用的足迹城市，等于 Core-A 之前地图按名字合并的结果（冻结的期望值）', () => {
  // 最后一份：足迹有雷克雅未克、维克（只有中文名）、胡萨维克（Húsavík）、托尔斯港（Tórshavn）；想去有
  // 小写的 reykjavik、英文名写成中文的维克、不带变音符的 Husavik、带变音符的 Tórshavn（FO 与 DK 各一条）。
  const fixtures: [string, LegacyIdCanonicalName][] = [
    ['公开样例', 'sample'],
    ['个人模式', 'personal'],
    ['疑似重复', 'duplicate'],
    ['大小写、变音符、只有中文名', 'caseAndDiacritic'],
  ]
  // Core-A 之前 `queryVisiblePlaces` 在这四份数据上（足迹 + 想去都可见）并进足迹城市的想去条目，与下面逐一相同。
  const expected: string[][] = [
    // 公开样例：阿克雷里（足迹与想去同名同坐标）是唯一的一对。
    ['iceland__akureyri ← wtg_2026-08-12_akureyri'],
    ['iceland__akureyri ← wtg_2026-08-12_akureyri'],
    [],
    // 最后一份：大小写与「只有中文名」合并，变音符与别的国家不合并。
    [
      'faroe-islands__tórshavn ← w_torshavn_accent',
      'iceland__reykjavik ← w_reykjavik_lower',
      'iceland__维克 ← w_vik_zh',
    ],
  ]
  fixtures.forEach(([name, key], index) => {
    assert.deepEqual(resolvedPairs(legacyIdCanonical(key)), expected[index], name)
  })
})
