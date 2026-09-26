/**
 * 迁移规划（migration/planMigration.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.4、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 所有用例用确定的 UUID 序列（`sequentialUuids`）与固定时间，结果可逐字节复现。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { queryVisiblePlaces } from '../../worldgraph/query.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import { NOW, consistentPersonalRaw, nameInconsistencyRaw, record, sampleRaw } from '../canonical/legacy.fixture.ts'
import { legacyAdapter } from '../canonical/legacyAdapter.ts'
import { reconstructWantToGoItem, indexPlaces } from '../canonical/reconstruct.ts'
import type { CanonicalData, CanonicalPlace } from '../canonical/types.ts'
import { isUuidV7 } from '../canonical/uuidv7.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { validateV2Files } from '../canonical/v2Schema.ts'
import { parseIdentityManifest } from './identityFiles.ts'
import {
  HAFNARFJORDUR,
  PLAN_NOW,
  REYKJAVIK,
  SOURCE_HASH,
  autoMergeRaw,
  decisions,
  duplicateRaw,
  husavikRecord,
  personalRaw,
  plan,
  reykjavikRecord,
  vikRecord,
  wantToGoItem,
} from './migration.fixture.ts'
import { planFromCanonical, type MigrationErrorCode, type MigrationPlan } from './planMigration.ts'

const placeNamed = (data: CanonicalData, en: string, subtype?: 'country' | 'city') =>
  data.places.find((place) => place.names.en === en && (subtype === undefined || place.subtype === subtype))

const errorCodes = (result: MigrationPlan) => result.report.errors.map((error) => error.code)

const assertError = (result: MigrationPlan, code: MigrationErrorCode) =>
  assert.ok(errorCodes(result).includes(code), `期望 ${code}，实际：${errorCodes(result).join(', ') || '无'}`)

/** A′ ≡ B：两层 shadow compare 都通过。 */
const assertShadowPasses = (result: MigrationPlan, name = '') => {
  assert.equal(result.report.shadow.ran, true, name)
  assert.deepEqual(result.report.shadow.canonical, { equal: true, total: 0, paths: [] }, name)
  assert.deepEqual(result.report.shadow.derived, { equal: true, total: 0, paths: [] }, name)
}

const SCHEMA_VERSION_ONLY = { equal: false, total: 1, paths: ['$.modules.travelAtlas.travelAtlasMeta.schemaVersion'] }

/** 想去条目在 L′ 里指向的地点（旧 id）。 */
const wantToGoPlaceOf = (result: MigrationPlan, itemId: string) =>
  result.canonical.applied.wantToGo.items.find((item) => item.id === itemId)!.placeId

// ---------------------------------------------------------------------------
// 1. 公开样例
// ---------------------------------------------------------------------------

test('公开样例：canApply；阿克雷里静默合并；格陵兰、挪威成为正式国家；4 个国家、7 个城市', () => {
  const result = plan(sampleRaw())
  const { report } = result
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.needsDecision, [])
  assert.equal(report.canApply, true)
  assert.ok(result.files)

  assert.deepEqual(report.merges, [{
    subtype: 'city',
    from: 'wtg:wtg_2026-08-12_akureyri',
    into: 'iceland__akureyri',
    rule: 'mergeKey',
    status: 'silent',
    confirmations: [],
  }])

  const applied = result.canonical.applied
  const countries = applied.places.filter((place) => place.subtype === 'country')
  const cities = applied.places.filter((place) => place.subtype === 'city')
  assert.deepEqual(countries.map((place) => [place.id, place.externalIds?.iso3166Alpha2, place.names]), [
    ['iceland', 'IS', { 'zh-Hans': '冰岛', en: 'Iceland' }],
    ['faroe-islands', 'FO', { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' }],
    ['iso:GL', 'GL', { 'zh-Hans': '格陵兰', en: 'Greenland' }],
    ['iso:NO', 'NO', { 'zh-Hans': '挪威', en: 'Norway' }],
  ])
  assert.deepEqual(cities.map((place) => place.names.en), ['Reykjavik', 'Vik', 'Akureyri', 'Torshavn', 'Gjogv', 'Nuuk', 'Tromsø'])
  assert.equal(cities.filter((place) => place.legacyKeys !== undefined).length, 5)
  assert.equal(wantToGoPlaceOf(result, 'wtg_2026-08-12_akureyri'), 'iceland__akureyri')

  // 计数：迁移前 12 个地点（想去的阿克雷里单独一个），迁移后 11 个。
  assert.equal(report.counts.before.places, 12)
  assert.equal(report.counts.after.places, 11)
  assert.equal(report.counts.after.countries, 4)
  assert.equal(report.counts.after.cities, 7)
  assert.equal(result.canonical.applied.travel.meta.schemaVersion, 2)

  // A′ ≡ B；A 与 A′ 只差 travelAtlasMeta.schemaVersion（阿克雷里的名称与坐标两边相同，合并看不出来）。
  assertShadowPasses(result)
  assert.deepEqual(report.aVsAPrime, SCHEMA_VERSION_ONLY)
})

test('公开样例：M 的地点 id 都是 UUIDv7，legacyKeys 带命名空间；写出的文件通过校验，读回与 M 深度相等', () => {
  const result = plan(sampleRaw())
  const migrated = result.canonical.migrated!
  assert.ok(migrated.places.every((place) => isUuidV7(place.id)))
  assert.deepEqual(migrated.places.filter((place) => place.legacyKeys).map((place) => place.legacyKeys), [
    ['country:iceland'], ['country:faroe-islands'],
    ['city:iceland__reykjavik'], ['city:iceland__vik'], ['city:iceland__akureyri'], ['city:faroe-islands__torshavn'], ['city:faroe-islands__gjogv'],
  ])
  assert.equal(migrated.travel.source, 'local')
  assert.equal(migrated.wantToGo.source, 'local')
  assert.deepEqual(validateV2Files(result.files!), [])
  assert.deepStrictEqual(readV2(JSON.parse(JSON.stringify(result.files))), migrated)
  assert.deepEqual(result.report.roundTrip, { ran: true, diff: { equal: true, total: 0, paths: [] } })

  // 来源键：足迹为 <subtype>:<旧 id>，想去与 iso: 为旧 id 本身。
  assert.deepEqual(result.report.places.map((place) => place.sourceKey), [
    'country:iceland', 'country:faroe-islands',
    'city:iceland__reykjavik', 'city:iceland__vik', 'city:iceland__akureyri', 'city:faroe-islands__torshavn', 'city:faroe-islands__gjogv',
    'iso:GL', 'wtg:wtg_2026-08-12_nuuk', 'iso:NO', 'wtg:wtg_2026-08-12_tromso',
  ])
  // 文件级元数据：想去文件与足迹文件的原值。
  assert.equal(result.files!.wantToGo.generated_at, '2026-08-12T00:00:00.000Z')
  assert.equal(result.files!.wantToGo.privacy_level, 'public-sample')
  assert.equal(result.files!.travel.generated_at, '2026-08-12')
  assert.equal(result.files!.places.generated_at, PLAN_NOW)
})

// ---------------------------------------------------------------------------
// 2. 自动合并的三种情况
// ---------------------------------------------------------------------------

test('自动合并：静默、nameDifference、coordinateDifference（含足迹城市没有坐标）；未确认时 canApply 为 false', () => {
  const result = plan(autoMergeRaw())
  const { report } = result
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.merges.map((merge) => [merge.from, merge.into, merge.status, merge.confirmations]), [
    ['wtg:w_reykjavik', 'iceland__reykjavik', 'silent', []],
    ['wtg:w_vik', 'iceland__vik', 'pending', ['nameDifference']],
    ['wtg:w_husavik', 'iceland__husavik', 'pending', ['coordinateDifference']],
    ['wtg:w_akureyri', 'iceland__akureyri', 'pending', ['coordinateDifference']],
  ])
  assert.deepEqual(report.needsDecision.map((item) => [item.kind, item.key, item.decision]), [
    ['nameDifference', 'wtg:w_vik', undefined],
    ['coordinateDifference', 'wtg:w_husavik', undefined],
    ['coordinateDifference', 'wtg:w_akureyri', undefined],
  ])
  const husavik = report.needsDecision[1]
  assert.ok(husavik.distanceKm! > 4.9 && husavik.distanceKm! < 5.1, String(husavik.distanceKm))
  assert.equal(report.needsDecision[2].intoHasLocation, false)
  assert.equal(report.canApply, false)
  // 未确认只是不能 apply，不是错误：文件照样产出，合并照样出现在 L′ 里。
  assert.ok(result.files)
  assert.equal(wantToGoPlaceOf(result, 'w_vik'), 'iceland__vik')
})

test('自动合并：全部 accept 后 canApply；存活地点用足迹的名称与坐标，足迹没有坐标时用想去的', () => {
  const result = plan(autoMergeRaw(), {
    decisions: decisions({
      nameDifferences: { 'wtg:w_vik': 'accept' },
      coordinateDifferences: { 'wtg:w_husavik': 'accept', 'wtg:w_akureyri': 'accept' },
    }),
  })
  assert.deepEqual(result.report.errors, [])
  assert.equal(result.report.canApply, true)
  assert.ok(result.report.merges.every((merge) => merge.status !== 'pending'))

  const applied = result.canonical.applied
  const places = indexPlaces(applied.places)
  const item = (id: string) => reconstructWantToGoItem(applied.wantToGo.items.find((entry) => entry.id === id)!, places)
  assert.equal(item('w_vik').place.nameZh, '维克')
  assert.deepEqual([item('w_husavik').place.lat, item('w_husavik').place.lng], [66.0449, -17.3389])
  assert.deepEqual(placeNamed(applied, 'Akureyri')!.location, { lat: 65.6885, lng: -18.1262 })
  assert.equal(applied.places.filter((place) => place.subtype === 'city').length, 4)
  assertShadowPasses(result)
  // A 与 A′ 的差异就是这些合并带来的显示变化：想去条目换成足迹的名称与坐标、阿克雷里有了坐标。
  const paths = result.report.aVsAPrime.paths
  for (const expected of [
    '$.modules.travelAtlas.cityById.iceland__akureyri.lat',
    '$.modules.wantToGo.wantToGoItems[1].place.nameZh',
    '$.modules.wantToGo.wantToGoItems[2].place.lat',
  ]) assert.ok(paths.includes(expected), expected)
})

test('自动合并：想去没有坐标、名称相同 → 静默；足迹与想去都没有坐标 → 静默', () => {
  const result = plan(personalRaw({
    records: [reykjavikRecord(), record({ id: 'r_akureyri', city: '阿克雷里', city_en: 'Akureyri', start_date: '2025-06-04', lat: null, lng: null })],
    wantToGo: [
      wantToGoItem('w_reykjavik', { nameZh: '雷克雅未克', nameEn: 'Reykjavik', countryCode: 'is' }),
      wantToGoItem('w_akureyri', { nameZh: '阿克雷里', nameEn: 'Akureyri', countryCode: 'IS' }),
    ],
  }))
  assert.deepEqual(result.report.merges.map((merge) => merge.status), ['silent', 'silent'])
  assert.equal(result.report.canApply, true)
})

// ---------------------------------------------------------------------------
// 3. 疑似重复
// ---------------------------------------------------------------------------

test('疑似重复：同国家内中文名相同或相距 ≤ 10 km 才列出，键为 wtg:<条目>|city:<足迹城市>；未决定时 canApply 为 false', () => {
  const { report } = plan(duplicateRaw())
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.merges, [])
  assert.deepEqual(report.needsDecision.map((item) => [item.key, item.reasons]), [
    ['wtg:w_reykjavik_city|city:iceland__reykjavik', ['sameNameZh', 'within10Km']],
    ['wtg:w_reykjavik_city|city:iceland__hafnarfjordur', ['within10Km']],
    ['wtg:w_gardabaer|city:iceland__reykjavik', ['within10Km']],
    ['wtg:w_gardabaer|city:iceland__hafnarfjordur', ['within10Km']],
  ])
  assert.ok(report.needsDecision.every((item) => item.kind === 'duplicate' && item.options.join() === 'merge,separate'))
  assert.equal(report.canApply, false)
})

test('疑似重复：merge 并入足迹城市（接受它的名称与坐标，不再另列名称 / 坐标差异）；separate 保持两个地点', () => {
  const allDecided = (reykjavikCity: 'merge' | 'separate') => decisions({
    duplicates: {
      'wtg:w_reykjavik_city|city:iceland__reykjavik': reykjavikCity,
      'wtg:w_reykjavik_city|city:iceland__hafnarfjordur': 'separate',
      'wtg:w_gardabaer|city:iceland__reykjavik': 'separate',
      'wtg:w_gardabaer|city:iceland__hafnarfjordur': 'separate',
    },
  })

  const merged = plan(duplicateRaw(), { decisions: allDecided('merge') })
  assert.deepEqual(merged.report.errors, [])
  assert.equal(merged.report.canApply, true)
  assert.deepEqual(merged.report.merges, [{
    subtype: 'city', from: 'wtg:w_reykjavik_city', into: 'iceland__reykjavik', rule: 'duplicate', status: 'accepted', confirmations: ['duplicate'],
  }])
  assert.ok(merged.report.needsDecision.every((item) => item.kind === 'duplicate'))
  const places = indexPlaces(merged.canonical.applied.places)
  const item = reconstructWantToGoItem(merged.canonical.applied.wantToGo.items[0], places)
  assert.deepEqual([item.place.nameZh, item.place.nameEn, item.place.lat, item.place.lng], ['雷克雅未克', 'Reykjavik', REYKJAVIK.lat, REYKJAVIK.lng])
  assertShadowPasses(merged)

  const separate = plan(duplicateRaw(), { decisions: allDecided('separate') })
  assert.equal(separate.report.canApply, true)
  assert.deepEqual(separate.report.merges, [])
  assert.equal(wantToGoPlaceOf(separate, 'w_reykjavik_city'), 'wtg:w_reykjavik_city')
  assert.equal(separate.canonical.applied.places.length, merged.canonical.applied.places.length + 1)
  assertShadowPasses(separate)
  assert.deepEqual(separate.report.aVsAPrime, SCHEMA_VERSION_ONLY)
})

test('疑似重复：一个想去地点被决定并入两个足迹城市 → E_DECISION_CONFLICT，不合并，不产出文件', () => {
  const result = plan(duplicateRaw(), {
    decisions: decisions({
      duplicates: {
        'wtg:w_gardabaer|city:iceland__reykjavik': 'merge',
        'wtg:w_gardabaer|city:iceland__hafnarfjordur': 'merge',
      },
    }),
  })
  assertError(result, 'E_DECISION_CONFLICT')
  const conflict = result.report.errors.find((error) => error.code === 'E_DECISION_CONFLICT')!
  assert.deepEqual(conflict.ids, ['wtg:w_gardabaer|city:iceland__reykjavik', 'wtg:w_gardabaer|city:iceland__hafnarfjordur'])
  assert.equal(result.report.merges.some((merge) => merge.from === 'wtg:w_gardabaer'), false)
  assert.equal(result.files, undefined)
  assert.equal(result.report.canApply, false)
  assert.equal(result.report.roundTrip.ran, false)
})

test('自动合并的想去地点不再列为疑似重复；用不上的决定列为提示', () => {
  const result = plan(personalRaw({
    records: [reykjavikRecord(), record({ id: 'r_hafnarfjordur', city: '哈夫纳峡湾', city_en: 'Hafnarfjordur', start_date: '2025-06-05', ...HAFNARFJORDUR })],
    wantToGo: [wantToGoItem('w_reykjavik', { nameZh: '雷克雅未克', nameEn: 'Reykjavik', countryCode: 'IS', ...REYKJAVIK })],
  }), { decisions: decisions({ nameDifferences: { 'wtg:typo': 'accept' } }) })
  assert.deepEqual(result.report.needsDecision, [])
  assert.deepEqual(result.report.info.find((entry) => entry.code === 'I_UNUSED_DECISION')?.ids, ['nameDifferences:wtg:typo'])
})

// ---------------------------------------------------------------------------
// 4. 国家
// ---------------------------------------------------------------------------

/** 足迹国家没有代码，但编辑器手动添加国家的条目有：提升后 iso:GL 并入它。 */
const greenlandRaw = (withAddedCountry: boolean) => personalRaw({
  records: [record({ id: 'r_ilulissat', country: '格陵兰', country_en: 'Greenland', country_code: undefined, city: '伊卢利萨特', city_en: 'Ilulissat', start_date: '2025-07-01', lat: 69.2198, lng: -51.0986 })],
  wantToGo: [wantToGoItem('w_nuuk', { nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.1814, lng: -51.6941 })],
  editorState: {
    schemaVersion: 1,
    addedCountries: withAddedCountry
      ? [{ id: 'greenland', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'gl', centerLat: 72, centerLng: -40, region: 'Arctic' }]
      : [],
  },
})

test('国家：addedCountries 的代码提升到地点上，消除 E_COUNTRY_ISO_MISSING；iso:<CC> 并入同代码的足迹国家', () => {
  const without = plan(greenlandRaw(false))
  assertError(without, 'E_COUNTRY_ISO_MISSING')
  assert.deepEqual(without.report.errors.find((error) => error.code === 'E_COUNTRY_ISO_MISSING')!.ids, ['greenland'])
  assert.equal(without.files, undefined)

  const legacy = legacyAdapter(greenlandRaw(true))
  assert.equal(legacy.editorState.addedCountries[0].countryCode, 'gl')
  assert.equal(legacy.places.find((place) => place.id === 'wtg:w_nuuk')!.partOf, 'iso:GL')

  const result = plan(greenlandRaw(true))
  assert.deepEqual(result.report.errors, [])
  assert.equal(result.report.canApply, true)
  assert.deepEqual(result.report.info.find((entry) => entry.code === 'I_ADDED_COUNTRY_PROMOTED')?.ids, ['greenland'])
  const applied = result.canonical.applied
  assert.equal(applied.places.find((place) => place.id === 'greenland')!.externalIds?.iso3166Alpha2, 'GL')
  assert.deepEqual(applied.editorState.addedCountries, [{ placeId: 'greenland', region: 'Arctic' }])
  assert.deepEqual(result.report.merges, [{ subtype: 'country', from: 'iso:GL', into: 'greenland', rule: 'isoCountry', status: 'silent', confirmations: [] }])
  assert.equal(applied.places.find((place) => place.id === 'wtg:w_nuuk')!.partOf, 'greenland')
  assert.equal(applied.places.some((place) => place.id === 'iso:GL'), false)
  assertShadowPasses(result)
})

test('国家：addedCountries 的中心坐标在地点没有坐标时提升；条目不再带代码与中心', () => {
  const result = plan(personalRaw({
    records: [reykjavikRecord()],
    editorState: {
      schemaVersion: 1,
      addedCountries: [{ id: 'norway', nameZh: '挪威', nameEn: 'Norway', countryCode: 'no', centerLat: 64.5, centerLng: 11.5 }],
    },
  }))
  // 独立的手动添加国家：代码与中心坐标本来就在地点上，条目里没有，不需要提升。
  assert.equal(result.report.info.some((entry) => entry.code === 'I_ADDED_COUNTRY_PROMOTED'), false)
  assert.deepEqual(result.canonical.applied.places.find((place) => place.id === 'norway')!.location, { lat: 64.5, lng: 11.5 })

  // 与足迹国家同键、足迹国家没有坐标：条目的中心坐标提升到地点上。
  const promoted = plan(personalRaw({
    records: [record({ id: 'r_x', city: '雷克雅未克', city_en: 'Reykjavik', start_date: '2025-06-01', lat: null, lng: null })],
    editorState: {
      schemaVersion: 1,
      addedCountries: [{ id: 'iceland', nameZh: '冰岛', nameEn: 'Iceland', countryCode: 'is', centerLat: 65, centerLng: -18 }],
    },
  }))
  assert.equal(legacyAdapter(personalRaw({
    records: [record({ id: 'r_x', start_date: '2025-06-01', lat: null, lng: null })],
    editorState: { schemaVersion: 1, addedCountries: [{ id: 'iceland', nameZh: '冰岛', nameEn: 'Iceland', countryCode: 'is', centerLat: 65, centerLng: -18 }] },
  })).editorState.addedCountries[0].center?.lat, 65)
  assert.deepEqual(promoted.report.info.find((entry) => entry.code === 'I_ADDED_COUNTRY_PROMOTED')?.ids, ['iceland'])
  assert.deepEqual(promoted.canonical.applied.places.find((place) => place.id === 'iceland')!.location, { lat: 65, lng: -18 })
  assert.deepEqual(promoted.canonical.applied.editorState.addedCountries, [{ placeId: 'iceland' }])
})

test('国家：想去国家并入同 ISO 的足迹国家（名称相同静默、不同需确认）；想去国家之间互相合并，iso: 并入想去国家', () => {
  const raw = personalRaw({
    records: [reykjavikRecord(), record({ id: 'r_torshavn', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn', start_date: '2025-06-06', lat: 62.0079, lng: -6.79 })],
    wantToGo: [
      wantToGoItem('w_iceland', { kind: 'country', nameZh: '冰岛', nameEn: 'Iceland', countryCode: 'IS', lat: 65, lng: -18 }),
      wantToGoItem('w_faroes', { kind: 'country', nameZh: '法罗', nameEn: 'Faroes', countryCode: 'FO' }),
      wantToGoItem('w_norway', { kind: 'country', nameZh: '挪威', nameEn: 'Norway', countryCode: 'NO', lat: 64.5, lng: 11.5 }),
      wantToGoItem('w_tromso', { nameZh: '特罗姆瑟', nameEn: 'Tromsø', countryCode: 'NO', lat: 69.6492, lng: 18.9553 }),
      wantToGoItem('w_norway_again', { kind: 'country', nameZh: '挪威王国', nameEn: 'Norway', countryCode: 'NO' }),
    ],
  })
  const result = plan(raw)
  assert.deepEqual(result.report.errors, [])
  assert.deepEqual(result.report.merges.map((merge) => [merge.from, merge.into, merge.rule, merge.status]), [
    ['wtg:w_iceland', 'iceland', 'wantToGoCountry', 'silent'],
    ['wtg:w_faroes', 'faroe-islands', 'wantToGoCountry', 'pending'],
    ['iso:NO', 'wtg:w_norway', 'isoCountry', 'silent'],
    ['wtg:w_norway_again', 'wtg:w_norway', 'wantToGoCountry', 'pending'],
  ])
  assert.deepEqual(result.report.needsDecision.map((item) => [item.kind, item.key, item.subtype]), [
    ['nameDifference', 'wtg:w_faroes', 'country'],
    ['nameDifference', 'wtg:w_norway_again', 'country'],
  ])
  const applied = result.canonical.applied
  assert.equal(wantToGoPlaceOf(result, 'w_iceland'), 'iceland')
  assert.equal(wantToGoPlaceOf(result, 'w_norway_again'), 'wtg:w_norway')
  assert.equal(applied.places.find((place) => place.id === 'wtg:w_tromso')!.partOf, 'wtg:w_norway')
  assert.deepEqual(applied.places.filter((place) => place.subtype === 'country').map((place) => place.id), ['iceland', 'faroe-islands', 'wtg:w_norway'])

  const accepted = plan(raw, { decisions: decisions({ nameDifferences: { 'wtg:w_faroes': 'accept', 'wtg:w_norway_again': 'accept' } }) })
  assert.equal(accepted.report.canApply, true)
  assertShadowPasses(accepted)
})

// ---------------------------------------------------------------------------
// 5. 每个错误码至少一例
// ---------------------------------------------------------------------------

test('E_MIXED_VERSIONS：旧位置出现 V2 版本或未知版本的文件', () => {
  const editorV2 = personalRaw({ records: [reykjavikRecord()], editorState: { schemaVersion: 2 } })
  const result = plan(editorV2)
  assertError(result, 'E_MIXED_VERSIONS')
  assert.deepEqual(result.report.errors[0].ids, ['editor-state'])

  const travelV2 = personalRaw({ records: [reykjavikRecord()], mediaCatalog: { schemaVersion: 3, items: [] } })
  travelV2.travelMap.schema_version = 2
  const mixed = plan(travelV2)
  assert.deepEqual(mixed.report.errors.find((error) => error.code === 'E_MIXED_VERSIONS')!.ids, ['travel-map', 'user-media'])
  assert.equal(mixed.files, undefined)

  // null 与不存在一样按空处理。
  assert.deepEqual(plan(personalRaw({ records: [reykjavikRecord()], editorState: null, mediaCatalog: null })).report.errors, [])
})

test('E_WTG_PROBLEMS 与 E_MEDIA_INVALID：被跳过的坏条目迁移后会丢', () => {
  const result = plan(personalRaw({
    records: [reykjavikRecord()],
    wantToGo: [wantToGoItem('w_bad', { nameZh: '坏', nameEn: '', countryCode: 'IS' })],
    mediaCatalog: { schemaVersion: 2, items: [null] },
  }))
  assertError(result, 'E_WTG_PROBLEMS')
  assertError(result, 'E_MEDIA_INVALID')
})

test('E_MEDIA_DANGLING：媒体引用的城市不存在', () => {
  const result = plan(consistentPersonalRaw({ withDanglingMedia: true }))
  assertError(result, 'E_MEDIA_DANGLING')
  assert.deepEqual(result.report.errors.find((error) => error.code === 'E_MEDIA_DANGLING')!.ids, ['photo-ghost-1'])
})

test('E_PLACE_NAME_MISSING：地点没有任何名称', () => {
  const result = plan(personalRaw({ records: [record({ id: 'r_nameless', country: '', country_en: '', country_code: 'xa', city: '', city_en: '', start_date: '2025-06-01' })] }))
  assertError(result, 'E_PLACE_NAME_MISSING')
  assert.deepEqual(result.report.errors.find((error) => error.code === 'E_PLACE_NAME_MISSING')!.ids, ['unknown-country', 'unknown-country__r-nameless'])
})

test('E_COUNTRY_ISO_DUPLICATE：两个足迹国家的 ISO 相同', () => {
  const result = plan(personalRaw({
    records: [
      record({ id: 'r_1', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Torshavn', start_date: '2025-06-06' }),
      record({ id: 'r_2', country: '法羅群島', country_en: 'Faeroe Islands', country_code: 'FO', city: '克拉克斯维克', city_en: 'Klaksvik', start_date: '2025-06-07' }),
    ],
  }))
  assertError(result, 'E_COUNTRY_ISO_DUPLICATE')
  assert.deepEqual(result.report.errors[0].ids, ['faroe-islands', 'faeroe-islands'])
})

test('E_ROUNDTRIP：记录缺少 lat / lng 两个键、而城市有坐标——V2 无法区分「省略」与「缺少」', () => {
  const missingKeys = reykjavikRecord({ id: 'r_missing', start_date: '2025-06-02' }) as Record<string, unknown>
  delete missingKeys.lat
  delete missingKeys.lng
  const result = plan(personalRaw({ records: [reykjavikRecord(), missingKeys as never] }))
  assertError(result, 'E_ROUNDTRIP')
  assert.deepEqual(result.report.errors.find((error) => error.code === 'E_ROUNDTRIP')!.ids, ['$.travel.records[1].lat', '$.travel.records[1].lng'])
  assert.equal(result.files, undefined)
})

test('E_DUPLICATE_LEGACY_KEY：两个地点带同一个 legacy key（Legacy Adapter 产不出来，直接构造 L）', () => {
  const legacy = legacyAdapter(autoMergeRaw())
  const vik = legacy.places.find((place) => place.id === 'iceland__vik')!
  vik.legacyKeys = ['iceland__vik', 'iceland__reykjavik']
  const result = planFromCanonical({ legacy, fileMeta: {}, sourceHash: SOURCE_HASH, newId: sequentialUuids(), now: PLAN_NOW })
  assertError(result, 'E_DUPLICATE_LEGACY_KEY')
  assert.equal(errorCodes(result).includes('E_INVALID_OUTPUT'), false)
})

test('E_INVALID_OUTPUT：写出的文件没通过校验（国家代码不是两个字母）', () => {
  const result = plan(personalRaw({ records: [reykjavikRecord({ country_code: 'isl' })] }))
  assertError(result, 'E_INVALID_OUTPUT')
  assert.ok(result.report.errors.find((error) => error.code === 'E_INVALID_OUTPUT')!.ids.some((id) => id.includes('iso3166Alpha2')))
})

test('E_SHADOW_CANONICAL 与 E_SHADOW_DERIVED：迁移清单把两个来源键映射到同一个 UUID（手改的清单）', () => {
  const first = plan(sampleRaw())
  const sources = { ...first.manifest.sources, 'country:faroe-islands': first.manifest.sources['country:iceland'] }
  const result = plan(sampleRaw(), { manifest: { schema_version: 1, sources } })
  assertError(result, 'E_INVALID_OUTPUT')
  assertError(result, 'E_SHADOW_CANONICAL')
  assertError(result, 'E_SHADOW_DERIVED')
  assert.equal(result.report.canApply, false)
  assert.equal(result.files, undefined)
})

test('E_SHADOW_DERIVED 单独出现：旧国家键是数组下标形式（"2024"），旧派生按对象键遍历会把它排到最前，UUID 不会', () => {
  const result = plan(personalRaw({
    records: [reykjavikRecord(), record({ id: 'r_numeric', country: '2024', country_en: '2024', country_code: 'xa', city: '某城', city_en: 'Somewhere', start_date: '2025-06-02', lat: 10, lng: 10 })],
  }))
  assert.deepEqual(errorCodes(result), ['E_SHADOW_DERIVED'])
  assert.deepEqual(result.report.shadow.canonical, { equal: true, total: 0, paths: [] })
  assert.ok(result.report.errors[0].ids.includes('$.modules.travelAtlas.countries[0].id'))
})

test('E_INVALID_OUTPUT：迁移清单里的值不是 UUIDv7', () => {
  const result = plan(sampleRaw(), { manifest: { schema_version: 1, sources: { 'country:iceland': 'iceland' } } })
  assertError(result, 'E_INVALID_OUTPUT')
})

// ---------------------------------------------------------------------------
// 6.（提升见上面的「国家」用例）悬空的 editor-state 引用
// ---------------------------------------------------------------------------

test('editor-state 里指向不存在地点的键与值被删除，记 I_STALE_EDITOR_REF', () => {
  const result = plan(personalRaw({
    records: [reykjavikRecord(), vikRecord()],
    editorState: {
      schemaVersion: 1,
      countryOrder: ['atlantis', 'iceland'],
      hiddenCityIds: ['iceland__vik', 'atlantis__ghost'],
      cityOrderByCountry: { iceland: ['iceland__vik', 'iceland__gone'], atlantis: ['atlantis__ghost'] },
      coverMediaByCity: { atlantis__ghost: 'photo-1' },
    },
  }))
  assert.deepEqual(result.report.errors, [])
  const state = result.canonical.applied.editorState
  assert.deepEqual(state.countryOrder, ['iceland'])
  assert.deepEqual(state.hiddenCityIds, ['iceland__vik'])
  assert.deepEqual(state.cityOrderByCountry, { iceland: ['iceland__vik'] })
  assert.deepEqual(state.coverMediaByCity, {})
  assert.deepEqual(result.report.info.find((entry) => entry.code === 'I_STALE_EDITOR_REF')!.ids, [
    'cityOrderByCountry:atlantis',
    'cityOrderByCountry.iceland:iceland__gone',
    'countryOrder:atlantis',
    'hiddenCityIds:atlantis__ghost',
    'coverMediaByCity:atlantis__ghost',
  ])
  assert.deepEqual(validateV2Files(result.files!), [])
})

// ---------------------------------------------------------------------------
// 7. 迁移清单
// ---------------------------------------------------------------------------

test('迁移清单：两次 dry-run 分配的 UUID 相同；第二次不再分配；清单记录本次 sourceHash', () => {
  const first = plan(sampleRaw())
  const manifest = parseIdentityManifest(JSON.parse(JSON.stringify(first.manifest)))
  assert.equal(manifest.sourceHash, SOURCE_HASH)
  assert.equal(manifest.plannedAt, PLAN_NOW)
  assert.equal(Object.keys(manifest.sources).length, 11)

  const second = plan(sampleRaw(), { manifest, newId: sequentialUuids(Date.UTC(2030, 0, 1)), sourceHash: 'changed' })
  assert.deepEqual(second.report.places.map((place) => place.newId), first.report.places.map((place) => place.newId))
  assert.ok(second.report.places.every((place) => !place.allocated))
  assert.deepEqual(second.manifest.sources, first.manifest.sources)
  assert.equal(second.manifest.sourceHash, 'changed')
  assert.deepEqual(second.files, first.files)
})

test('迁移清单：改 decisions 不影响已分配的 UUID；清单只增不改，用不上的条目也保留', () => {
  const separateAll = decisions({
    duplicates: {
      'wtg:w_reykjavik_city|city:iceland__reykjavik': 'separate',
      'wtg:w_reykjavik_city|city:iceland__hafnarfjordur': 'separate',
      'wtg:w_gardabaer|city:iceland__reykjavik': 'separate',
      'wtg:w_gardabaer|city:iceland__hafnarfjordur': 'separate',
    },
  })
  const first = plan(duplicateRaw(), { decisions: separateAll })
  const reykjavikCityId = first.manifest.sources['wtg:w_reykjavik_city']
  assert.ok(isUuidV7(reykjavikCityId))

  const withExtra = { ...first.manifest, sources: { ...first.manifest.sources, 'city:gone__away': '019b76da-a8ff-7000-8000-0000000000ff' } }
  const mergeDecisions = decisions({ duplicates: { ...separateAll.duplicates, 'wtg:w_reykjavik_city|city:iceland__reykjavik': 'merge' } })
  const merged = plan(duplicateRaw(), { manifest: withExtra, decisions: mergeDecisions, newId: () => assert.fail('不应分配新 id') })
  assert.equal(merged.report.canApply, true)
  assert.deepEqual(merged.manifest.sources, withExtra.sources)
  const byOld = new Map(merged.report.places.map((place) => [place.oldId, place.newId]))
  for (const place of first.report.places) {
    if (byOld.has(place.oldId)) assert.equal(byOld.get(place.oldId), place.newId, place.oldId)
  }
  assert.equal(byOld.has('wtg:w_reykjavik_city'), false)

  // 改回 separate：同一个想去地点拿回同一个 UUID。
  const again = plan(duplicateRaw(), { manifest: merged.manifest, decisions: separateAll, newId: () => assert.fail('不应分配新 id') })
  assert.equal(again.report.places.find((place) => place.oldId === 'wtg:w_reykjavik_city')!.newId, reykjavikCityId)
})

// ---------------------------------------------------------------------------
// 8. 合并键对拍：今天地图上真的合并的 ⇔ 规划判为自动合并
// ---------------------------------------------------------------------------

/** 今天地图（足迹 + 想去都可见）上并进足迹城市的想去条目：[足迹城市 id, 想去条目 id]。 */
const mapMergedPairs = (canonical: CanonicalData) => {
  const data = deriveAppDataFromCanonical(canonical, { now: NOW })
  const snapshot = data.worldGraph.worldGraphSnapshot
  const itemIdOf = new Map(snapshot.entities.map((entity) => [entity.id, entity.metadata.wantToGoId as string | undefined]))
  const { places } = queryVisiblePlaces(snapshot, ['travel', 'want_to_go'])
  return places
    .filter((place) => place.layerIds.includes('travel'))
    .flatMap((place) => (place.mergedEntityIds ?? []).map((entityId) => `${place.sourceId} ← ${itemIdOf.get(entityId)}`))
    .sort()
}

const plannedMergePairs = (result: MigrationPlan) => {
  const itemsByPlace = new Map<string, string[]>()
  for (const item of result.canonical.legacy.wantToGo.items) itemsByPlace.set(item.placeId, [...(itemsByPlace.get(item.placeId) ?? []), item.id])
  return result.report.merges
    .filter((merge) => merge.rule === 'mergeKey')
    .flatMap((merge) => (itemsByPlace.get(merge.from) ?? []).map((itemId) => `${merge.into} ← ${itemId}`))
    .sort()
}

test('合并键对拍：所有足迹城市与想去城市都在地图上时，queryVisiblePlaces 合并的正是规划判为自动合并的', () => {
  const fixtures: [string, ReturnType<typeof sampleRaw>][] = [
    ['公开样例', sampleRaw()],
    ['个人模式', consistentPersonalRaw()],
    ['疑似重复', duplicateRaw()],
    ['大小写、变音符、只有中文名', personalRaw({
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
    })],
  ]
  for (const [name, raw] of fixtures) {
    const result = plan(raw)
    const today = mapMergedPairs(result.canonical.legacy)
    assert.deepEqual(plannedMergePairs(result), today, name)
  }
  // 最后一个 fixture 里，大小写与「只有中文名」合并，变音符不合并（slugify 保留变音符）。
  const last = plan(fixtures[3][1])
  assert.deepEqual(plannedMergePairs(last), [
    'faroe-islands__tórshavn ← w_torshavn_accent',
    'iceland__reykjavik ← w_reykjavik_lower',
    'iceland__维克 ← w_vik_zh',
  ])
})

// ---------------------------------------------------------------------------
// 9. PR2 的两个个人模式 fixture
// ---------------------------------------------------------------------------

test('PR2 fixture：consistentPersonalRaw 与 nameInconsistencyRaw 都能 canApply，读回与 M 深度相等', () => {
  for (const [name, raw] of [['consistentPersonalRaw', consistentPersonalRaw()], ['nameInconsistencyRaw', nameInconsistencyRaw()]] as const) {
    const result = plan(raw)
    assert.deepEqual(result.report.errors, [], name)
    assert.equal(result.report.canApply, true, name)
    assert.deepStrictEqual(readV2(JSON.parse(JSON.stringify(result.files))), result.canonical.migrated, name)
    assertShadowPasses(result, name)
    assert.deepEqual(result.report.aVsAPrime, SCHEMA_VERSION_ONLY, name)
  }
  const inconsistent = plan(nameInconsistencyRaw())
  assert.ok(inconsistent.report.info.some((entry) => entry.code === 'I_NORMALIZE_suspectedSplitCity'))
  assert.ok(inconsistent.report.info.some((entry) => entry.code === 'I_NORMALIZE_countryCode'))
  assert.deepEqual(inconsistent.report.info.find((entry) => entry.code === 'I_PLACE_WITHOUT_EN')?.ids, ['iceland__维克镇'])
})

test('提示：没有坐标的城市、保留了自身坐标的记录、重复的想去条目 id 与疑似重复的想去地点', () => {
  const result = plan(personalRaw({
    records: [
      reykjavikRecord(),
      reykjavikRecord({ id: 'r_reykjavik_harbour', start_date: '2025-06-02', lat: 64.15, lng: -21.94 }),
      record({ id: 'r_nowhere', city: '无处', city_en: 'Nowhere', start_date: '2025-06-03', lat: null, lng: null }),
    ],
    wantToGo: [
      wantToGoItem('w_nuuk', { nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL' }),
      wantToGoItem('w_nuuk', { nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL' }),
    ],
  }))
  const idsOf = (code: string) => result.report.info.find((entry) => entry.code === code)?.ids
  assert.deepEqual(idsOf('I_CITY_WITHOUT_LOCATION'), ['iceland__nowhere', 'wtg:w_nuuk', 'wtg:w_nuuk#2'])
  assert.deepEqual(idsOf('I_RECORD_OWN_COORDINATES'), ['r_reykjavik_harbour'])
  assert.deepEqual(idsOf('I_WTG_DUPLICATE_ITEM_ID'), ['w_nuuk'])
  assert.deepEqual(idsOf('I_WTG_DUPLICATE'), ['wtg:w_nuuk | wtg:w_nuuk#2'])
})

test('规划不修改输入，也不读时钟与随机源：同样的输入两次结果逐字节相同', () => {
  const raw = autoMergeRaw()
  const before = JSON.stringify(raw)
  const first = plan(raw)
  assert.equal(JSON.stringify(raw), before)
  assert.equal(JSON.stringify(plan(autoMergeRaw())), JSON.stringify(first))
  const places: CanonicalPlace[] = first.canonical.legacy.places
  assert.ok(places.some((place) => place.id === 'wtg:w_vik'), '中间结果保留 L 原样')
})
