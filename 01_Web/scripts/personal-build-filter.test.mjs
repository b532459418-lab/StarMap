/**
 * scripts/personal-build-filter.mjs (batch 7, review S3): the personal build keeps only what its pages can show.
 * Synthetic fixtures only (./personal-build-filter.fixture.mjs and the repository's frozen fixtures and sample).
 *
 * 1. Derivation: everything a page shows (map, Journey and timeline, Want to Go, Collection, city photos and drone
 *    media) is the same for the filtered files as for all files once the hidden entries are taken out.
 * 2. No id, original file name, name or coordinate of removed content is left in the filtered files.
 * 3. The filtered files pass the V2 checks with no new problem.
 * 4. The media file list holds only files of kept media.
 * 5. Without hidden content the five files come back as they were (same JSON text).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { filterForPersonalBuild, mediaFileOf } from './personal-build-filter.mjs'
import { hiddenContentFixture, ID, KEPT_HIDDEN_PLACES, REMOVED } from './personal-build-filter.fixture.mjs'
import { readV2SampleFiles } from './v2-sample.mjs'
import { renderPrivateDataModule, privateDataModuleExports } from './private-data-module.mjs'
import { canonicalForInputs, V2FilesInvalidError } from '../src/data/canonical/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'
import { buildBaseline } from '../src/data/derive/baseline.ts'
import { integrityProblems } from '../src/data/v2write/transaction.ts'

const NOW = '2000-01-01T00:00:00.000Z'
const baselineOf = (files) => buildBaseline(deriveAppDataFromCanonical(canonicalForInputs({ v2Files: files }), { now: NOW }), { now: NOW })
const readFixtureJson = async (relative) => JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(new URL(relative, import.meta.url), 'utf8')))

/** A plain object without the given keys. */
const withoutKeys = (record, keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)))
const withoutIds = (list, ids) => list.filter((entry) => !ids.has(entry.id))

/**
 * What the pages show, from a baseline. Editor-only parts are left out on purpose: the editor state itself (its hidden
 * lists and orders), the convert-to-travel block reasons (the button exists only with the editor) and `countryIdOfCity`
 * for hidden cities (asked only by the editor's restore list).
 */
const shownParts = (baseline) => {
  const { travelAtlas, mediaCatalog, droneMedia, wantToGo, worldGraph } = baseline.modules
  const visibleCities = new Set(travelAtlas.cities.map((city) => city.id))
  const onlyVisibleCities = (pairs) => pairs.filter(([cityId]) => visibleCities.has(cityId))
  return {
    map: baseline.queries.visiblePlaces,
    collection: Object.fromEntries(Object.entries(baseline.queries.collection).map(([layer, entries]) => [layer, entries.filter((entry) => !entry.hidden)])),
    journey: {
      travelAtlasDisplay: travelAtlas.travelAtlasDisplay,
      countries: travelAtlas.countries,
      cities: travelAtlas.cities,
      journeyDays: travelAtlas.journeyDays,
      routes: travelAtlas.routes,
      countryById: travelAtlas.countryById,
      cityById: travelAtlas.cityById,
      missingCoordinateCities: travelAtlas.missingCoordinateCities,
      getCitiesForCountry: travelAtlas.getCitiesForCountry,
      shouldHideCityFromNavigation: travelAtlas.shouldHideCityFromNavigation,
      countryIdOfCity: onlyVisibleCities(travelAtlas.countryIdOfCity),
      plannedRecords: travelAtlas.plannedRecords,
      totalRecords: travelAtlas.travelAtlasMeta.totalRecords,
      recordsWithCoordinates: travelAtlas.travelAtlasMeta.recordsWithCoordinates,
      recordsMissingCoordinates: travelAtlas.travelAtlasMeta.recordsMissingCoordinates,
    },
    wantToGo: {
      items: wantToGo.wantToGoItems.filter((item) => !item.hidden),
      itemById: wantToGo.wantToGoItemById.filter(([, item]) => !item.hidden),
      plannedRecordById: wantToGo.plannedRecordById,
    },
    media: {
      cityPhotos: onlyVisibleCities(mediaCatalog.getCityPhotos),
      cityCovers: onlyVisibleCities(mediaCatalog.getCityCoverPhoto),
      droneForCity: onlyVisibleCities(droneMedia.getDroneMediaForCity),
      hasDrone: onlyVisibleCities(droneMedia.hasDroneMedia),
    },
    snapshots: {
      travel: worldGraph.travelSnapshot,
      planned: worldGraph.plannedSnapshot,
      wantToGoMemberships: worldGraph.wantToGoSnapshot.memberships.filter((membership) => membership.metadata?.hidden !== true),
    },
  }
}

test('1. derivation: the filtered files show exactly what all files show without the hidden entries', () => {
  const all = baselineOf(hiddenContentFixture())
  const filtered = baselineOf(filterForPersonalBuild(hiddenContentFixture()).files)
  assert.deepEqual(shownParts(filtered), shownParts(all))

  // The rest of the derivation differs only by the removed entries.
  const removedMedia = new Set(REMOVED.media)
  const removedRecords = new Set(REMOVED.records)
  const { mediaCatalog: allMedia, droneMedia: allDrone, travelAtlas: allTravel, wantToGo: allWantToGo } = all.modules
  const { mediaCatalog: media, droneMedia: drone, travelAtlas: travel, wantToGo } = filtered.modules
  assert.deepEqual(media.allImportedMediaItems, withoutIds(allMedia.allImportedMediaItems, removedMedia))
  assert.deepEqual(media.importedMediaItems, withoutIds(allMedia.importedMediaItems, removedMedia))
  assert.deepEqual(media.importedDroneMediaCatalogItems, withoutIds(allMedia.importedDroneMediaCatalogItems, removedMedia))
  assert.deepEqual(drone.droneMediaItems, withoutIds(allDrone.droneMediaItems, removedMedia))
  assert.deepEqual(drone.droneMediaById, withoutKeys(allDrone.droneMediaById, removedMedia))
  assert.deepEqual(travel.hiddenHomeRecords, withoutIds(allTravel.hiddenHomeRecords, removedRecords))
  assert.equal(travel.travelAtlasMeta.importedRecords, allTravel.travelAtlasMeta.importedRecords - 4)
  assert.deepEqual(wantToGo.hiddenWantToGoItems, [])
  assert.deepEqual(wantToGo.wantToGoItems, allWantToGo.wantToGoItems.filter((item) => !item.hidden))

  // The fixture does exercise the rules: something is shown, and the hidden city's drone media were reachable before.
  assert.ok(filtered.modules.travelAtlas.cities.length >= 2)
  assert.ok(allMedia.allImportedMediaItems.some((item) => item.id === 'd-ax'))
})

test('1b. the same holds for the frozen fixtures that hide something (a hidden city, a hidden Want to Go entry, a cover)', async () => {
  for (const relative of ['./fixtures/editor-store-v2.json', './fixtures/baseline-v2.json']) {
    const files = await readFixtureJson(relative)
    assert.deepEqual(shownParts(baselineOf(filterForPersonalBuild(files).files)), shownParts(baselineOf(files)), relative)
  }
})

test('2. no id, original file name, name or coordinate of removed content is left', () => {
  const { files, mediaFiles } = filterForPersonalBuild(hiddenContentFixture())
  const text = JSON.stringify(files)
  for (const id of [...REMOVED.records, ...REMOVED.wantToGo, ...REMOVED.media, ...REMOVED.places]) assert.ok(!text.includes(id), id)
  for (const id of REMOVED.media) assert.ok(!text.includes(`${id}-original-name.jpg`), `${id} originalFileName`)
  for (const name of ['Hiddenvik', 'Bergtown', 'Cetown', 'Fetown', 'Cland', 'Eland', 'Fland', 'hidden note', 'hidden wish']) assert.ok(!text.includes(name), name)
  for (const coordinate of REMOVED.coordinates) assert.ok(!text.includes(coordinate), coordinate)
  for (const hash of REMOVED.mediaHashes) {
    assert.ok(!text.includes(hash), hash)
    assert.ok(!mediaFiles.some((file) => file.includes(hash)), hash)
  }
  // Hidden places that visible content still points at stay, as places only.
  const placeIds = files.places.places.map((place) => place.id)
  for (const id of KEPT_HIDDEN_PLACES) assert.ok(placeIds.includes(id), id)
  assert.deepEqual(files.travel.records.map((record) => record.id), ['r-a1', 'r-a2', 'r-b2-planned'])
  assert.deepEqual(files.wantToGo.items.map((item) => item.id), ['w-ay', 'w-d'])
})

test('3. the filtered files pass the V2 checks and read without a new problem; editor references are cleaned', () => {
  const input = hiddenContentFixture()
  assert.deepEqual(validateV2Files(input), [])
  const { files } = filterForPersonalBuild(input)
  assert.deepEqual(validateV2Files(files), [])
  assert.deepEqual(integrityProblems(files), [])
  const canonical = canonicalForInputs({ v2Files: files })
  assert.deepEqual([canonical.wantToGo.problems, canonical.media.problems], [[], []])
  assert.deepEqual(files.editorState, {
    schemaVersion: 2,
    addedCountries: [{ placeId: ID.D, region: 'Europe', visitedDate: '2024-01-01' }],
    countryOrder: [ID.A, ID.D],
    hiddenCountryIds: [],
    cityOrderByCountry: { [ID.A]: [ID.a2, ID.a1] },
    hiddenCityIds: [],
    mediaOrderByCity: { [ID.a1]: ['p2', 'p1'] },
    hiddenMediaIds: [],
    coverMediaByCity: {},
    droneOrderByCity: { [ID.a1]: ['d1'] },
    hiddenDroneMediaIds: [],
    updatedAt: '2026-10-15T00:00:00.000Z',
  })
  assert.deepEqual(files.travel.display.homeHiddenCountryIds, [])
  assert.deepEqual(files.travel.display.navigationHiddenCityIds, [ID.a2])
  assert.equal(files.media.generatedAt, '2026-10-15T00:00:00.000Z', 'other top-level media fields stay')
})

test('3b. invalid files are refused instead of being inlined unfiltered; missing files stay missing', () => {
  const broken = hiddenContentFixture()
  broken.travel.records[0].placeId = 'not-a-place'
  assert.throws(() => filterForPersonalBuild(broken), V2FilesInvalidError)
  assert.deepEqual(filterForPersonalBuild(undefined).files, Object.fromEntries(V2_FILE_KEYS.map((key) => [key, undefined])))
  const onlyPlaces = { places: hiddenContentFixture().places }
  const { files } = filterForPersonalBuild(onlyPlaces)
  assert.deepEqual(Object.keys(files).filter((key) => files[key] !== undefined), ['places'])
  assert.equal(files.places, onlyPlaces.places)
})

test('4. the media file list names only files of kept media, originals and derivatives alike', () => {
  const { mediaFiles } = filterForPersonalBuild(hiddenContentFixture())
  assert.deepEqual(mediaFiles, [
    '1111111111111111/original.jpg', '1111111111111111/preview.webp', '1111111111111111/thumb.webp',
    '3333333333333333/original.jpg', '3333333333333333/preview.webp', '3333333333333333/thumb.webp',
    'legacy/p2.jpg',
  ])
  assert.equal(mediaFileOf('/media/user/a%20b/c.jpg'), 'a b/c.jpg')
  assert.equal(mediaFileOf('/media/user/abc/thumb.webp?v=2'), 'abc/thumb.webp')
  // The URL's path as a browser requests it: dot segments are resolved first, so these stay inside media/user.
  assert.equal(mediaFileOf('/media/user/a/%2e%2e/b.jpg'), 'b.jpg')
  for (const src of ['/media/user/../secret.jpg', '/assets/x.jpg', '/media/user/', '/media/user/a//b.jpg', 'https://example.com/media/user/x.jpg', '//example.com/media/user/x.jpg', 42, undefined, '/media/user/a%5Cb.jpg', '/media/user/a%00b.jpg', '/media/user/%E0%A4%A.jpg']) {
    assert.equal(mediaFileOf(src), undefined, String(src))
  }
})

test('5. without hidden content the files come back as they were, to the byte', async () => {
  const visibleOnly = hiddenContentFixture()
  Object.assign(visibleOnly.editorState, { hiddenCountryIds: [], hiddenCityIds: [], hiddenMediaIds: [], hiddenDroneMediaIds: [] })
  for (const item of visibleOnly.wantToGo.items) item.hidden = false
  const inputs = [
    ['synthetic, nothing hidden', visibleOnly],
    ['public V2 sample', readV2SampleFiles()],
    ['frozen baseline fixture', await readFixtureJson('./fixtures/baseline-v2.json')],
    ['frozen backup fixture', await readFixtureJson('./fixtures/bak-files-v2.json')],
  ]
  const compared = []
  for (const [name, files] of inputs) {
    const hidden = files.editorState
      && [files.editorState.hiddenCountryIds, files.editorState.hiddenCityIds, files.editorState.hiddenMediaIds, files.editorState.hiddenDroneMediaIds].some((list) => list.length > 0)
    if (hidden || files.wantToGo?.items.some((item) => item.hidden)) continue
    const render = (v2Values) => renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', v2Values }))
    assert.equal(render(filterForPersonalBuild(files).files), render(files), name)
    assert.equal(JSON.stringify(filterForPersonalBuild(files).files), JSON.stringify(Object.fromEntries(V2_FILE_KEYS.map((key) => [key, files[key]]))), name)
    compared.push(name)
  }
  // The frozen baseline fixture hides a city, so it is covered by test 1b instead.
  assert.deepEqual(compared, ['synthetic, nothing hidden', 'public V2 sample', 'frozen backup fixture'])
})
