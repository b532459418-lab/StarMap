/// <reference types="node" />
/**
 * `POST /countries` and `POST /countries/delete` through the native engine: the behaviour the retired
 * v2write/footprint.test.ts pinned on V2 files (3C-5 E review R1), asserted on the official view, its derivation and the
 * refusals (code, parameters, message).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAppDataFromCanonical } from '../../canonical/derive.ts'
import type { CanonicalData } from '../../canonical/types.ts'
import type { V2Files } from '../../compat/v2/v2Schema.ts'
import { GHOST_ID, WRITE_NOW } from '../editor.fixture.ts'
import { Library, emptyFiles, filesWith } from './writes.fixture.ts'

const countryOf = (canonical: CanonicalData, countryId: string) => deriveAppDataFromCanonical(canonical, { now: WRITE_NOW.toISOString() }).travelAtlas.countryById[countryId]
const idIn = (files: V2Files, en: string) => files.places.places.find((place) => place.names.en === en)!.id
const hidden = (...names: string[]) => (files: V2Files) => {
  files.editorState.hiddenCountryIds = [...new Set([...files.editorState.hiddenCountryIds, ...names.map((name) => idIn(files, name))])]
}
const hideCountry = (library: Library, countryId: string) => library.save('view', { operations: [{ op: 'hide', scope: 'countries', add: [countryId], remove: [] }] })

test('a new country: its place from the catalog, the added country (place, region, visit date), the country order by latest visit', () => {
  const library = new Library()
  const order = library.view.editorState.countryOrder
  const { countryId } = library.save<{ countryId: string }>('countries', { countryCode: 'jp', visitedDate: '2026-05-01' })
  assert.equal(countryId, library.place('Japan').id)
  assert.deepEqual(library.view.editorState.addedCountries, [{ placeId: countryId, region: 'Asia', visitedDate: '2026-05-01' }])
  assert.deepEqual(library.view.editorState.countryOrder, [countryId, ...order])
  // An earlier date goes after the later ones.
  const older = new Library()
  older.save('countries', { countryCode: 'JP', visitedDate: '2020-01-01' })
  assert.deepEqual(older.view.editorState.countryOrder, [...order, older.place('Japan').id])
})

test('a country place that exists (only Want to Go or a planned record uses it) is used: no new place', () => {
  for (const [name, code] of [['Greenland', 'GL'], ['Norway', 'NO']]) {
    const library = new Library()
    const places = library.view.places.length
    library.save('countries', { countryCode: code, visitedDate: '2023-01-01' })
    assert.equal(library.view.places.length, places, name)
    assert.deepEqual(library.view.editorState.addedCountries.map((country) => country.placeId), [library.place(name).id], name)
  }
})

test('an added country\'s continent stays after its first and later cities, and with all its cities hidden; the records get no region', () => {
  const library = new Library()
  const { countryId: japan } = library.save<{ countryId: string }>('countries', { countryCode: 'JP', visitedDate: '2026-05-01' })
  const added = library.view.editorState.addedCountries
  assert.deepEqual(countryOf(library.view, japan).keywords, ['Asia'])
  for (const [city, cityEn, lat, lng] of [['东京', 'Tokyo', 35.6762, 139.6503], ['京都', 'Kyoto', 35.0116, 135.7681]] as const) {
    library.save('records', { country: '日本', country_en: 'Japan', country_code: 'JP', city, city_en: cityEn, start_date: '2026-05-02', lat, lng })
    assert.deepEqual(countryOf(library.view, japan).keywords, ['Asia'])
    assert.equal(Object.hasOwn(library.lastRecord, 'region'), false)
    assert.deepEqual(library.view.editorState.addedCountries, added, 'the added country is not rewritten')
  }
  const cities = countryOf(library.view, japan).cityIds
  assert.equal(cities.length, 2)
  library.save('view', { operations: [{ op: 'hide', scope: 'cities', add: cities, remove: [] }] })
  assert.deepEqual(countryOf(library.view, japan).keywords, ['Asia'])
  assert.deepEqual(countryOf(library.view, japan).cityIds, [])
})

test('the region falls back by country id: a record\'s region first; another country\'s region never; no region stays unknown (the derivation of the official view)', () => {
  const library = new Library()
  const { countryId: japan } = library.save<{ countryId: string }>('countries', { countryCode: 'JP', visitedDate: '2026-05-01' })
  library.save('records', { country: '日本', country_en: 'Japan', country_code: 'JP', city: '东京', city_en: 'Tokyo', start_date: '2026-05-02', lat: 35.6762, lng: 139.6503 })
  const canonical = structuredClone(library.view)
  const record = canonical.travel.records.at(-1)! as typeof canonical.travel.records[number] & { region?: string }
  record.region = 'East Asia'
  assert.deepEqual(countryOf(canonical, japan).keywords, ['East Asia'])
  delete record.region
  const added = canonical.editorState.addedCountries.find((country) => country.placeId === japan)!
  added.placeId = library.place('Iceland').id
  assert.deepEqual(countryOf(canonical, japan).keywords, [], 'another country\'s region does not apply')
  added.placeId = japan
  delete added.region
  assert.deepEqual(countryOf(canonical, japan).keywords, [], 'a missing region stays unknown')
})

test('a country in the footprint (a visited record, or added already) → E_COUNTRY_EXISTS { countryId }', () => {
  const library = new Library()
  library.refuse('countries', { countryCode: 'IS', visitedDate: '2026-01-01' }, 'E_COUNTRY_EXISTS', { countryId: library.place('Iceland').id }, '这个国家已经存在于国家足迹中。')
  library.save('countries', { countryCode: 'JP', visitedDate: '2026-01-01' })
  library.refuse('countries', { countryCode: 'jp', visitedDate: '2026-02-01' }, 'E_COUNTRY_EXISTS')
})

test('the input checks of a new country, with the old messages; a code the catalog lacks → E_COUNTRY_NOT_IN_CATALOG; two countries with the code → E_PLACE_AMBIGUOUS', () => {
  const library = new Library()
  library.refuse('countries', { visitedDate: '2026-01-01' }, 'E_REQUIRED', { field: 'countryCode' }, '请填写国家代码。')
  library.refuse('countries', { countryCode: 'JP' }, 'E_REQUIRED', { field: 'visitedDate' }, '请填写首次到访日期。')
  library.refuse('countries', { countryCode: 'JP', visitedDate: '2026-1-1' }, 'E_DATE_FORMAT', { field: 'visitedDate' }, '首次到访日期必须使用 YYYY-MM-DD。')
  library.refuse('countries', { countryCode: 'ZZ', visitedDate: '2026-01-01' }, 'E_COUNTRY_NOT_IN_CATALOG', { iso: 'ZZ' }, '没有找到这个国家，请从候选列表中选择。')
  library.refuse('countries', { countryCode: 'JPN', visitedDate: '2026-01-01' }, 'E_COUNTRY_NOT_IN_CATALOG', { iso: 'JPN' })
  const twoDenmarks = new Library(filesWith((files) => {
    for (const id of ['019b76da-a8f5-7000-8000-0000000000f5', '019b76da-a8f6-7000-8000-0000000000f6']) {
      files.places.places.push({ id, subtype: 'country', names: { en: `Denmark ${id.slice(-1)}` }, externalIds: { iso3166Alpha2: 'DK' } })
    }
  }))
  twoDenmarks.refuse('countries', { countryCode: 'DK', visitedDate: '2026-01-01' }, 'E_PLACE_AMBIGUOUS', {
    subtype: 'country', iso: 'DK', candidates: ['019b76da-a8f5-7000-8000-0000000000f5', '019b76da-a8f6-7000-8000-0000000000f6'],
  })
})

test('an empty library: a new country is its place and the added country', () => {
  const library = new Library(emptyFiles())
  const { countryId } = library.save<{ countryId: string }>('countries', { countryCode: 'JP', visitedDate: '2026-01-01' })
  assert.deepEqual(library.view.places.map((place) => place.id), [countryId])
  assert.deepEqual(library.view.editorState.addedCountries, [{ placeId: countryId, region: 'Asia', visitedDate: '2026-01-01' }])
  library.refuse('countries/delete', { ids: [GHOST_ID] }, 'E_COUNTRY_DELETE_NOT_HIDDEN')
})

test('deleting a country: its records and its keys and values in the editor lists go; a city Want to Go uses stays, with its country', () => {
  const library = new Library(filesWith((files) => {
    const iceland = idIn(files, 'Iceland'), reykjavik = idIn(files, 'Reykjavik'), akureyri = idIn(files, 'Akureyri')
    files.media.items = files.media.items.filter((item) => item.placeId !== reykjavik)
    files.editorState.cityOrderByCountry = { [iceland]: [akureyri, reykjavik] }
    files.editorState.mediaOrderByCity = { [reykjavik]: ['gone'] }
    hidden('Iceland')(files)
  }))
  const iceland = library.place('Iceland').id
  const [reykjavik, vik, akureyri] = ['Reykjavik', 'Vik', 'Akureyri'].map((name) => library.place(name).id)
  const result = library.save('countries/delete', { ids: [` ${iceland} `, iceland] })
  assert.deepEqual(result, { deletedCountryIds: [iceland], deletedRecordCount: 3 })
  const view = library.view
  assert.equal(view.travel.records.some((record) => [reykjavik, vik, akureyri].includes(record.placeId)), false)
  const ids = new Set(view.places.map((place) => place.id))
  assert.deepEqual([ids.has(reykjavik), ids.has(vik), ids.has(akureyri), ids.has(iceland)], [false, false, true, true], 'Akureyri: a want-to-go item; Iceland: its part-of')
  assert.deepEqual(view.editorState.countryOrder, [library.place('Faroe Islands').id])
  assert.deepEqual([view.editorState.hiddenCountryIds, view.editorState.hiddenCityIds], [[], []])
  assert.deepEqual([view.editorState.cityOrderByCountry, view.editorState.coverMediaByCity, view.editorState.mediaOrderByCity], [{}, {}, {}])
})

test('deleting a country only added: the added country and its place go; a display rule that names it keeps the place and the rule', () => {
  const library = new Library()
  const { countryId: japan } = library.save<{ countryId: string }>('countries', { countryCode: 'JP', visitedDate: '2026-01-01' })
  const places = library.view.places.filter((place) => place.id !== japan)
  hideCountry(library, japan)
  assert.deepEqual(library.save('countries/delete', { ids: [japan] }), { deletedCountryIds: [japan], deletedRecordCount: 0 })
  assert.deepEqual(library.view.editorState.addedCountries, [])
  assert.deepEqual(library.view.places, places)

  // The same country named by a display rule (not shown on the home page): its place and the rule stay.
  const japanId = '019b76da-a8ff-7000-8000-0000000000ff'
  const ruled = new Library(filesWith((files) => {
    files.places.places.push({ id: japanId, subtype: 'country', names: { 'zh-Hans': '日本', en: 'Japan' }, externalIds: { iso3166Alpha2: 'JP' }, location: { lat: 36, lng: 138 } })
    files.editorState.addedCountries = [{ placeId: japanId, region: 'Asia', visitedDate: '2026-01-01' }]
    files.editorState.hiddenCountryIds = [...files.editorState.hiddenCountryIds, japanId]
    files.travel.display.homeHiddenCountryIds = [japanId]
  }))
  ruled.save('countries/delete', { ids: [japanId] })
  assert.deepEqual(ruled.view.editorState.addedCountries, [])
  assert.ok(ruled.view.places.some((place) => place.id === japanId))
  assert.deepEqual(ruled.view.travel.display.homeHiddenCountryIds, [japanId])
})

test('the preconditions of a delete, with the old messages: no ids, a country not hidden, a country without data, cities with media', () => {
  const library = new Library()
  library.refuse('countries/delete', {}, 'E_COUNTRY_DELETE_EMPTY', undefined, '没有可删除的隐藏国家。')
  library.refuse('countries/delete', { ids: [' '] }, 'E_COUNTRY_DELETE_EMPTY')
  library.refuse('countries/delete', { ids: [library.place('Iceland').id] }, 'E_COUNTRY_DELETE_NOT_HIDDEN', undefined, '只能彻底删除已经隐藏的国家。')
  const greenland = new Library(filesWith(hidden('Greenland')))
  greenland.refuse('countries/delete', { ids: [greenland.place('Greenland').id] }, 'E_COUNTRY_DELETE_NO_DATA', undefined, '找不到待删除国家的本地旅行数据，已停止删除。')
  // Tórshavn has one drone photo; Reykjavík two photos.
  const faroe = new Library(filesWith(hidden('Faroe Islands')))
  faroe.refuse('countries/delete', { ids: [faroe.place('Faroe Islands').id] }, 'E_COUNTRY_HAS_MEDIA', undefined,
    '以下城市仍有照片或无人机影像：托尔斯港（1 个媒体）。请先在对应城市中彻底删除这些媒体。')
  const both = new Library(filesWith(hidden('Iceland', 'Faroe Islands')))
  both.refuse('countries/delete', { ids: [both.place('Iceland').id, both.place('Faroe Islands').id] }, 'E_COUNTRY_HAS_MEDIA', undefined,
    '以下城市仍有照片或无人机影像：雷克雅未克（2 个媒体）、托尔斯港（1 个媒体）。请先在对应城市中彻底删除这些媒体。')
})
