/// <reference types="node" />
/**
 * `POST /wanttogo`, `/wanttogo/update` and `/wanttogo/delete` through the native engine: the behaviour the retired
 * v2write/wantToGo.test.ts pinned on V2 files (3C-5 E review R1), asserted on the official view, the result and the
 * refusals (code, parameters, message).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { V2Files } from '../../compat/v2/v2Schema.ts'
import { GHOST_ID, SUZHOU_AH, SUZHOU_JS, WRITE_NOW } from '../editor.fixture.ts'
import { localDate } from '../rules/input.ts'
import { Library, emptyFiles, filesWith } from './writes.fixture.ts'

const TOKYO = { lat: 35.6762, lng: 139.6503 }
const cityInput = (place: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ place: { kind: 'city', ...place }, ...extra })
type Added = { id: string; item: { id: string; place: Record<string, unknown>; note?: string; addedAt: string; hidden: boolean } }
type Candidate = { placeId: string; strong: boolean; location?: unknown }
const placeIn = (files: V2Files, en: string) => files.places.places.find((place) => place.names.en === en)!

test('by place id: the item is on that place even when another has its name; places and footprint unchanged; the note trimmed', () => {
  const library = new Library(filesWith((files) => {
    const { legacyKeys: _keys, ...city } = structuredClone(placeIn(files, 'Reykjavik'))
    void _keys
    files.places.places.push({ ...city, id: GHOST_ID })
  }))
  const reykjavik = library.view.places.find((place) => place.names.en === 'Reykjavik' && place.id !== GHOST_ID)!
  const before = library.view
  const added = library.save<Added>('wanttogo', { placeId: reykjavik.id, note: '  再去一次  ' })
  assert.equal(library.view.wantToGo.items.find((item) => item.id === added.id)!.placeId, reykjavik.id)
  assert.equal(added.item.note, '再去一次')
  assert.deepEqual(library.view.places, before.places)
  assert.deepEqual(library.view.travel, before.travel)
})

test('by place id: a place without an English name or coordinates is used as it is; no place is made or changed', () => {
  const library = new Library(filesWith((files) => {
    const city = placeIn(files, 'Reykjavik')
    delete city.names.en
    delete city.location
  }))
  const reykjavik = library.view.places.find((place) => place.names['zh-Hans'] === '雷克雅未克')!
  const places = library.view.places
  const added = library.save<Added>('wanttogo', { placeId: reykjavik.id })
  assert.equal(library.view.wantToGo.items.find((item) => item.id === added.id)!.placeId, reykjavik.id)
  assert.deepEqual(library.view.places, places)
})

test('by place id refused: an item there already (a hidden one too) → E_WTG_EXISTS { placeId }; an unknown or malformed id, or with place fields → E_UNKNOWN_PLACE_REF', () => {
  const library = new Library()
  for (const name of ['Nuuk', 'Tromsø', 'Akureyri']) {
    const placeId = library.place(name).id
    library.refuse('wanttogo', { placeId }, 'E_WTG_EXISTS', { placeId }, '这个地方已在想去列表中。')
  }
  for (const input of [
    { placeId: GHOST_ID }, { placeId: null }, { placeId: '' }, { placeId: 1 },
    { placeId: library.place('Reykjavik').id, place: { kind: 'city', nameEn: 'Other', countryCode: 'IS' } },
  ]) library.refuse('wanttogo', input, 'E_UNKNOWN_PLACE_REF')
  new Library(emptyFiles()).refuse('wanttogo', { placeId: GHOST_ID }, 'E_UNKNOWN_PLACE_REF')
})

test('by name, a footprint city: the choice (not a strong candidate: another Chinese name); by its id the item uses it, its names and its coordinates', () => {
  const library = new Library()
  const reykjavik = library.place('Reykjavik')
  const params = library.refuse('wanttogo', cityInput({ nameZh: '雷克雅未克市', nameEn: 'reykjavik', countryCode: 'IS', lat: 64.15, lng: -21.95 }), 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual((params.candidates as Candidate[]).map(({ placeId, strong }) => ({ placeId, strong })), [{ placeId: reykjavik.id, strong: false }])
  const added = library.save<Added>('wanttogo', { placeId: reykjavik.id })
  assert.equal(added.item.place.nameZh, '雷克雅未克')
  assert.deepEqual(library.place('Reykjavik'), reykjavik, 'its coordinates unchanged')
})

test('a new city without coordinates (its Chinese name from the English one); a country item is on the country place, which gets the coordinates only when it has none', () => {
  const library = new Library()
  library.save('wanttogo', cityInput({ nameEn: 'Ilulissat', countryCode: 'GL' }))
  const ilulissat = library.place('Ilulissat')
  assert.deepEqual([ilulissat.names, ilulissat.location], [{ 'zh-Hans': 'Ilulissat', en: 'Ilulissat' }, undefined])

  const greenland = library.place('Greenland')
  assert.equal(greenland.location, undefined)
  const country = library.save<Added>('wanttogo', { place: { kind: 'country', nameZh: '格陵兰岛', nameEn: 'Greenland', countryCode: 'GL', lat: 72, lng: -40 } })
  assert.equal(library.view.wantToGo.items.find((item) => item.id === country.id)!.placeId, greenland.id)
  assert.deepEqual(library.place('Greenland').location, { lat: 72, lng: -40 })
  const norway = library.place('Norway')
  library.save('wanttogo', { place: { kind: 'country', nameEn: 'Norway', countryCode: 'NO', lat: 1, lng: 1 } })
  assert.deepEqual(library.place('Norway'), norway, 'Norway has coordinates: unchanged')
})

test('a place of that name already on the list (a hidden one too): by name the choice first; by its id E_WTG_EXISTS', () => {
  const library = new Library()
  for (const [nameEn, countryCode, placeEn] of [['NUUK', 'gl', 'Nuuk'], ['Tromsø', 'NO', 'Tromsø'], ['Akureyri', 'IS', 'Akureyri']]) {
    const params = library.refuse('wanttogo', cityInput({ nameEn, countryCode }), 'E_PLACE_CHOICE_REQUIRED')
    assert.deepEqual((params.candidates as Candidate[]).map((candidate) => candidate.placeId), [library.place(placeEn).id])
  }
})

test('the input checks of a new item, with the old messages; addedAt is the local date by default; a blank note is not kept', () => {
  const library = new Library()
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
  for (const [input, code, message] of cases) library.refuse('wanttogo', input, code as never, undefined, message)
  const added = library.save<Added>('wanttogo', cityInput({ nameEn: 'Selfoss', countryCode: 'IS' }, { note: '   ' }))
  const item = library.view.wantToGo.items.find((candidate) => candidate.id === added.id)!
  assert.equal(item.addedAt, localDate(WRITE_NOW))
  assert.equal(Object.hasOwn(item, 'note'), false, 'a blank note is not kept')
})

test('several places of that name → E_PLACE_CHOICE_REQUIRED with every candidate; two countries with the code → E_PLACE_AMBIGUOUS', () => {
  const second = '019b76da-a8f0-7000-8000-0000000000f0'
  const library = new Library(filesWith((files) => {
    files.places.places.push({ id: second, subtype: 'city', names: { en: 'Reykjavik' }, partOf: placeIn(files, 'Iceland').id })
  }))
  const params = library.refuse('wanttogo', cityInput({ nameEn: 'Reykjavik', countryCode: 'IS' }), 'E_PLACE_CHOICE_REQUIRED')
  const reykjavik = library.view.places.find((place) => place.names.en === 'Reykjavik' && place.id !== second)!.id
  assert.deepEqual((params.candidates as Candidate[]).map((candidate) => candidate.placeId).sort(), [reykjavik, second].sort())
  const twoIcelands = new Library(filesWith((files) => {
    files.places.places.push({ id: '019b76da-a8f2-7000-8000-0000000000f2', subtype: 'country', names: { en: 'Iceland 2' }, externalIds: { iso3166Alpha2: 'IS' } })
  }))
  const ambiguous = twoIcelands.refuse('wanttogo', cityInput({ nameEn: 'Selfoss', countryCode: 'IS' }), 'E_PLACE_AMBIGUOUS')
  assert.deepEqual([ambiguous.subtype, ambiguous.iso], ['country', 'IS'])
})

test('same name, another city (Suzhou / Suxian): the choice with or without coordinates; English name only and the same place → strong; createNew → a place of its own; by id → E_WTG_EXISTS or the item; placeId with createNew, a createNew that is no boolean → E_UNKNOWN_PLACE_REF', () => {
  const library = new Library()
  library.save('wanttogo', cityInput({ nameZh: '苏州', nameEn: 'Suzhou', countryCode: 'CN', ...SUZHOU_JS }))
  const suzhou = library.place('Suzhou')
  const params = library.refuse('wanttogo', cityInput({ nameZh: '宿州', nameEn: 'Suzhou', countryCode: 'CN', ...SUZHOU_AH }), 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual((params.candidates as Candidate[]).map(({ placeId, strong, location }) => ({ placeId, strong, location })), [{ placeId: suzhou.id, strong: false, location: SUZHOU_JS }])
  library.refuse('wanttogo', cityInput({ nameZh: '宿州', nameEn: 'Suzhou', countryCode: 'CN' }), 'E_PLACE_CHOICE_REQUIRED', undefined, undefined)
  const strong = library.refuse('wanttogo', cityInput({ nameEn: 'Suzhou', countryCode: 'CN', ...SUZHOU_JS }), 'E_PLACE_CHOICE_REQUIRED')
  assert.equal((strong.candidates as Candidate[])[0].strong, true)

  library.refuse('wanttogo', { placeId: suzhou.id }, 'E_WTG_EXISTS')
  library.refuse('wanttogo', cityInput({ nameEn: 'Suzhou', countryCode: 'CN' }, { createNew: 1 }), 'E_UNKNOWN_PLACE_REF')
  const created = library.save<Added>('wanttogo', cityInput({ nameZh: '宿州', nameEn: 'Suzhou', countryCode: 'CN', ...SUZHOU_AH }, { createNew: true }))
  const suxian = library.view.places.find((place) => place.names['zh-Hans'] === '宿州')!
  assert.deepEqual(suxian.location, SUZHOU_AH)
  assert.equal(library.view.wantToGo.items.find((item) => item.id === created.id)!.placeId, suxian.id)
  assert.equal(library.view.places.filter((place) => place.names.en === 'Suzhou').length, 2)

  // Suzhou not on the list: by its id the item is on Suzhou; with createNew it is refused.
  const other = new Library()
  other.save('records', { country: '中国', country_en: 'China', country_code: 'CN', city: '苏州', city_en: 'Suzhou', start_date: '2026-05-01', ...SUZHOU_JS })
  const footprintSuzhou = other.place('Suzhou').id
  other.refuse('wanttogo', { placeId: footprintSuzhou, createNew: true }, 'E_UNKNOWN_PLACE_REF')
  const chosen = other.save<Added>('wanttogo', { placeId: footprintSuzhou })
  assert.equal(other.view.wantToGo.items.find((item) => item.id === chosen.id)!.placeId, footprintSuzhou)
})

test('kind: country is found by its ISO code; createNew does nothing for a country', () => {
  const library = new Library()
  const places = library.view.places.length
  const added = library.save<Added>('wanttogo', { place: { kind: 'country', nameEn: 'Greenland', countryCode: 'GL' }, createNew: true })
  assert.equal(library.view.wantToGo.items.find((item) => item.id === added.id)!.placeId, library.place('Greenland').id)
  assert.equal(library.view.places.length, places)
})

test('an empty library: a new item makes its country and city and nothing else', () => {
  const library = new Library(emptyFiles())
  library.save('wanttogo', cityInput({ nameZh: '东京', nameEn: 'Tokyo', countryCode: 'JP', ...TOKYO }))
  assert.equal(library.view.places.length, 2)
  assert.equal(library.view.wantToGo.items.length, 1)
  assert.equal(library.view.travel.records.length, 0)
})

test('the update checks, with the old messages: no id', () => {
  const library = new Library()
  library.refuse('wanttogo/update', { hidden: true }, 'E_REQUIRED', { field: 'id' }, '请填写想去记录 id。')
  library.refuse('wanttogo/update', { id: 'missing', hidden: true }, 'E_WTG_NOT_FOUND', undefined, '找不到这条想去记录。')
  new Library(emptyFiles()).refuse('wanttogo/update', { id: 'missing', hidden: true }, 'E_WTG_NOT_FOUND')
})

test('a delete: the ids trimmed and once each; a city and the country only it used go; a city with footprint records stays; nothing else to clean is no place change', () => {
  const library = new Library(filesWith((files) => { for (const item of files.wantToGo.items) item.hidden = true }))
  const result = library.save('wanttogo/delete', { ids: ['wtg_2026-08-12_nuuk', 'wtg_2026-08-12_akureyri', ' wtg_2026-08-12_nuuk '] })
  assert.deepEqual(result, { deletedIds: ['wtg_2026-08-12_nuuk', 'wtg_2026-08-12_akureyri'] })
  const names = new Set(library.view.places.map((place) => place.names.en))
  assert.deepEqual([names.has('Nuuk'), names.has('Greenland'), names.has('Akureyri')], [false, false, true])

  const onlyFootprint = new Library(filesWith((files) => { files.wantToGo.items.find((item) => item.id === 'wtg_2026-08-12_akureyri')!.hidden = true }))
  const places = onlyFootprint.view.places
  onlyFootprint.save('wanttogo/delete', { ids: ['wtg_2026-08-12_akureyri'] })
  assert.deepEqual(onlyFootprint.view.places, places, 'Akureyri has footprint records: no place goes')
})

test('a delete refused as a whole: no usable id; ids not hidden (listed, the missing ones too)', () => {
  const library = new Library()
  library.refuse('wanttogo/delete', { ids: [] }, 'E_WTG_DELETE_EMPTY', undefined, '没有可删除的隐藏想去记录。')
  library.refuse('wanttogo/delete', { ids: [1, ' '] }, 'E_WTG_DELETE_EMPTY')
  library.refuse('wanttogo/delete', { ids: ['wtg_2026-08-12_tromso', 'wtg_2026-08-12_nuuk', 'missing'] }, 'E_WTG_DELETE_NOT_HIDDEN',
    { ids: ['wtg_2026-08-12_nuuk', 'missing'] }, '只能彻底删除已隐藏的想去记录。以下记录不符合条件：wtg_2026-08-12_nuuk、missing')
  new Library(emptyFiles()).refuse('wanttogo/delete', { ids: ['missing'] }, 'E_WTG_DELETE_NOT_HIDDEN')
})
