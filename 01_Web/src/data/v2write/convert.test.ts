/**
 * 想去 / planned → 足迹的 V2 写入（v2write/convert.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.3、§2.4、§2.6、§3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readV2 } from '../canonical/v2Reader.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { convertToTravel } from './convert.ts'
import { addCountry } from './footprint.ts'
import { addWantToGo } from './wantToGo.ts'
import { emptyV2FilesForWrite } from './transaction.ts'
import {
  GHOST_ID,
  applyWrites,
  assertIntact,
  assertV2Error,
  migratedFiles,
  placeNamed,
  testContext,
  writeOrder,
} from './v2write.fixture.ts'

const NUUK_ITEM = 'wtg_2026-08-12_nuuk'

const fromWantToGo = (id: string, extra: Record<string, unknown> = {}) => ({ source: 'want-to-go', id, startDate: '2026-09-01', ...extra })

const recordById = (files: V2Files, id: string) => files.travel.records.find((record) => record.id === id) as V2TravelRecord

const sampleSouth = {
  place: { kind: 'city', nameZh: '示例南城', nameEn: 'SampleSouth', countryCode: 'IS', lat: 64, lng: -22 },
  note: '保留备注',
}

test('想去首次转为足迹：按国家 ISO 目录保存洲，保留地点和日期，不修改输入', () => {
  const ctx = testContext()
  const empty = emptyV2FilesForWrite(ctx.now)
  const added = addWantToGo(empty, sampleSouth, ctx)
  const files = applyWrites(empty, added.writes)
  const before = structuredClone(files)
  const outcome = convertToTravel(files, fromWantToGo(added.result.id, {
    startDate: '2026-10-03', endDate: '2026-10-04', keepWantToGo: false,
  }), ctx)
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.deepEqual(files, before)
  assert.deepEqual(next.places, files.places)
  assert.deepEqual(next.editorState.addedCountries, [{ placeId: outcome.result.countryId, region: 'Europe', visitedDate: '2026-10-03' }])
  assert.equal(next.wantToGo.items.length, 0)
  const record = recordById(next, outcome.result.travelRecordId)
  assert.deepEqual([record.start_date, record.end_date, record.placeId], ['2026-10-03', '2026-10-04', outcome.result.cityId])
  const atlas = deriveAppDataFromCanonical(readV2(next), { now: ctx.now.toISOString() }).travelAtlas
  assert.deepEqual(atlas.countryById[outcome.result.countryId].keywords, ['Europe'])
})

test('想去转足迹：已有用户国家信息不覆盖，保留想去时备注不变', () => {
  for (const hasVisitedDate of [true, false]) {
    const ctx = testContext()
    const empty = emptyV2FilesForWrite(ctx.now)
    let files = applyWrites(empty, addCountry(empty, { countryCode: 'IS', visitedDate: '2026-01-01' }, ctx).writes)
    files.editorState.addedCountries[0].region = 'User region'
    if (!hasVisitedDate) delete files.editorState.addedCountries[0].visitedDate
    const added = addWantToGo(files, sampleSouth, ctx)
    files = applyWrites(files, added.writes)
    const saved = structuredClone(files.editorState.addedCountries)
    const outcome = convertToTravel(files, fromWantToGo(added.result.id, { keepWantToGo: true }), ctx)
    const next = applyWrites(files, outcome.writes)
    assertIntact(next)
    assert.deepEqual(next.editorState.addedCountries, saved)
    assert.deepEqual(next.wantToGo.items, files.wantToGo.items)
    assert.equal(next.wantToGo.items[0].note, sampleSouth.note)
    assert.deepEqual(writeOrder(outcome.writes), ['travel'])
  }
})

test('想去转足迹：国家顺序已包含地点时，新增洲仍写 editor-state；目录缺失时保持未知', () => {
  const ctx = testContext()
  const empty = emptyV2FilesForWrite(ctx.now)
  const added = addWantToGo(empty, sampleSouth, ctx)
  const files = applyWrites(empty, added.writes)
  const iceland = placeNamed(files, 'Iceland').id
  files.editorState.countryOrder = [iceland]
  const outcome = convertToTravel(files, fromWantToGo(added.result.id), ctx)
  assert.deepEqual(writeOrder(outcome.writes), ['travel', 'wantToGo', 'editorState'])
  assert.deepEqual(applyWrites(files, outcome.writes).editorState.addedCountries, [{ placeId: iceland, region: 'Europe', visitedDate: '2026-09-01' }])
  const unknown = convertToTravel(files, fromWantToGo(added.result.id), { ...ctx, countryCatalog: new Map() })
  assert.deepEqual(writeOrder(unknown.writes), ['travel', 'wantToGo'])
  assert.deepEqual(applyWrites(files, unknown.writes).editorState.addedCountries, [])
})

// ---------------------------------------------------------------------------
// 想去 → 足迹
// ---------------------------------------------------------------------------

test('想去 → 足迹：地点就是 item.placeId；新记录带 journeyId；移除条目；国家首次进入足迹时重排（足迹 → 想去 → editor-state）', () => {
  const files = migratedFiles()
  const nuuk = placeNamed(files, 'Nuuk')
  const greenland = placeNamed(files, 'Greenland').id
  const outcome = convertToTravel(files, fromWantToGo(NUUK_ITEM, { endDate: '2026-09-03' }), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['travel', 'wantToGo', 'editorState'])
  assert.equal(outcome.writes[1].onFailure, '足迹已创建，但想去条目没有移除（{reason}）。可以在想去列表里隐藏或彻底删除它。')
  assert.equal(outcome.writes[2].onFailure, '足迹已创建，但国家列表的排序没有更新（{reason}）。')
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)

  const record = recordById(next, outcome.result.travelRecordId)
  assert.ok(typeof record.journeyId === 'string' && record.journeyId.startsWith('journey-'))
  assert.deepEqual(record, {
    id: record.id,
    placeId: nuuk.id,
    start_date: '2026-09-01',
    end_date: '2026-09-03',
    year: 2026,
    trip_title: '格陵兰 · 努克',
    type: 'visit',
    status: 'visited',
    source: 'local-editor',
    journeyId: record.journeyId,
  })
  assert.deepEqual(outcome.result, { travelRecordId: record.id, countryId: greenland, cityId: nuuk.id, wantToGoRemoved: true })
  assert.equal(next.wantToGo.items.some((item) => item.id === NUUK_ITEM), false)
  assert.ok(next.places.places.some((place) => place.id === nuuk.id), '地点仍被新记录引用')
  assert.deepEqual(next.editorState.countryOrder, [greenland, ...files.editorState.countryOrder])
  // 读回后记录坐标就是城市坐标。
  const read = readV2(next).travel.records.find((candidate) => candidate.id === record.id)!
  assert.deepEqual([read.lat, read.lng], [nuuk.location!.lat, nuuk.location!.lng])
})

test('想去 → 足迹：勾选「保留在想去」——条目保留，不写想去；行程标题与已去过的记录相同时沿用 journeyId', () => {
  const files = migratedFiles()
  const outcome = convertToTravel(files, fromWantToGo(NUUK_ITEM, { keepWantToGo: true, tripTitle: '2025 North Atlantic Demo' }), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['travel', 'editorState'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.equal(outcome.result.wantToGoRemoved, false)
  assert.ok(next.wantToGo.items.some((item) => item.id === NUUK_ITEM))
  assert.equal(recordById(next, outcome.result.travelRecordId).journeyId, '2025-north-atlantic-demo')
})

test('想去 → 足迹：国家已在足迹中时不重排，只写足迹与想去', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const selfoss = '019b76da-a8f3-7000-8000-0000000000f3'
  files.places.places.push({ id: selfoss, subtype: 'city', names: { 'zh-Hans': '塞尔福斯', en: 'Selfoss' }, partOf: iceland, location: { lat: 63.93, lng: -21.0 } })
  files.wantToGo.items.push({ id: 'w_selfoss', placeId: selfoss, addedAt: '2026-01-01', hidden: false })
  const outcome = convertToTravel(files, fromWantToGo('w_selfoss'), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['travel', 'wantToGo'])
  assertIntact(applyWrites(files, outcome.writes))
})

test('想去 → 足迹：拒绝沿用旧文案（整个国家、没有坐标、已隐藏、城市已在足迹、日期、找不到、来源、保留标志）', () => {
  const files = migratedFiles()
  const greenland = placeNamed(files, 'Greenland').id
  const iceland = placeNamed(files, 'Iceland').id
  const noLocation = '019b76da-a8f4-7000-8000-0000000000f4'
  files.places.places.push({ id: noLocation, subtype: 'city', names: { en: 'Ilulissat' }, partOf: greenland })
  files.wantToGo.items.push(
    { id: 'w_country', placeId: iceland, addedAt: '2026-01-01', hidden: false },
    { id: 'w_no_location', placeId: noLocation, addedAt: '2026-01-01', hidden: false },
  )
  const cases: [unknown, string, string][] = [
    [{ source: 'elsewhere' }, 'E_CONVERT_SOURCE_INVALID', '转换来源只能是 want-to-go 或 planned。'],
    [null, 'E_CONVERT_SOURCE_INVALID', '转换来源只能是 want-to-go 或 planned。'],
    [fromWantToGo(' '), 'E_REQUIRED', '请填写想去记录 id。'],
    [fromWantToGo(NUUK_ITEM, { keepWantToGo: 'yes' }), 'E_KEEP_WTG_NOT_BOOLEAN', '保留想去条目只能是 true 或 false。'],
    [fromWantToGo('missing'), 'E_WTG_NOT_FOUND', '找不到这条想去记录。'],
    [fromWantToGo('w_country'), 'E_CONVERT_COUNTRY_KIND', '整个国家的想去需要先具体到城市，暂不支持直接转为足迹。'],
    [fromWantToGo('w_no_location'), 'E_CONVERT_NO_COORDINATES', '这个地点没有坐标，无法转为足迹。'],
    [fromWantToGo('wtg_2026-08-12_tromso'), 'E_CONVERT_HIDDEN', '已隐藏的想去条目不能转为足迹。'],
    [fromWantToGo(NUUK_ITEM, { startDate: '' }), 'E_REQUIRED', '请填写到访日期。'],
    [fromWantToGo(NUUK_ITEM, { startDate: '2026.09.01' }), 'E_DATE_FORMAT', '到访日期必须使用 YYYY-MM-DD。'],
    [fromWantToGo(NUUK_ITEM, { endDate: '2026-08-01' }), 'E_DATE_ORDER', '结束日期不能早于到访日期。'],
    [fromWantToGo('wtg_2026-08-12_akureyri'), 'E_CONVERT_CITY_IN_FOOTPRINT', '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。'],
  ]
  for (const [input, code, message] of cases) assertV2Error(() => convertToTravel(files, input, testContext()), code as never, message)
})

test('想去 → 足迹：城市只被 planned 记录引用时同样拒绝（任何记录已引用该城市）', () => {
  const files = migratedFiles()
  files.wantToGo.items.push({ id: 'w_bergen', placeId: placeNamed(files, 'Bergen').id, addedAt: '2026-01-01', hidden: false })
  assertV2Error(() => convertToTravel(files, fromWantToGo('w_bergen'), testContext()), 'E_CONVERT_CITY_IN_FOOTPRINT')
})

// ---------------------------------------------------------------------------
// planned → 足迹
// ---------------------------------------------------------------------------

test('planned → 足迹：同一条记录改 visited、写日期与 year、补 journeyId；国家首次进入足迹时重排（足迹 → editor-state）', () => {
  const files = migratedFiles()
  const norway = placeNamed(files, 'Norway').id
  const bergen = placeNamed(files, 'Bergen').id
  const before = recordById(files, 'planned_bergen')
  assert.equal(before.journeyId, undefined)
  const outcome = convertToTravel(files, { source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01', endDate: '' }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['travel', 'editorState'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  const after = recordById(next, 'planned_bergen')
  assert.ok(typeof after.journeyId === 'string' && after.journeyId.startsWith('journey-'))
  const { journeyId, ...rest } = after
  assert.deepEqual(rest, { ...before, status: 'visited', start_date: '2026-07-01', year: 2026 })
  assert.ok(journeyId)
  assert.equal(Object.hasOwn(after, 'end_date'), false)
  assert.deepEqual(outcome.result, { travelRecordId: 'planned_bergen', countryId: norway, cityId: bergen, wantToGoRemoved: false })
  assert.deepEqual(next.editorState.countryOrder, [norway, ...files.editorState.countryOrder])
  assert.equal(next.travel.records.length, files.travel.records.length)
})

test('planned → 足迹：已有同名行程时沿用它的 journeyId；记录已有 journeyId 时保留', () => {
  const files = migratedFiles()
  const planned = recordById(files, 'planned_bergen')
  const sameTitle = migratedFiles()
  recordById(sameTitle, 'sample_gjogv').trip_title = planned.trip_title
  recordById(sameTitle, 'sample_gjogv').journeyId = 'fjord-journey'
  const reused = applyWrites(sameTitle, convertToTravel(sameTitle, { source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01' }, testContext()).writes)
  assert.equal(recordById(reused, 'planned_bergen').journeyId, 'fjord-journey')

  recordById(files, 'planned_bergen').journeyId = 'kept-journey'
  const kept = applyWrites(files, convertToTravel(files, { source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01' }, testContext()).writes)
  assert.equal(recordById(kept, 'planned_bergen').journeyId, 'kept-journey')
})

test('planned → 足迹：拒绝沿用旧文案（找不到、不是 planned、没有坐标、日期）；全新目录里找不到', () => {
  const files = migratedFiles()
  const noCoordinates = migratedFiles()
  const record = recordById(noCoordinates, 'planned_bergen')
  record.lat = null
  record.lng = null
  const cases: [V2Files | undefined, unknown, string, string][] = [
    [files, { source: 'planned', startDate: '2026-07-01' }, 'E_REQUIRED', '请填写旅行计划 id。'],
    [files, { source: 'planned', recordId: 'missing', startDate: '2026-07-01' }, 'E_PLANNED_NOT_FOUND', '找不到这条旅行计划。'],
    [files, { source: 'planned', recordId: 'sample_vik', startDate: '2026-07-01' }, 'E_PLANNED_NOT_FOUND', '找不到这条旅行计划。'],
    [noCoordinates, { source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01' }, 'E_PLANNED_NO_COORDINATES', '这条旅行计划没有坐标，无法转为足迹。'],
    [files, { source: 'planned', recordId: 'planned_bergen' }, 'E_REQUIRED', '请填写到访日期。'],
    [undefined, { source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01' }, 'E_PLANNED_NOT_FOUND', '找不到这条旅行计划。'],
  ]
  for (const [input, body, code, message] of cases) assertV2Error(() => convertToTravel(input, body, testContext()), code as never, message)
})

test('转足迹 · 完整性：入口有悬空引用 → E_INTEGRITY（两种来源），不给出写入', () => {
  const broken = migratedFiles()
  broken.editorState.hiddenCountryIds = [GHOST_ID]
  assertV2Error(() => convertToTravel(broken, fromWantToGo(NUUK_ITEM), testContext()), 'E_INTEGRITY')
  assertV2Error(() => convertToTravel(broken, { source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01' }, testContext()), 'E_INTEGRITY')
})
