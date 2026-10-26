/// <reference types="node" />
/**
 * `POST /records` through the native engine: the behaviour the retired v2write/footprint.test.ts pinned on V2 files
 * (3C-5 E review R1), asserted on the official view and the refusals (code, parameters, message). Where design 3C-5 §9
 * changed the behaviour on purpose, the test says so (change 1: a new journey's id is its entity's, without `journey-`;
 * change 2: no V2-only `type`, `status` or `source`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAppDataFromCanonical } from '../../canonical/derive.ts'
import type { CanonicalPlace } from '../../canonical/types.ts'
import { GHOST_ID, SUZHOU_AH, SUZHOU_JS, WRITE_NOW } from '../editor.fixture.ts'
import { Library, emptyFiles, filesWith } from './writes.fixture.ts'

const HOFN = { lat: 64.2539, lng: -15.2082 }
/** A new city in Iceland (Höfn), by name. */
const hofnInput = (overrides: Record<string, unknown> = {}) => ({
  country: '冰岛', country_en: 'Iceland', country_code: 'is', city: '赫本', city_en: 'Hofn', start_date: '2026-07-01', end_date: '2026-07-02', ...HOFN, ...overrides,
})
const suzhouInput = (cityZh: string, at: { lat: number; lng: number }, overrides: Record<string, unknown> = {}) => ({
  country: '中国', country_en: 'China', country_code: 'CN', city: cityZh, city_en: 'Suzhou', start_date: '2026-05-01', ...at, ...overrides,
})
type Candidate = { placeId: string; names: Record<string, string>; location?: { lat: number; lng: number }; distanceKm?: number; strong: boolean }
const candidatesOf = (params: Record<string, unknown>) => params.candidates as Candidate[]
type JourneyCandidate = { journeyId: string; title: string; startDate?: string; endDate?: string; cities: { placeId: string; names: Record<string, string> }[]; cityCount: number }
const journeysOf = (params: Record<string, unknown>) => params.candidates as JourneyCandidate[]
const placeByZh = (library: Library, zh: string) => library.view.places.find((place) => place.names['zh-Hans'] === zh)!
/** The derived routes with one end at `cityId`. */
const routesTouching = (library: Library, cityId: string) => deriveAppDataFromCanonical(library.view, { now: WRITE_NOW.toISOString() }).travelAtlas.routes
  .filter((route) => route.fromCityId === cityId || route.toCityId === cityId)
  .map((route) => ({ journeyId: route.journeyId, fromCityId: route.fromCityId, toCityId: route.toCityId }))

const DEMO_TITLE = '2025 North Atlantic Demo'
const DEMO_JOURNEY = '2025-north-atlantic-demo'
const PLACE_CHOICE = '找到可能是同一个地方的已有地点，请选择要使用的地点，或新建一个独立地点。本次尚未保存。'
const JOURNEY_CHOICE = '已有同名的行程，请选择加入已有行程，或新建一个行程。本次尚未保存。'
const UNKNOWN_JOURNEY = '要加入的行程不是同名的已有行程，未保存。请重新选择。'

test('a trip title equal to a visited journey\'s (compared trimmed) asks for the journey; by place id the record has the place\'s coordinates, which the input does not move', () => {
  const library = new Library()
  const params = library.refuse('records', hofnInput({ trip_title: ' 2025 North Atlantic Demo ' }), 'E_JOURNEY_CHOICE_REQUIRED')
  assert.equal(params.tripTitle, DEMO_TITLE)
  assert.deepEqual(journeysOf(params).map(({ journeyId }) => journeyId), [DEMO_JOURNEY])
  const nuuk = library.place('Nuuk')
  const { id } = library.save<{ id: string }>('records', { placeId: nuuk.id, start_date: '2026-07-01', lat: 64.2, lng: -51.7 })
  assert.deepEqual(library.place('Nuuk').location, nuuk.location, 'the city keeps its coordinates')
  const record = library.record(id)!
  assert.deepEqual([record.placeId, record.lat, record.lng], [nuuk.id, nuuk.location!.lat, nuuk.location!.lng])
})

test('a city only Want to Go knows: by name the choice (one strong candidate), nothing written; by its id no new place, the default title from the places, the country first in the order', () => {
  const library = new Library()
  const nuuk = library.place('Nuuk')
  const greenland = library.place('Greenland').id
  const params = library.refuse('records', {
    ...hofnInput(), country: '格陵兰', country_en: 'Greenland', country_code: 'GL', city: '努克', city_en: 'nuuk', start_date: '2026-08-01', end_date: undefined,
    lat: nuuk.location!.lat, lng: nuuk.location!.lng,
  }, 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual(candidatesOf(params).map(({ placeId, strong }) => ({ placeId, strong })), [{ placeId: nuuk.id, strong: true }])
  const places = library.view.places.length
  const order = library.view.editorState.countryOrder
  const result = library.save<{ id: string }>('records', { placeId: ` ${nuuk.id} `, start_date: '2026-08-01' })
  assert.equal(library.view.places.length, places)
  const record = library.record(result.id)!
  assert.deepEqual([record.placeId, record.trip_title, Object.hasOwn(record, 'end_date')], [nuuk.id, '格陵兰 · 努克', false])
  assert.deepEqual(library.view.editorState.countryOrder, [greenland, ...order], 'Greenland (2026-08-01) is the latest; the others keep their order')
  assert.deepEqual(result, { id: record.id, countryId: greenland, cityId: nuuk.id })
})

test('by place id, a city without coordinates gets the input\'s (the place is updated); without either → E_REQUIRED (lat)', () => {
  const library = new Library(filesWith((files) => { delete files.places.places.find((place) => place.names.en === 'Nuuk')!.location }))
  const nuuk = library.place('Nuuk').id
  library.refuse('records', { placeId: nuuk, start_date: '2026-07-01' }, 'E_REQUIRED', { field: 'lat' }, '请填写纬度。')
  const { id } = library.save<{ id: string }>('records', { placeId: nuuk, start_date: '2026-07-01', lat: 64.18, lng: -51.69 })
  assert.deepEqual(library.place('Nuuk').location, { lat: 64.18, lng: -51.69 })
  assert.deepEqual([library.record(id)!.lat, library.record(id)!.lng], [64.18, -51.69])
})

test('by place id, a city any record uses (a planned one too) → E_CITY_EXISTS { cityId }; by name the same city is a choice', () => {
  const library = new Library()
  for (const name of ['Reykjavik', 'Bergen']) {
    const cityId = library.place(name).id
    library.refuse('records', { placeId: cityId, start_date: '2026-07-01' }, 'E_CITY_EXISTS', { cityId }, '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。')
  }
  library.refuse('records', hofnInput({ city: '雷克雅未克', city_en: 'REYKJAVIK' }), 'E_PLACE_CHOICE_REQUIRED')
})

test('the input checks of a record by name, with the old messages; the country code is required', () => {
  const library = new Library()
  const cases: [Record<string, unknown>, string, string][] = [
    [{ country: ' ' }, 'E_REQUIRED', '请填写国家中文名。'],
    [{ country_en: undefined }, 'E_REQUIRED', '请填写国家英文名。'],
    [{ city: '' }, 'E_REQUIRED', '请填写城市中文名。'],
    [{ city_en: 3 }, 'E_REQUIRED', '请填写城市英文名。'],
    [{ start_date: '' }, 'E_REQUIRED', '请填写到访日期。'],
    [{ start_date: '2026/07/01' }, 'E_DATE_FORMAT', '到访日期必须使用 YYYY-MM-DD。'],
    [{ end_date: '07-02' }, 'E_DATE_FORMAT', '结束日期必须使用 YYYY-MM-DD。'],
    [{ end_date: '2026-06-30' }, 'E_DATE_ORDER', '结束日期不能早于到访日期。'],
    [{ lat: null }, 'E_REQUIRED', '请填写纬度。'],
    [{ lat: 91 }, 'E_NUMBER_INVALID', '纬度无效。'],
    [{ lng: 'east' }, 'E_NUMBER_INVALID', '经度无效。'],
    [{ country_code: undefined }, 'E_COUNTRY_CODE_REQUIRED', '请填写国家代码。'],
    [{ country_code: ' ' }, 'E_COUNTRY_CODE_REQUIRED', '请填写国家代码。'],
    [{ country_code: 'isl' }, 'E_COUNTRY_CODE_INVALID', '国家代码必须是两个英文字母。'],
    [{ country_code: 'ZZ' }, 'E_COUNTRY_NOT_IN_CATALOG', '没有找到这个国家，请从候选列表中选择。'],
  ]
  for (const [overrides, code, message] of cases) library.refuse('records', hofnInput(overrides), code as never, undefined, message)
  library.refuse('records', hofnInput({ country_code: 'zz' }), 'E_COUNTRY_NOT_IN_CATALOG', { iso: 'ZZ' })
  library.refuse('records', null, 'E_REQUIRED', { field: 'country' }, '请填写国家中文名。')
})

test('several cities of that name → E_PLACE_CHOICE_REQUIRED with every candidate (no guess); two countries with the ISO code → E_PLACE_AMBIGUOUS', () => {
  const extra: CanonicalPlace[] = [
    { id: '019b76da-a8f0-7000-8000-0000000000f0', subtype: 'city', names: { 'zh-Hans': '赫本港', en: 'hofn' } },
    { id: '019b76da-a8f1-7000-8000-0000000000f1', subtype: 'city', names: { en: 'Hofn!' } },
  ]
  const library = new Library(filesWith((files) => {
    const iceland = files.places.places.find((place) => place.names.en === 'Iceland')!.id
    for (const place of extra) files.places.places.push({ ...place, partOf: iceland })
  }))
  const iceland = library.place('Iceland').id
  library.refuse('records', hofnInput(), 'E_PLACE_CHOICE_REQUIRED', {
    subtype: 'city', countryId: iceland,
    candidates: [
      { placeId: extra[0].id, names: { 'zh-Hans': '赫本港', en: 'hofn' }, strong: false },
      { placeId: extra[1].id, names: { en: 'Hofn!' }, strong: false },
    ],
  }, PLACE_CHOICE)
  // A second country with Iceland's ISO code (a V2 library may hold one): the country is not guessed either.
  const twoIcelands = new Library(filesWith((files) => {
    files.places.places.push({ id: '019b76da-a8f2-7000-8000-0000000000f2', subtype: 'country', names: { en: 'Iceland 2' }, externalIds: { iso3166Alpha2: 'IS' } })
  }))
  const params = twoIcelands.refuse('records', hofnInput(), 'E_PLACE_AMBIGUOUS', undefined, '找到多个可能的地点，请选择要使用的地点，或新建一个独立地点。本次尚未保存。')
  assert.deepEqual([params.subtype, params.iso], ['country', 'IS'])
  assert.deepEqual(params.candidates, [iceland, '019b76da-a8f2-7000-8000-0000000000f2'], 'the place ids, in registry order')
})

test('same name, another city (Suzhou / Suxian): by name the choice with the candidate\'s details; createNew → a separate place; Suzhou\'s id → E_CITY_EXISTS; same name and place → a strong candidate', () => {
  const library = new Library()
  library.save('records', suzhouInput('苏州', SUZHOU_JS))
  const suzhou = library.place('Suzhou')
  const china = library.place('China').id
  const params = library.refuse('records', suzhouInput('宿州', SUZHOU_AH, { start_date: '2026-05-03' }), 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual([params.subtype, params.countryId], ['city', china])
  const [candidate, ...rest] = candidatesOf(params)
  assert.equal(rest.length, 0)
  assert.deepEqual([candidate.placeId, candidate.names, candidate.location, candidate.strong], [suzhou.id, { 'zh-Hans': '苏州', en: 'Suzhou' }, SUZHOU_JS, false])
  assert.ok(candidate.distanceKm !== undefined && candidate.distanceKm > 350 && candidate.distanceKm < 500, String(candidate.distanceKm))

  const { id } = library.save<{ id: string }>('records', suzhouInput('宿州', SUZHOU_AH, { start_date: '2026-05-03', createNew: true }))
  assert.equal(library.view.places.filter((place) => place.names.en === 'Suzhou').length, 2, 'two places')
  const suxian = placeByZh(library, '宿州')
  assert.deepEqual(suxian, { id: suxian.id, subtype: 'city', names: { 'zh-Hans': '宿州', en: 'Suzhou' }, partOf: china, location: SUZHOU_AH })
  assert.equal(library.record(id)!.placeId, suxian.id)
  assert.deepEqual(placeByZh(library, '苏州'), suzhou, 'Suzhou unchanged')

  library.refuse('records', { placeId: suzhou.id, start_date: '2026-05-03' }, 'E_CITY_EXISTS')
  const strong = library.refuse('records', suzhouInput('苏州', SUZHOU_JS), 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual(candidatesOf(strong).filter((item) => item.strong).map(({ placeId, distanceKm }) => ({ placeId, distanceKm })), [{ placeId: suzhou.id, distanceKm: 0 }])
})

test('same name, the other way: Suzhou only on Want to Go, Suxian by name is a choice (not attached to Suzhou); choosing Suzhou\'s id uses Suzhou and its coordinates', () => {
  const library = new Library()
  library.save('wanttogo', { place: { kind: 'city', nameZh: '苏州', nameEn: 'Suzhou', countryCode: 'CN', ...SUZHOU_JS } })
  const suzhou = library.place('Suzhou')
  const params = library.refuse('records', suzhouInput('宿州', SUZHOU_AH), 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual(candidatesOf(params).map((candidate) => candidate.placeId), [suzhou.id])
  const { id } = library.save<{ id: string }>('records', { placeId: suzhou.id, start_date: '2026-05-01', lat: SUZHOU_AH.lat, lng: SUZHOU_AH.lng })
  const record = library.record(id)!
  assert.deepEqual([record.placeId, record.lat, record.lng, record.trip_title], [suzhou.id, SUZHOU_JS.lat, SUZHOU_JS.lng, '中国 · 苏州'])
  assert.deepEqual(library.place('Suzhou').location, SUZHOU_JS)
})

test('same name, either order: Suzhou then Suxian or Suxian then Suzhou, the second asks; after createNew the places and their visits are the same', () => {
  const run = (first: Record<string, unknown>, second: Record<string, unknown>) => {
    const library = new Library()
    library.save('records', first)
    library.refuse('records', second, 'E_PLACE_CHOICE_REQUIRED')
    library.save('records', { ...second, createNew: true })
    const china = library.place('China', 'country').id
    return library.view.places.filter((place) => place.partOf === china)
      .map((place) => ({ names: place.names, location: place.location, visits: library.view.travel.records.filter((record) => record.placeId === place.id).map((record) => record.start_date) }))
      .sort((left, right) => left.names['zh-Hans'].localeCompare(right.names['zh-Hans'], 'en'))
  }
  const js = suzhouInput('苏州', SUZHOU_JS, { start_date: '2026-05-01' })
  const ah = suzhouInput('宿州', SUZHOU_AH, { start_date: '2026-05-03' })
  const forward = run(js, ah)
  assert.equal(forward.length, 2)
  assert.deepEqual(forward, run(ah, js))
})

test('one of three inputs: placeId with name fields or createNew, a place that is no city, a createNew that is no boolean → E_UNKNOWN_PLACE_REF; coordinates in pairs; createNew: false is no createNew', () => {
  const library = new Library()
  const nuuk = library.place('Nuuk').id
  const dates = { start_date: '2026-07-01' }
  for (const input of [
    { placeId: GHOST_ID, ...dates },
    { placeId: library.place('Iceland').id, ...dates },
    { placeId: '', ...dates },
    { placeId: 3, ...dates },
    { placeId: nuuk, city: '努克', ...dates },
    { placeId: nuuk, country_code: 'GL', ...dates },
    { placeId: nuuk, createNew: true, ...dates },
    { placeId: nuuk, createNew: false, ...dates },
    hofnInput({ createNew: 'yes' }),
  ]) library.refuse('records', input, 'E_UNKNOWN_PLACE_REF')
  library.refuse('records', { placeId: nuuk, ...dates, lat: 64 }, 'E_COORDINATES_PAIR', undefined, '经纬度需要同时填写，或同时留空。')
  library.refuse('records', { placeId: nuuk, ...dates, lat: 64, lng: 181 }, 'E_NUMBER_INVALID', { field: 'lng' }, '经度无效。')
  library.refuse('records', { placeId: library.place('Reykjavik').id }, 'E_REQUIRED', { field: 'start_date' }, '请填写到访日期。')
  const places = library.view.places.length
  library.save('records', hofnInput({ createNew: false }))
  assert.equal(library.view.places.length, places + 1, 'by name, no candidate: a new city')
})

test('the journey choice: a title of a visited journey and no choice → the candidate (dates, five cities and the total), nothing written; journeyId joins it (a route); newJourney is a journey of its own', () => {
  const library = new Library()
  const params = library.refuse('records', hofnInput({ trip_title: DEMO_TITLE }), 'E_JOURNEY_CHOICE_REQUIRED', undefined, JOURNEY_CHOICE)
  const [candidate, ...rest] = journeysOf(params)
  assert.equal(rest.length, 0)
  assert.deepEqual({ ...candidate, cities: candidate.cities.map((city) => city.names.en) }, {
    journeyId: DEMO_JOURNEY, title: DEMO_TITLE, startDate: '2025-06-01', endDate: '2025-06-09', cities: ['Reykjavik', 'Vik', 'Akureyri', 'Torshavn', 'Gjogv'], cityCount: 6,
  })

  const joined = new Library()
  const { id } = joined.save<{ id: string }>('records', hofnInput({ trip_title: DEMO_TITLE, journeyId: ` ${DEMO_JOURNEY} ` }))
  const hofn = joined.record(id)!.placeId
  assert.equal(joined.record(id)!.journeyId, DEMO_JOURNEY)
  assert.deepEqual(routesTouching(joined, hofn), [{ journeyId: DEMO_JOURNEY, fromCityId: joined.place('Klaksvik').id, toCityId: hofn }])

  const separate = new Library()
  const journeys = new Set(separate.view.travel.records.map((record) => record.journeyId))
  const own = separate.save<{ id: string }>('records', hofnInput({ trip_title: DEMO_TITLE, newJourney: true }))
  const record = separate.record(own.id)!
  // Design 3C-5 §9 change 1: the new journey's id is its entity's (no `journey-` prefix).
  assert.ok(typeof record.journeyId === 'string' && !journeys.has(record.journeyId), String(record.journeyId))
  assert.equal(record.trip_title, DEMO_TITLE, 'the title is kept; only the journey differs')
  assert.deepEqual(routesTouching(separate, record.placeId), [], 'a journey of one city has no route')
})

test('the journey choice refused: a journeyId that is no candidate of the title, or a malformed choice → E_UNKNOWN_JOURNEY; a title nobody uses makes a new journey', () => {
  const library = new Library()
  for (const overrides of [
    { trip_title: DEMO_TITLE, journeyId: 'journey-missing' },
    { trip_title: '2026 Iceland', journeyId: DEMO_JOURNEY },
    { journeyId: DEMO_JOURNEY },
    { trip_title: DEMO_TITLE, journeyId: 3 },
    { trip_title: DEMO_TITLE, journeyId: ' ' },
    { trip_title: DEMO_TITLE, journeyId: null },
    { trip_title: DEMO_TITLE, newJourney: 'yes' },
    { trip_title: DEMO_TITLE, newJourney: null },
    { trip_title: DEMO_TITLE, journeyId: DEMO_JOURNEY, newJourney: true },
  ]) library.refuse('records', hofnInput(overrides), 'E_UNKNOWN_JOURNEY', undefined, UNKNOWN_JOURNEY)
  for (const overrides of [{ trip_title: '2026 Iceland' }, { trip_title: '2026 Iceland', newJourney: false }, { trip_title: '2026 Iceland', newJourney: true }, {}]) {
    const fresh = new Library()
    const journeys = new Set(fresh.view.travel.records.map((record) => record.journeyId))
    const { id } = fresh.save<{ id: string }>('records', hofnInput(overrides))
    const journeyId = fresh.record(id)!.journeyId
    assert.ok(typeof journeyId === 'string' && !journeys.has(journeyId), JSON.stringify(overrides))
  }
})

test('the default title ("country · city") that a journey uses asks too; with a place choice as well, the place choice comes first, one at a time', () => {
  const library = new Library()
  library.save('records', suzhouInput('苏州', SUZHOU_JS))
  const first = library.lastRecord
  assert.equal(first.trip_title, '中国 · 苏州')
  const elsewhere = { lat: 33.1, lng: 118.2 }
  for (const overrides of [{}, { journeyId: 'journey-missing' }, { newJourney: true }]) {
    library.refuse('records', suzhouInput('苏州', elsewhere, overrides), 'E_PLACE_CHOICE_REQUIRED')
  }
  const params = library.refuse('records', suzhouInput('苏州', elsewhere, { createNew: true }), 'E_JOURNEY_CHOICE_REQUIRED')
  assert.equal(params.tripTitle, '中国 · 苏州')
  assert.deepEqual(journeysOf(params).map(({ journeyId, cityCount }) => ({ journeyId, cityCount })), [{ journeyId: first.journeyId, cityCount: 1 }])
  const { id } = library.save<{ id: string }>('records', suzhouInput('苏州', elsewhere, { createNew: true, newJourney: true }))
  const record = library.record(id)!
  assert.notEqual(record.placeId, first.placeId)
  assert.notEqual(record.journeyId, first.journeyId)
  assert.equal(record.trip_title, '中国 · 苏州')

  // By place id too: a city only Want to Go knows, whose default title a journey uses.
  const wished = new Library()
  wished.save('records', suzhouInput('苏州', SUZHOU_JS))
  const journey = wished.lastRecord.journeyId
  wished.save('wanttogo', { place: { kind: 'city', nameZh: '苏州', nameEn: 'Soochow', countryCode: 'CN', ...elsewhere }, createNew: true })
  const soochow = wished.place('Soochow').id
  wished.refuse('records', { placeId: soochow, start_date: '2026-06-01' }, 'E_JOURNEY_CHOICE_REQUIRED')
  const joined = wished.save<{ id: string }>('records', { placeId: soochow, start_date: '2026-06-01', journeyId: journey })
  assert.equal(wished.record(joined.id)!.journeyId, journey)
})

test('an empty library: the country from the catalog (names, ISO code, its centre), the city, the record and the country order; nothing from a sample', () => {
  const library = new Library(emptyFiles())
  const result = library.save<{ countryId: string; cityId: string }>('records', {
    country: '日本', country_en: 'Japan', country_code: 'jp', city: '东京', city_en: 'Tokyo', start_date: '2024-04-01', lat: 35.68, lng: 139.69,
  })
  assert.equal(library.view.places.length, 2)
  const japan = library.place('Japan')
  assert.deepEqual(japan, { id: japan.id, subtype: 'country', names: { 'zh-Hans': '日本', en: 'Japan' }, externalIds: { iso3166Alpha2: 'JP' }, location: { lat: 36, lng: 138 } })
  assert.equal(result.countryId, japan.id)
  assert.equal(library.view.travel.records.length, 1)
  assert.deepEqual(library.view.editorState.countryOrder, [japan.id])
  assert.ok(!JSON.stringify(library.view).includes('sample'), 'no sample data')
})
