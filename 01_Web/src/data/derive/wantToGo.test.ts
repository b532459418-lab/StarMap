/**
 * 想去纯派生（derive/wantToGo.ts）的单元测试（RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 解析本身（parseWantToGoFile）由 Core 的 adapters/wantToGo.test.ts 覆盖，这里只测应用侧的派生。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import type { City, Country, TravelMapRecord } from '../../types/travel.ts'
import type { WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import { deriveWantToGo, plannedConvertBlockReason, type WantToGoTravelInput } from './wantToGo.ts'

const wantToGoSample = (): unknown =>
  JSON.parse(readFileSync(new URL('../want-to-go.sample.json', import.meta.url), 'utf8'))

const noTravel: WantToGoTravelInput = { cities: [], countryById: {}, plannedRecords: [] }

const rawItem = (id: string, place: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  place: { kind: 'city', nameZh: id, nameEn: id, countryCode: 'NO', lat: 60, lng: 10, ...place },
  addedAt: '2026-01-01',
  hidden: false,
  ...extra,
})

const file = (items: unknown[]) => ({ schema_version: 1, items })

const planned = (id: string, extra: Partial<TravelMapRecord> = {}): TravelMapRecord => ({
  id,
  country: '挪威',
  country_en: 'Norway',
  city: id,
  city_en: id,
  start_date: '2026-07-01',
  status: 'planned',
  lat: 60,
  lng: 5,
  ...extra,
})

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

test('来源 sample：解析调用方给的样例值', () => {
  const derived = deriveWantToGo({ source: 'sample', value: wantToGoSample() }, noTravel)
  assert.deepEqual(derived.wantToGoItems.map((item) => item.id), [
    'wtg_2026-08-12_nuuk',
    'wtg_2026-08-12_tromso',
    'wtg_2026-08-12_akureyri',
  ])
  assert.deepEqual(derived.wantToGoProblems, [])
  assert.deepEqual(derived.hiddenWantToGoItems, [])
})

test('来源 local：解析私有文件的值；文件级错误退化为空列表并写进 problems', () => {
  const derived = deriveWantToGo({ source: 'local', value: file([rawItem('a', {})]) }, noTravel)
  assert.deepEqual(derived.wantToGoItems.map((item) => item.id), ['a'])

  const broken = deriveWantToGo({ source: 'local', value: { schema_version: 2, items: [] } }, noTravel)
  assert.deepEqual(broken.wantToGoItems, [])
  assert.equal(broken.wantToGoProblems.length, 1)
  assert.match(broken.wantToGoProblems[0], /schema_version 不是 1/)
})

test('来源 none：不解析、不报 problem，即使给了值', () => {
  const derived = deriveWantToGo({ source: 'none', value: file([rawItem('a', {})]) }, noTravel)
  assert.deepEqual(derived.wantToGoItems, [])
  assert.deepEqual(derived.wantToGoProblems, [])
  assert.equal(derived.wantToGoItemByEntityId.size, 0)
})

test('坏条目进 problems，其余条目照常进入', () => {
  const derived = deriveWantToGo({
    source: 'local',
    value: file([
      rawItem('good', {}),
      { place: {} },
      rawItem('no-name', { nameEn: '' }),
      rawItem('bad-kind', { kind: 'region' }),
    ]),
  }, noTravel)
  assert.deepEqual(derived.wantToGoItems.map((item) => item.id), ['good'])
  assert.equal(derived.wantToGoProblems.length, 3)
  assert.match(derived.wantToGoProblems[0], /第 2 条想去记录缺少 id/)
  assert.match(derived.wantToGoProblems[1], /no-name.*缺少 place\.nameEn/)
  assert.match(derived.wantToGoProblems[2], /bad-kind.*place\.kind/)
})

// ---------------------------------------------------------------------------
// 隐藏条目与反查表
// ---------------------------------------------------------------------------

test('hiddenWantToGoItems 只含隐藏条目，按 addedAt 倒序；同一天保持原顺序', () => {
  const derived = deriveWantToGo({
    source: 'local',
    value: file([
      rawItem('old', {}, { hidden: true, addedAt: '2026-01-01' }),
      rawItem('visible', {}, { addedAt: '2026-06-01' }),
      rawItem('new', {}, { hidden: true, addedAt: '2026-03-01' }),
      rawItem('new-too', {}, { hidden: true, addedAt: '2026-03-01' }),
    ]),
  }, noTravel)
  assert.deepEqual(derived.hiddenWantToGoItems.map((item) => item.id), ['new', 'new-too', 'old'])
  // 原列表不被排序改动。
  assert.deepEqual(derived.wantToGoItems.map((item) => item.id), ['old', 'visible', 'new', 'new-too'])
})

test('wantToGoItemByEntityId：键是 place:wtg:<CC>:<slug(nameEn)>，同键第一条胜出', () => {
  const derived = deriveWantToGo({
    source: 'local',
    value: file([
      rawItem('first', { nameEn: 'Tromsø', countryCode: 'no' }),
      rawItem('second', { nameEn: 'TROMSØ', countryCode: 'NO' }),
      rawItem('other', { nameEn: 'Bergen' }),
    ]),
  }, noTravel)
  assert.deepEqual([...derived.wantToGoItemByEntityId].map(([key, item]) => [key, item.id]), [
    ['place:wtg:NO:tromsø', 'first'],
    ['place:wtg:NO:bergen', 'other'],
  ])
})

test('plannedRecordByEntityId：键是 place:planned:<record.id>，同 id 第一条胜出', () => {
  const first = planned('bergen', { notes: 'first' })
  const derived = deriveWantToGo({ source: 'none', value: undefined }, {
    ...noTravel,
    plannedRecords: [first, planned('bergen', { notes: 'second' }), planned('oslo')],
  })
  assert.deepEqual([...derived.plannedRecordByEntityId.keys()], ['place:planned:bergen', 'place:planned:oslo'])
  assert.equal(derived.plannedRecordByEntityId.get('place:planned:bergen'), first)
})

// ---------------------------------------------------------------------------
// 想去 → 足迹 的禁用原因
// ---------------------------------------------------------------------------

test('wantToGoConvertBlockReason：国家级、无坐标、已在足迹里三种文案；否则 undefined', () => {
  const cities: City[] = [
    { id: 'norway__tromso', nameEn: 'Tromsø', countryId: 'norway', lat: 69, lng: 18 },
    { id: 'nocode__city', nameEn: 'Bergen', countryId: 'nocode', lat: 60, lng: 5 },
    { id: 'orphan__city', nameEn: 'Oslo', lat: 59, lng: 10 },
  ]
  const countryById: Record<string, Country> = {
    norway: { id: 'norway', nameZh: '挪威', nameEn: 'Norway', centerLat: 0, centerLng: 0, visitedDateRange: '', summary: '', memory: '', cityIds: [], accent: '', flagCode: 'no' },
    nocode: { id: 'nocode', nameZh: '无代码', nameEn: 'Nocode', centerLat: 0, centerLng: 0, visitedDateRange: '', summary: '', memory: '', cityIds: [], accent: '' },
  }
  const derived = deriveWantToGo({ source: 'none', value: undefined }, { cities, countryById, plannedRecords: [] })
  const item = (place: Partial<WantToGoItem['place']>): WantToGoItem => ({
    id: 'x',
    place: { kind: 'city', nameZh: 'x', nameEn: 'x', countryCode: 'NO', lat: 1, lng: 2, ...place },
    addedAt: '2026-01-01',
    hidden: false,
  })

  assert.equal(derived.wantToGoConvertBlockReason(item({ kind: 'country' })), '整个国家的想去需要先具体到城市，暂不支持直接转为足迹。')
  assert.equal(derived.wantToGoConvertBlockReason(item({ lat: undefined })), '这个地点没有坐标，无法转为足迹。')
  assert.equal(derived.wantToGoConvertBlockReason(item({ lng: Number.NaN })), '这个地点没有坐标，无法转为足迹。')
  // 足迹城市键 = 国家 flagCode 大写 + slug(英文名)：大小写不同也算同一城市。
  assert.equal(
    derived.wantToGoConvertBlockReason(item({ nameEn: 'TROMSØ', countryCode: 'no' })),
    '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。',
  )
  // 足迹国家没有 flagCode、或城市没有 countryId 时无法比较，不预先禁用（交给端点）。
  assert.equal(derived.wantToGoConvertBlockReason(item({ nameEn: 'Bergen' })), undefined)
  assert.equal(derived.wantToGoConvertBlockReason(item({ nameEn: 'Oslo' })), undefined)
  assert.equal(derived.wantToGoConvertBlockReason(item({ nameEn: 'Tromsø', countryCode: 'SE' })), undefined)
  assert.equal(derived.plannedConvertBlockReason, plannedConvertBlockReason)
})

test('plannedConvertBlockReason：经纬度都是有限数才可转换', () => {
  assert.equal(plannedConvertBlockReason(planned('a')), undefined)
  assert.equal(plannedConvertBlockReason(planned('b', { lat: null })), '这条旅行计划没有坐标，无法转为足迹。')
  assert.equal(plannedConvertBlockReason(planned('c', { lng: Number.POSITIVE_INFINITY })), '这条旅行计划没有坐标，无法转为足迹。')
})
