/// <reference types="node" />
/**
 * `POST /wanttogo/convert` through the native engine: the behaviour the retired v2write/convert.test.ts pinned on V2
 * files (3C-5 E review R1), asserted on the official view, its derivation and the refusals (code, parameters, message).
 * Design 3C-5 §9 change 1: a new journey's id is its entity's (no `journey-` prefix).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAppDataFromCanonical } from '../../canonical/derive.ts'
import type { V2Files } from '../../compat/v2/v2Schema.ts'
import { WRITE_NOW } from '../editor.fixture.ts'
import { Library, emptyFiles, filesWith } from './writes.fixture.ts'

const NUUK_ITEM = 'wtg_2026-08-12_nuuk'
const DEMO_TITLE = '2025 North Atlantic Demo'
const DEMO_JOURNEY = '2025-north-atlantic-demo'
const fromWantToGo = (id: string, extra: Record<string, unknown> = {}) => ({ source: 'want-to-go', id, startDate: '2026-09-01', ...extra })
const planned = (extra: Record<string, unknown> = {}) => ({ source: 'planned', recordId: 'planned_bergen', startDate: '2026-07-01', ...extra })
const sampleSouth = { place: { kind: 'city', nameZh: '示例南城', nameEn: 'SampleSouth', countryCode: 'IS', lat: 64, lng: -22 }, note: '保留备注' }
type Converted = { travelRecordId: string; countryId: string; cityId: string; wantToGoRemoved: boolean }
const recordIn = (files: V2Files, id: string) => files.travel.records.find((record) => record.id === id)!
const routesTouching = (library: Library, cityId: string) => deriveAppDataFromCanonical(library.view, { now: WRITE_NOW.toISOString() }).travelAtlas.routes
  .filter((route) => route.fromCityId === cityId || route.toCityId === cityId)
  .map((route) => ({ journeyId: route.journeyId, fromCityId: route.fromCityId, toCityId: route.toCityId }))
const journeyIds = (library: Library) => new Set(library.view.travel.records.map((record) => record.journeyId))
/** Iceland as a V2 place, added by the user with their own region (and a visit date or none). */
const icelandAddedByUser = (visitedDate?: string) => filesWith((files) => {
  const iceland = '019b76da-a8e0-7000-8000-0000000000e0'
  files.places.places.push({ id: iceland, subtype: 'country', names: { 'zh-Hans': '冰岛', en: 'Iceland' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 } })
  files.editorState.addedCountries = [{ placeId: iceland, region: 'User region', ...(visitedDate ? { visitedDate } : {}) }]
  files.editorState.countryOrder = [iceland]
}, emptyFiles())

test('a first conversion in a country: the continent of its catalog entry is saved (an added country with the visit date); the place and the dates kept; the item removed', () => {
  const library = new Library(emptyFiles())
  const added = library.save<{ id: string }>('wanttogo', sampleSouth)
  const places = library.view.places
  const result = library.save<Converted>('wanttogo/convert', fromWantToGo(added.id, { startDate: '2026-10-03', endDate: '2026-10-04', keepWantToGo: false }))
  assert.deepEqual(library.view.places, places)
  assert.deepEqual(library.view.editorState.addedCountries, [{ placeId: result.countryId, region: 'Europe', visitedDate: '2026-10-03' }])
  assert.equal(library.view.wantToGo.items.length, 0)
  const record = library.record(result.travelRecordId)!
  assert.deepEqual([record.start_date, record.end_date, record.placeId], ['2026-10-03', '2026-10-04', result.cityId])
  assert.deepEqual(deriveAppDataFromCanonical(library.view, { now: WRITE_NOW.toISOString() }).travelAtlas.countryById[result.countryId].keywords, ['Europe'])
})

test('the user\'s own country information is not overwritten (with or without a visit date); an item kept keeps its note', () => {
  for (const visitedDate of ['2026-01-01', undefined]) {
    const library = new Library(icelandAddedByUser(visitedDate))
    const added = library.save<{ id: string }>('wanttogo', sampleSouth)
    const countries = library.view.editorState.addedCountries
    const items = library.view.wantToGo.items
    library.save('wanttogo/convert', fromWantToGo(added.id, { keepWantToGo: true }))
    assert.deepEqual(library.view.editorState.addedCountries, countries, String(visitedDate))
    assert.deepEqual(library.view.wantToGo.items, items)
    assert.equal(library.view.wantToGo.items[0].note, sampleSouth.note)
  }
})

test('a country already in the country order (not in the footprint) still gets its continent; without a catalog entry it stays unknown', () => {
  const prepare = () => {
    const library = new Library(emptyFiles())
    const added = library.save<{ id: string }>('wanttogo', sampleSouth)
    const iceland = library.place('Iceland').id
    library.save('view', { operations: [{ op: 'order', scope: 'countries', ids: [iceland], baseline: [] }] })
    assert.deepEqual(library.view.editorState.countryOrder, [iceland])
    return { library, item: added.id, iceland }
  }
  const { library, item, iceland } = prepare()
  library.save('wanttogo/convert', fromWantToGo(item))
  assert.deepEqual(library.view.editorState.addedCountries, [{ placeId: iceland, region: 'Europe', visitedDate: '2026-09-01' }])
  const unknown = prepare()
  const outcome = unknown.library.runWith('wanttogo/convert', fromWantToGo(unknown.item), { countryCatalog: new Map() })
  assert.ok(outcome.state, JSON.stringify(outcome.error))
  assert.deepEqual(unknown.library.view.editorState.addedCountries, [])
})

test('a country already in the footprint: the country order does not move', () => {
  const selfoss = '019b76da-a8f3-7000-8000-0000000000f3'
  const library = new Library(filesWith((files) => {
    const iceland = files.places.places.find((place) => place.names.en === 'Iceland')!.id
    files.places.places.push({ id: selfoss, subtype: 'city', names: { 'zh-Hans': '塞尔福斯', en: 'Selfoss' }, partOf: iceland, location: { lat: 63.93, lng: -21.0 } })
    files.wantToGo.items.push({ id: 'w_selfoss', placeId: selfoss, addedAt: '2026-01-01', hidden: false })
  }))
  const order = library.view.editorState.countryOrder
  const result = library.save<Converted>('wanttogo/convert', fromWantToGo('w_selfoss'))
  assert.deepEqual(library.view.editorState.countryOrder, order)
  assert.deepEqual([result.cityId, result.wantToGoRemoved], [selfoss, true])
})

test('want-to-go → footprint refused, with the old messages: source, id, keep flag, missing item, a whole country, no coordinates, hidden, dates, a city in the footprint', () => {
  const noLocation = '019b76da-a8f4-7000-8000-0000000000f4'
  const library = new Library(filesWith((files) => {
    const greenland = files.places.places.find((place) => place.names.en === 'Greenland')!.id
    const iceland = files.places.places.find((place) => place.names.en === 'Iceland')!.id
    files.places.places.push({ id: noLocation, subtype: 'city', names: { en: 'Ilulissat' }, partOf: greenland })
    files.wantToGo.items.push(
      { id: 'w_country', placeId: iceland, addedAt: '2026-01-01', hidden: false },
      { id: 'w_no_location', placeId: noLocation, addedAt: '2026-01-01', hidden: false },
    )
  }))
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
  for (const [input, code, message] of cases) library.refuse('wanttogo/convert', input, code as never, undefined, message)
  library.refuse('wanttogo/convert', fromWantToGo('missing'), 'E_WTG_NOT_FOUND', { id: 'missing' })
  library.refuse('wanttogo/convert', fromWantToGo('wtg_2026-08-12_akureyri'), 'E_CONVERT_CITY_IN_FOOTPRINT', { cityId: library.place('Akureyri').id })
})

test('planned → footprint: a planned record without a journey whose title a journey uses asks for the choice; a journey it has is kept', () => {
  const sameTitle = new Library(filesWith((files) => {
    Object.assign(recordIn(files, 'sample_gjogv'), { trip_title: recordIn(files, 'planned_bergen').trip_title, journeyId: 'fjord-journey' })
  }))
  const params = sameTitle.refuse('wanttogo/convert', planned(), 'E_JOURNEY_CHOICE_REQUIRED')
  assert.deepEqual((params.candidates as { journeyId: string }[]).map(({ journeyId }) => journeyId), ['fjord-journey'])
  const kept = new Library(filesWith((files) => { recordIn(files, 'planned_bergen').journeyId = 'kept-journey' }))
  kept.save('wanttogo/convert', planned())
  assert.equal(kept.record('planned_bergen')!.journeyId, 'kept-journey')
})

test('planned → footprint refused, with the old messages: no id, a missing or visited record, no coordinates, no date; an empty library', () => {
  const library = new Library()
  library.refuse('wanttogo/convert', { source: 'planned', startDate: '2026-07-01' }, 'E_REQUIRED', { field: 'recordId' }, '请填写旅行计划 id。')
  library.refuse('wanttogo/convert', planned({ recordId: 'missing' }), 'E_PLANNED_NOT_FOUND', { recordId: 'missing' }, '找不到这条旅行计划。')
  library.refuse('wanttogo/convert', planned({ recordId: 'sample_vik' }), 'E_PLANNED_NOT_FOUND', { recordId: 'sample_vik' }, '找不到这条旅行计划。')
  library.refuse('wanttogo/convert', { source: 'planned', recordId: 'planned_bergen' }, 'E_REQUIRED', { field: 'startDate' }, '请填写到访日期。')
  const noCoordinates = new Library(filesWith((files) => Object.assign(recordIn(files, 'planned_bergen'), { lat: null, lng: null })))
  noCoordinates.refuse('wanttogo/convert', planned(), 'E_PLANNED_NO_COORDINATES', { recordId: 'planned_bergen' }, '这条旅行计划没有坐标，无法转为足迹。')
  new Library(emptyFiles()).refuse('wanttogo/convert', planned(), 'E_PLANNED_NOT_FOUND')
})

test('want-to-go → footprint, the journey choice: the candidate (trimmed title, dates, cities and the total), nothing written; journeyId joins it (a route); newJourney is a journey of its own', () => {
  const library = new Library()
  const params = library.refuse('wanttogo/convert', fromWantToGo(NUUK_ITEM, { tripTitle: ` ${DEMO_TITLE} ` }), 'E_JOURNEY_CHOICE_REQUIRED', undefined,
    '已有同名的行程，请选择加入已有行程，或新建一个行程。本次尚未保存。')
  assert.equal(params.tripTitle, DEMO_TITLE)
  const [candidate, ...rest] = params.candidates as { journeyId: string; startDate: string; endDate: string; cityCount: number; cities: unknown[] }[]
  assert.equal(rest.length, 0)
  assert.deepEqual([candidate.journeyId, candidate.startDate, candidate.endDate, candidate.cityCount, candidate.cities.length], [DEMO_JOURNEY, '2025-06-01', '2025-06-09', 6, 5])
  const nuuk = library.place('Nuuk').id

  const joined = new Library()
  const join = joined.save<Converted>('wanttogo/convert', fromWantToGo(NUUK_ITEM, { tripTitle: DEMO_TITLE, journeyId: DEMO_JOURNEY }))
  assert.equal(joined.record(join.travelRecordId)!.journeyId, DEMO_JOURNEY)
  assert.deepEqual(routesTouching(joined, nuuk), [{ journeyId: DEMO_JOURNEY, fromCityId: joined.place('Klaksvik').id, toCityId: nuuk }])

  const separate = new Library()
  const before = journeyIds(separate)
  const own = separate.save<Converted>('wanttogo/convert', fromWantToGo(NUUK_ITEM, { tripTitle: DEMO_TITLE, newJourney: true }))
  const record = separate.record(own.travelRecordId)!
  assert.ok(typeof record.journeyId === 'string' && !before.has(record.journeyId))
  assert.equal(record.trip_title, DEMO_TITLE)
  assert.deepEqual(routesTouching(separate, nuuk), [], 'not joined to the journey of that title')
})

test('want-to-go → footprint, the journey choice refused: not a candidate of the title, or malformed → E_UNKNOWN_JOURNEY; the default title a journey uses asks too; another title makes a new journey', () => {
  const library = new Library()
  for (const extra of [
    { tripTitle: DEMO_TITLE, journeyId: 'journey-missing' },
    { tripTitle: '2026 Greenland', journeyId: DEMO_JOURNEY },
    { journeyId: DEMO_JOURNEY },
    { tripTitle: DEMO_TITLE, journeyId: 7 },
    { tripTitle: DEMO_TITLE, newJourney: 'true' },
    { tripTitle: DEMO_TITLE, journeyId: DEMO_JOURNEY, newJourney: true },
  ]) library.refuse('wanttogo/convert', fromWantToGo(NUUK_ITEM, extra), 'E_UNKNOWN_JOURNEY', undefined, '要加入的行程不是同名的已有行程，未保存。请重新选择。')

  const sameDefault = new Library(filesWith((files) => Object.assign(recordIn(files, 'alias_klaksvik'), { trip_title: '格陵兰 · 努克', journeyId: 'journey-old-nuuk' })))
  const params = sameDefault.refuse('wanttogo/convert', fromWantToGo(NUUK_ITEM), 'E_JOURNEY_CHOICE_REQUIRED')
  assert.equal(params.tripTitle, '格陵兰 · 努克')
  assert.deepEqual((params.candidates as { journeyId: string }[]).map((candidate) => candidate.journeyId), ['journey-old-nuuk'])
  const join = sameDefault.save<Converted>('wanttogo/convert', fromWantToGo(NUUK_ITEM, { journeyId: 'journey-old-nuuk' }))
  assert.equal(sameDefault.record(join.travelRecordId)!.journeyId, 'journey-old-nuuk')

  const fresh = new Library()
  const before = journeyIds(fresh)
  const own = fresh.save<Converted>('wanttogo/convert', fromWantToGo(NUUK_ITEM, { tripTitle: '2026 Greenland' }))
  const journeyId = fresh.record(own.travelRecordId)!.journeyId
  assert.ok(typeof journeyId === 'string' && !before.has(journeyId))
})

test('planned → footprint, the journey choice: without a journey it joins or starts one by the choice; with a journey of its own any choice is E_UNKNOWN_JOURNEY', () => {
  const files = () => filesWith((v2) => Object.assign(recordIn(v2, 'sample_gjogv'), { trip_title: recordIn(v2, 'planned_bergen').trip_title, journeyId: 'fjord-journey' }))
  const joined = new Library(files())
  const bergen = joined.place('Bergen').id
  joined.save('wanttogo/convert', planned({ journeyId: 'fjord-journey' }))
  assert.equal(joined.record('planned_bergen')!.journeyId, 'fjord-journey')
  assert.deepEqual(routesTouching(joined, bergen).map((route) => route.journeyId), ['fjord-journey'])

  const separate = new Library(files())
  const before = journeyIds(separate)
  separate.save('wanttogo/convert', planned({ newJourney: true }))
  const journeyId = separate.record('planned_bergen')!.journeyId
  assert.ok(typeof journeyId === 'string' && !before.has(journeyId))
  assert.deepEqual(routesTouching(separate, bergen), [])
  new Library(files()).refuse('wanttogo/convert', planned({ journeyId: DEMO_JOURNEY }), 'E_UNKNOWN_JOURNEY')

  const kept = new Library(filesWith((v2) => { recordIn(v2, 'planned_bergen').journeyId = 'kept-journey' }))
  for (const choice of [{ journeyId: 'kept-journey' }, { journeyId: DEMO_JOURNEY }, { newJourney: true }]) {
    kept.refuse('wanttogo/convert', planned(choice), 'E_UNKNOWN_JOURNEY')
  }
})
