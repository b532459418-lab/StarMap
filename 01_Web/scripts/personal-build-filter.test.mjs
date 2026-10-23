/**
 * src/data/store/personalBuildReadModel.ts (batch 7, review S3; 3C-5B spec §2.4: the filter works on the read model):
 * the personal build keeps only what its pages can show. Batch 7's tests, moved over: every V2 input is migrated in
 * memory into a read model (scripts/compat/store-migrate.mjs migrationReadModel, as the plugin does for a root that is not a
 * library yet), filtered, and read through the official view as the App reads it.
 * Synthetic fixtures only (./personal-build-filter.fixture.mjs and the repository's frozen fixtures and samples).
 *
 * 1. Derivation: everything a page shows (map, Journey and timeline, Want to Go, Collection, city photos and drone
 *    media) is the same for the filtered read model as for the whole one once the hidden entries are taken out.
 * 2. No id, original file name, name or coordinate of removed content is left in the filtered read model.
 * 3. The filtered read model passes the full read-model check, its V2 view the V2 checks, with no new problem.
 * 4. The media file list holds only files of kept media.
 * 5. Without hidden content the read model comes back as it was (same JSON text).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hiddenContentFixture, ID, KEPT_HIDDEN_PLACES, REMOVED } from './personal-build-filter.fixture.mjs'
import { migrationReadModel } from './compat/store-migrate.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { readV2SampleFiles } from './compat/v2-sample.mjs'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { validateV2Files } from '../src/data/compat/v2/v2Schema.ts'
import { buildBaseline } from '../src/data/derive/baseline.ts'
import { OFFICIAL_POLICY, VIEW_SCOPES } from '../src/data/store/officialDefinitions.ts'
import { PERSONAL_BUILD_CLEARED_SCOPES, filterReadModelForPersonalBuild, mediaFileOf } from '../src/data/store/personalBuildReadModel.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { integrityProblems } from '../src/data/compat/v2/v2Integrity.ts'
import { formalStateOfReadModel, readModelOf } from '../src/worldgraph/readModel/build.ts'
import { validateReadModel } from '../src/worldgraph/readModel/check.ts'
import { emptyFormalState } from '../src/worldgraph/store/formal.ts'

const NOW = '2000-01-01T00:00:00.000Z'
const readModelOfFiles = (files) => migrationReadModel(files, { now: '2026-10-15T00:00:00.000Z' }).model
const baselineOf = (model) => buildBaseline(deriveAppDataFromCanonical(officialViewOf(model, 'local'), { now: NOW }), { now: NOW })
const readFixtureJson = async (relative) => JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(new URL(relative, import.meta.url), 'utf8')))
const v2ViewOf = (model) => projectToV2Files(formalStateOfReadModel(model)).files

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

test('1. derivation: the filtered read model shows exactly what the whole one shows without the hidden entries', () => {
  const model = readModelOfFiles(hiddenContentFixture())
  const all = baselineOf(model)
  const filtered = baselineOf(filterReadModelForPersonalBuild(model).model)
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
    const model = readModelOfFiles(await readFixtureJson(relative))
    assert.deepEqual(shownParts(baselineOf(filterReadModelForPersonalBuild(model).model)), shownParts(baselineOf(model)), relative)
  }
})

test('2. no id, original file name, name or coordinate of removed content is left', () => {
  const { model, mediaFiles } = filterReadModelForPersonalBuild(readModelOfFiles(hiddenContentFixture()))
  const text = JSON.stringify(model)
  for (const id of [...REMOVED.records, ...REMOVED.wantToGo, ...REMOVED.media, ...REMOVED.places]) assert.ok(!text.includes(id), id)
  for (const id of REMOVED.media) assert.ok(!text.includes(`${id}-original-name.jpg`), `${id} originalFileName`)
  for (const name of ['Hiddenvik', 'Bergtown', 'Cetown', 'Fetown', 'Cland', 'Eland', 'Fland', 'hidden note', 'hidden wish']) assert.ok(!text.includes(name), name)
  for (const coordinate of REMOVED.coordinates) assert.ok(!text.includes(coordinate), coordinate)
  for (const hash of REMOVED.mediaHashes) {
    assert.ok(!text.includes(hash), hash)
    assert.ok(!mediaFiles.some((file) => file.includes(hash)), hash)
  }
  // 3C-5B: a journey whose every record went goes too (its entity's source record is the journey id); j1 keeps two.
  for (const journey of ['j2', 'j3', 'j4']) assert.ok(!text.includes(`"${journey}"`), journey)
  assert.ok(text.includes('"j1"'))
  // Hidden places that visible content still points at stay, as places only.
  const view = officialViewOf(model, 'local')
  const placeIds = view.places.map((place) => place.id)
  for (const id of KEPT_HIDDEN_PLACES) assert.ok(placeIds.includes(id), id)
  assert.deepEqual(view.travel.records.map((record) => record.id), ['r-a1', 'r-a2', 'r-b2-planned'])
  assert.deepEqual(view.wantToGo.items.map((item) => item.id), ['w-ay', 'w-d'])
})

test('3. the filtered read model passes the full check, its V2 view the V2 checks; editor references are cleaned', () => {
  const input = readModelOfFiles(hiddenContentFixture())
  assert.doesNotThrow(() => validateReadModel(input, OFFICIAL_POLICY))
  const { model } = filterReadModelForPersonalBuild(input)
  assert.doesNotThrow(() => validateReadModel(model, OFFICIAL_POLICY))
  const files = v2ViewOf(model)
  assert.deepEqual(validateV2Files(files), [])
  assert.deepEqual(integrityProblems(files), [])
  const view = officialViewOf(model, 'local')
  assert.deepEqual([view.wantToGo.problems, view.media.problems], [[], []])
  assert.deepEqual(view.editorState, {
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
  assert.deepEqual(view.travel.display.homeHiddenCountryIds, [])
  assert.deepEqual(view.travel.display.navigationHiddenCityIds, [ID.a2])
  assert.equal(files.media.generatedAt, '2026-10-15T00:00:00.000Z', 'other top-level media fields stay')
  // The four hidden scopes are empty; no row of them is left.
  for (const scope of PERSONAL_BUILD_CLEARED_SCOPES) {
    assert.ok(!model.viewItems.some((item) => item.scope === scope) && !model.viewSettings.some((setting) => setting.scope === scope), scope)
  }
  assert.ok(!model.viewItems.some((item) => item.scope === VIEW_SCOPES.wantToGoHidden))
})

test('3b. something that is not a read model is refused instead of being written unfiltered; an empty library comes back as it was', () => {
  const model = readModelOfFiles(hiddenContentFixture())
  assert.throws(() => filterReadModelForPersonalBuild({ ...model, format: 'starmap.v2' }), { code: 'E_READ_MODEL_FORMAT' })
  assert.throws(() => filterReadModelForPersonalBuild({ ...model, formatVersion: 2 }), { code: 'E_READ_MODEL_TOO_NEW' })
  assert.throws(() => filterReadModelForPersonalBuild(undefined), { code: 'E_SHAPE' })
  const empty = readModelOf(emptyFormalState(), { origin: 'local' })
  const filtered = filterReadModelForPersonalBuild(empty)
  assert.equal(JSON.stringify(filtered.model), JSON.stringify(empty))
  assert.deepEqual(filtered.mediaFiles, [])
})

test('4. the media file list names only files of kept media, originals and derivatives alike', () => {
  const { mediaFiles } = filterReadModelForPersonalBuild(readModelOfFiles(hiddenContentFixture()))
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

test('5. without hidden content the read model comes back as it was, to the byte', async () => {
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
    const model = readModelOfFiles(files)
    assert.equal(JSON.stringify(filterReadModelForPersonalBuild(model).model), JSON.stringify(model), name)
    compared.push(name)
  }
  // The native public sample, as committed.
  const sample = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/data/sample/sample.read-model.json', import.meta.url), 'utf8'))
  assert.equal(JSON.stringify(filterReadModelForPersonalBuild(JSON.parse(sample)).model), JSON.stringify(JSON.parse(sample)))
  // The frozen baseline fixture hides a city, so it is covered by test 1b instead.
  assert.deepEqual(compared, ['synthetic, nothing hidden', 'public V2 sample', 'frozen backup fixture'])
})
