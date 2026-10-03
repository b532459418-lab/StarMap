/**
 * 想去的 V2 写入（v2write/wantToGo.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.3、§2.4、§3）：
 * `POST /wanttogo`、`POST /wanttogo/update`、`POST /wanttogo/delete`。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isUuidV7 } from '../canonical/uuidv7.ts'
import type { V2Files } from '../canonical/v2Schema.ts'
import { localDate } from './common.ts'
import { addWantToGo, deleteHiddenWantToGo, updateWantToGo } from './wantToGo.ts'
import {
  GHOST_ID,
  WRITE_NOW,
  applyWrites,
  assertIntact,
  assertV2Error,
  migratedFiles,
  placeNamed,
  testContext,
  writeOrder,
} from './v2write.fixture.ts'

const TOKYO = { lat: 35.6762, lng: 139.6503 }

const cityInput = (place: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ place: { kind: 'city', ...place }, ...extra })

const itemOf = (files: V2Files, id: string) => files.wantToGo.items.find((item) => item.id === id)

test('按现有地点 id 收藏：同名城市不重解析，注册表及足迹不变，仅写想去', () => {
  const files = migratedFiles()
  const city = placeNamed(files, 'Reykjavik')
  const duplicate = { ...structuredClone(city), id: GHOST_ID }
  delete duplicate.legacyKeys
  files.places.places.push(duplicate)
  const before = structuredClone(files)
  const outcome = addWantToGo(files, { placeId: city.id, note: '  再去一次  ' }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['wantToGo'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.equal(itemOf(next, outcome.result.id)?.placeId, city.id)
  assert.equal(outcome.result.item.note, '再去一次')
  assert.deepEqual(next.places, before.places)
  assert.deepEqual(next.travel, before.travel)
  assert.deepEqual(files, before, '原始输入不变')
})

test('按现有地点 id 收藏：缺英文名与坐标时仍引用原地点，不能隐式创建或修改地点', () => {
  const files = migratedFiles()
  const city = placeNamed(files, 'Reykjavik')
  delete city.names.en
  delete city.location
  const outcome = addWantToGo(files, { placeId: city.id }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['wantToGo'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.equal(itemOf(next, outcome.result.id)?.placeId, city.id)
  assert.deepEqual(next.places, files.places)
})

test('按现有地点 id 收藏：拒绝重复及隐藏条目、未知引用和混用输入，失败不改数据', () => {
  const files = migratedFiles()
  const before = structuredClone(files)
  for (const name of ['Nuuk', 'Tromsø', 'Akureyri']) {
    assertV2Error(() => addWantToGo(files, { placeId: placeNamed(files, name).id }, testContext()), 'E_WTG_EXISTS')
  }
  for (const input of [
    { placeId: GHOST_ID }, { placeId: null }, { placeId: '' }, { placeId: 1 },
    { placeId: placeNamed(files, 'Reykjavik').id, place: { kind: 'city', nameEn: 'Other', countryCode: 'IS' } },
  ]) assertV2Error(() => addWantToGo(files, input, testContext()), 'E_UNKNOWN_PLACE_REF')
  assertV2Error(() => addWantToGo(undefined, { placeId: GHOST_ID }, testContext()), 'E_UNKNOWN_PLACE_REF')
  assert.deepEqual(files, before)
})

// ---------------------------------------------------------------------------
// POST /wanttogo
// ---------------------------------------------------------------------------

test('新增想去：新国家的新城市——先写地点（国家按目录、城市按输入）、再写想去；返回旧形状的条目', () => {
  const files = migratedFiles()
  const outcome = addWantToGo(files, cityInput({ nameZh: '东京', nameEn: 'Tokyo', countryCode: 'jp', ...TOKYO }, { note: '  看樱花  ', addedAt: '2026-09-01' }), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'wantToGo'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  const japan = placeNamed(next, 'Japan')
  const tokyo = placeNamed(next, 'Tokyo')
  assert.deepEqual(tokyo, { id: tokyo.id, subtype: 'city', names: { 'zh-Hans': '东京', en: 'Tokyo' }, partOf: japan.id, location: TOKYO })
  const item = itemOf(next, outcome.result.id)!
  assert.ok(isUuidV7(item.id))
  assert.deepEqual(item, { id: item.id, placeId: tokyo.id, note: '看樱花', addedAt: '2026-09-01', hidden: false, source: 'local-editor' })
  assert.deepEqual(outcome.result.item, {
    id: item.id,
    place: { kind: 'city', nameZh: '东京', nameEn: 'Tokyo', countryCode: 'JP', ...TOKYO },
    addedAt: '2026-09-01',
    hidden: false,
    note: '看樱花',
    source: 'local-editor',
  })
  assert.equal(next.wantToGo.generated_at, WRITE_NOW.toISOString())
})

test('新增想去复用足迹城市：不新建地点，只写想去；条目引用足迹城市（地图上自然合并）；名称以地点为准', () => {
  const files = migratedFiles()
  const reykjavik = placeNamed(files, 'Reykjavik')
  const outcome = addWantToGo(files, cityInput({ nameZh: '雷克雅未克市', nameEn: 'reykjavik', countryCode: 'IS', lat: 64.15, lng: -21.95 }), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['wantToGo'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.equal(itemOf(next, outcome.result.id)?.placeId, reykjavik.id)
  assert.deepEqual(placeNamed(next, 'Reykjavik'), reykjavik, '已有坐标不改')
  assert.equal(outcome.result.item.place.nameZh, '雷克雅未克')
})

test('新增想去：没有坐标的城市可以新建；国家条目指向国家地点，国家地点没有坐标时补上输入的坐标', () => {
  const files = migratedFiles()
  const noCoordinates = addWantToGo(files, cityInput({ nameEn: 'Ilulissat', countryCode: 'GL' }), testContext())
  const next = applyWrites(files, noCoordinates.writes)
  assertIntact(next)
  const ilulissat = placeNamed(next, 'Ilulissat')
  assert.deepEqual(ilulissat.names, { 'zh-Hans': 'Ilulissat', en: 'Ilulissat' }, '中文名缺时用英文名（同旧 store）')
  assert.equal(ilulissat.location, undefined)

  const greenland = placeNamed(files, 'Greenland')
  const country = addWantToGo(files, { place: { kind: 'country', nameZh: '格陵兰岛', nameEn: 'Greenland', countryCode: 'GL', lat: 72, lng: -40 } }, testContext())
  assert.deepEqual(writeOrder(country.writes), ['places', 'wantToGo'])
  const withCountry = applyWrites(files, country.writes)
  assertIntact(withCountry)
  assert.equal(itemOf(withCountry, country.result.id)?.placeId, greenland.id)
  assert.deepEqual(placeNamed(withCountry, 'Greenland').location, { lat: 72, lng: -40 })

  const norway = addWantToGo(files, { place: { kind: 'country', nameEn: 'Norway', countryCode: 'NO', lat: 1, lng: 1 } }, testContext())
  assert.deepEqual(writeOrder(norway.writes), ['wantToGo'], '挪威已有坐标，不改地点')
})

test('新增想去：已有想去条目（含隐藏的）引用同一地点 → E_WTG_EXISTS（沿用旧文案）', () => {
  const files = migratedFiles()
  assertV2Error(() => addWantToGo(files, cityInput({ nameZh: '努克', nameEn: 'NUUK', countryCode: 'gl' }), testContext()), 'E_WTG_EXISTS', '这个地方已在想去列表中。')
  assertV2Error(() => addWantToGo(files, cityInput({ nameEn: 'Tromsø', countryCode: 'NO' }), testContext()), 'E_WTG_EXISTS')
  assertV2Error(() => addWantToGo(files, cityInput({ nameEn: 'Akureyri', countryCode: 'IS' }), testContext()), 'E_WTG_EXISTS', undefined, (error) => {
    assert.equal(error.params?.placeId, placeNamed(files, 'Akureyri').id)
  })
})

test('新增想去：输入校验与旧 store 相同的文案；加入日期默认本地日期', () => {
  const files = migratedFiles()
  const cases: [unknown, string, string][] = [
    [{ place: { kind: 'region', nameEn: 'X', countryCode: 'IS' } }, 'E_WTG_KIND_INVALID', '想去条目的类型只能是 city 或 country。'],
    [{}, 'E_WTG_KIND_INVALID', '想去条目的类型只能是 city 或 country。'],
    [cityInput({ nameEn: ' ', countryCode: 'IS' }), 'E_REQUIRED', '请填写地点英文名。'],
    [cityInput({ nameEn: 'X' }), 'E_REQUIRED', '请填写国家代码。'],
    [cityInput({ nameEn: 'X', countryCode: 'ISL' }), 'E_COUNTRY_CODE_INVALID', '国家代码必须是两个英文字母。'],
    [cityInput({ nameEn: 'X', countryCode: 'IS', lat: 64 }), 'E_COORDINATES_PAIR', '经纬度需要同时填写，或同时留空。'],
    [cityInput({ nameEn: 'X', countryCode: 'IS', lat: 'north', lng: 1 }), 'E_NUMBER_INVALID', '纬度无效。'],
    [cityInput({ nameEn: 'X', countryCode: 'IS', lat: 1, lng: 181 }), 'E_NUMBER_INVALID', '经度无效。'],
    [cityInput({ nameEn: 'X', countryCode: 'IS' }, { note: 3 }), 'E_NOTE_NOT_TEXT', '备注必须是文本。'],
    [cityInput({ nameEn: 'X', countryCode: 'IS' }, { note: 'a'.repeat(201) }), 'E_NOTE_TOO_LONG', '备注最多 200 字。'],
    [cityInput({ nameEn: 'X', countryCode: 'IS' }, { addedAt: '2026/09/01' }), 'E_DATE_FORMAT', '加入日期必须使用 YYYY-MM-DD。'],
    [cityInput({ nameEn: 'X', countryCode: 'ZZ' }), 'E_COUNTRY_NOT_IN_CATALOG', '没有找到这个国家，请从候选列表中选择。'],
  ]
  for (const [input, code, message] of cases) assertV2Error(() => addWantToGo(files, input, testContext()), code as never, message)

  const outcome = addWantToGo(files, cityInput({ nameEn: 'Selfoss', countryCode: 'IS' }, { note: '   ' }), testContext())
  const item = itemOf(applyWrites(files, outcome.writes), outcome.result.id)!
  assert.equal(item.addedAt, localDate(WRITE_NOW))
  assert.equal(Object.hasOwn(item, 'note'), false, '空备注不写')
})

test('新增想去：候选地点不唯一 → E_PLACE_AMBIGUOUS', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  files.places.places.push({ id: '019b76da-a8f0-7000-8000-0000000000f0', subtype: 'city', names: { en: 'Reykjavik' }, partOf: iceland })
  assertV2Error(() => addWantToGo(files, cityInput({ nameEn: 'Reykjavik', countryCode: 'IS' }), testContext()), 'E_PLACE_AMBIGUOUS')
})

test('新增想去 · 全新 V2 目录：只写地点与想去，合法；想去文件为 local-only；没有样例数据', () => {
  const outcome = addWantToGo(undefined, cityInput({ nameZh: '东京', nameEn: 'Tokyo', countryCode: 'JP', ...TOKYO }), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'wantToGo'])
  const next = applyWrites({}, outcome.writes)
  assertIntact(next)
  assert.equal(next.wantToGo.privacy_level, 'local-only')
  assert.equal(next.places.places.length, 2)
  assert.equal(next.wantToGo.items.length, 1)
})

test('新增想去 · 完整性：入口有悬空引用、产出的 id 不合法 → E_INTEGRITY', () => {
  const broken = migratedFiles()
  broken.editorState.countryOrder.push(GHOST_ID)
  assertV2Error(() => addWantToGo(broken, cityInput({ nameEn: 'Selfoss', countryCode: 'IS' }), testContext()), 'E_INTEGRITY', undefined, (error) => assert.equal(error.params?.stage, 'input'))
  assertV2Error(() => addWantToGo(migratedFiles(), cityInput({ nameEn: 'Selfoss', countryCode: 'IS' }), testContext({ newId: () => 'bad' })), 'E_INTEGRITY', undefined, (error) => assert.equal(error.params?.stage, 'output'))
})

// ---------------------------------------------------------------------------
// POST /wanttogo/update
// ---------------------------------------------------------------------------

test('更新想去：改隐藏、写备注、传空串删除备注——只写想去；返回旧形状的条目', () => {
  const files = migratedFiles()
  const id = 'wtg_2026-08-12_nuuk'
  const hidden = updateWantToGo(files, { id, hidden: true, note: '  新备注 ' }, testContext())
  assert.deepEqual(writeOrder(hidden.writes), ['wantToGo'])
  const next = applyWrites(files, hidden.writes)
  assertIntact(next)
  assert.deepEqual({ ...itemOf(next, id) }, { ...itemOf(files, id), hidden: true, note: '新备注' })
  assert.equal(hidden.result.item.hidden, true)
  assert.equal(hidden.result.item.place.nameEn, 'Nuuk')

  const cleared = applyWrites(next, updateWantToGo(next, { id, note: '' }, testContext()).writes)
  assert.equal(Object.hasOwn(itemOf(cleared, id)!, 'note'), false)
  assert.equal(itemOf(cleared, id)!.hidden, true)
})

test('更新想去：校验与旧 store 相同的文案', () => {
  const files = migratedFiles()
  assertV2Error(() => updateWantToGo(files, { hidden: true }, testContext()), 'E_REQUIRED', '请填写想去记录 id。')
  assertV2Error(() => updateWantToGo(files, { id: 'wtg_2026-08-12_nuuk' }, testContext()), 'E_WTG_UPDATE_EMPTY', '没有需要更新的想去记录内容。')
  assertV2Error(() => updateWantToGo(files, { id: 'wtg_2026-08-12_nuuk', hidden: 'yes' }, testContext()), 'E_HIDDEN_NOT_BOOLEAN', '隐藏状态只能是 true 或 false。')
  assertV2Error(() => updateWantToGo(files, { id: 'wtg_2026-08-12_nuuk', note: 'a'.repeat(201) }, testContext()), 'E_NOTE_TOO_LONG')
  assertV2Error(() => updateWantToGo(files, { id: 'missing', hidden: true }, testContext()), 'E_WTG_NOT_FOUND', '找不到这条想去记录。')
  assertV2Error(() => updateWantToGo(undefined, { id: 'missing', hidden: true }, testContext()), 'E_WTG_NOT_FOUND')
  const broken = migratedFiles()
  broken.travel.display.navigationHiddenCityIds = [GHOST_ID]
  assertV2Error(() => updateWantToGo(broken, { id: 'wtg_2026-08-12_nuuk', hidden: true }, testContext()), 'E_INTEGRITY')
})

// ---------------------------------------------------------------------------
// POST /wanttogo/delete
// ---------------------------------------------------------------------------

test('想去删除后地点清理：只被这些条目引用的城市删掉（想去 → 地点）；国家仍被足迹引用的保留', () => {
  const files = migratedFiles()
  const tromso = placeNamed(files, 'Tromsø').id
  const outcome = deleteHiddenWantToGo(files, { ids: ['wtg_2026-08-12_tromso'] }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['wantToGo', 'places'])
  assert.equal(outcome.writes[1].onFailure, '想去记录已删除，但地点注册表没有清理（{reason}）。这不影响显示。')
  assert.deepEqual(outcome.result, { deletedIds: ['wtg_2026-08-12_tromso'] })
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.equal(next.places.places.some((place) => place.id === tromso), false)
  assert.equal(next.places.places.some((place) => place.id === placeNamed(files, 'Norway').id), true, '挪威仍被卑尔根引用')
})

test('想去删除后地点清理：城市与只被它引用的国家一起删（努克 → 格陵兰）；引用足迹城市的条目删掉后城市保留', () => {
  const files = migratedFiles()
  for (const item of files.wantToGo.items) item.hidden = true
  const outcome = deleteHiddenWantToGo(files, { ids: ['wtg_2026-08-12_nuuk', 'wtg_2026-08-12_akureyri', ' wtg_2026-08-12_nuuk '] }, testContext())
  assert.deepEqual(outcome.result.deletedIds, ['wtg_2026-08-12_nuuk', 'wtg_2026-08-12_akureyri'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  const ids = new Set(next.places.places.map((place) => place.id))
  assert.equal(ids.has(placeNamed(files, 'Nuuk').id), false)
  assert.equal(ids.has(placeNamed(files, 'Greenland').id), false)
  assert.equal(ids.has(placeNamed(files, 'Akureyri').id), true, '阿克雷里有足迹记录')

  const onlyFootprint = migratedFiles()
  onlyFootprint.wantToGo.items[2].hidden = true
  const kept = deleteHiddenWantToGo(onlyFootprint, { ids: ['wtg_2026-08-12_akureyri'] }, testContext())
  assert.deepEqual(writeOrder(kept.writes), ['wantToGo'], '没有地点可删，不写注册表')
})

test('删除想去：整批原子拒绝（沿用旧文案，列出不符合的 id）；没有 id；完整性', () => {
  const files = migratedFiles()
  assertV2Error(() => deleteHiddenWantToGo(files, { ids: [] }, testContext()), 'E_WTG_DELETE_EMPTY', '没有可删除的隐藏想去记录。')
  assertV2Error(() => deleteHiddenWantToGo(files, { ids: [1, ' '] }, testContext()), 'E_WTG_DELETE_EMPTY')
  assertV2Error(
    () => deleteHiddenWantToGo(files, { ids: ['wtg_2026-08-12_tromso', 'wtg_2026-08-12_nuuk', 'missing'] }, testContext()),
    'E_WTG_DELETE_NOT_HIDDEN',
    '只能彻底删除已隐藏的想去记录。以下记录不符合条件：wtg_2026-08-12_nuuk、missing',
  )
  assertV2Error(() => deleteHiddenWantToGo(undefined, { ids: ['missing'] }, testContext()), 'E_WTG_DELETE_NOT_HIDDEN')
  const broken = migratedFiles()
  broken.editorState.coverMediaByCity = { [GHOST_ID]: 'x' }
  assertV2Error(() => deleteHiddenWantToGo(broken, { ids: ['wtg_2026-08-12_tromso'] }, testContext()), 'E_INTEGRITY')
})
