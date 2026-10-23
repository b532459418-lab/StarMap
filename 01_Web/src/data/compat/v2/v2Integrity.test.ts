/// <reference types="node" />
/**
 * The integrity check of V2 files (./v2Integrity.ts: backups and recovery checks of roots that hold V2 files, the browser
 * fixture). 3C-5 E review R1: ported from the retired v2write/transaction.test.ts, where these helpers were born.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WRITE_NOW, migratedFiles, placeNamed } from '../../editor/editor.fixture.ts'
import { completeForWrite, danglingPlaceRefs, emptyV2FilesForWrite, integrityProblems, placeRefs } from './v2Integrity.ts'
import { readV2 } from './v2Reader.ts'
import { V2_FILE_KEYS, validateV2Files, type V2Files } from './v2Schema.ts'

const GHOST = '019b76da-ffff-7000-8000-00000000ffff'

test('the empty files of a new V2 root: travel schema_version 2, private-local, empty display rules; want-to-go local-only; valid and empty when read', () => {
  const empty = emptyV2FilesForWrite(WRITE_NOW)
  assert.deepEqual(validateV2Files(empty), [])
  assert.deepEqual(integrityProblems(empty), [])
  assert.deepEqual([empty.travel.schema_version, empty.travel.privacy_level], [2, 'private-local'])
  assert.deepEqual(empty.travel.display, { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] })
  assert.equal(empty.wantToGo.privacy_level, 'local-only')
  assert.deepEqual([empty.places.schema_version, empty.editorState.schemaVersion, empty.media.schemaVersion], [1, 2, 3])
  const canonical = readV2(empty)
  assert.equal(canonical.places.length + canonical.travel.records.length + canonical.wantToGo.items.length + canonical.media.items.length, 0)
})

test('completeForWrite: missing files become the empty templates, present ones deep copies (no shared reference, invalid ones too)', () => {
  const files = migratedFiles()
  const completed = completeForWrite({ places: files.places, travel: { broken: true } }, WRITE_NOW)
  assert.deepEqual(Object.keys(completed), V2_FILE_KEYS)
  assert.deepEqual(completed.places, files.places)
  assert.notEqual(completed.places, files.places)
  assert.deepEqual(completed.travel, { broken: true })
  assert.deepEqual(completed.wantToGo, emptyV2FilesForWrite(WRITE_NOW).wantToGo)
})

test('placeRefs covers every place reference; danglingPlaceRefs finds each dangling one', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const reykjavik = placeNamed(files, 'Reykjavik').id
  files.travel.display = { ...files.travel.display, homeHiddenCountryIds: [iceland], originCountryIds: [iceland], regionCountryIds: [iceland], navigationHiddenCityIds: [reykjavik] }
  files.editorState = {
    ...files.editorState,
    addedCountries: [{ placeId: iceland }],
    hiddenCountryIds: [iceland],
    cityOrderByCountry: { [iceland]: [reykjavik] },
    mediaOrderByCity: { [reykjavik]: ['photo-reykjavik-1'] },
    droneOrderByCity: { [reykjavik]: [] },
  }
  const wheres = new Set(placeRefs(files).map((ref) => ref.where.replace(/\(.*\)$/, '').replace(/\..*$/, '')))
  for (const where of [
    'partOf', 'display', 'records', 'items', 'addedCountries', 'countryOrder', 'hiddenCountryIds',
    'cityOrderByCountry', 'hiddenCityIds', 'mediaOrderByCity', 'coverMediaByCity', 'droneOrderByCity',
  ]) assert.ok(wheres.has(where), where)
  assert.deepEqual(danglingPlaceRefs(files), [])
  const broken = structuredClone(files) as V2Files
  broken.places.places = broken.places.places.map((place) => (place.id === reykjavik ? { ...place, id: GHOST } : place))
  const dangling = danglingPlaceRefs(broken)
  assert.ok(dangling.length >= 8, String(dangling.length))
  assert.ok(dangling.every((ref) => ref.id === reykjavik))
})

test('integrityProblems: validateV2Files\' problems first; dangling references when the shape is valid; only files, paths and problems', () => {
  const files = migratedFiles()
  assert.deepEqual(integrityProblems(files), [])
  const withGhost = structuredClone(files) as V2Files
  withGhost.editorState.hiddenCityIds.push(GHOST)
  const problems = integrityProblems(withGhost)
  assert.ok(problems.some((problem) => problem.startsWith('editorState $.hiddenCityIds[1]')), problems.join('\n'))
  assert.ok(problems.every((problem) => !problem.includes('雷克雅未克')), 'no values')
})
