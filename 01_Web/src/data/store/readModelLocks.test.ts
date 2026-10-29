/// <reference types="node" />
/** The read-model path against the existing locks (3C-5A spec §2.5): every V2 fixture → migration → read model →
 * official view (projectStoreToCanonical on formalStateOfReadModel) must equal what readV2 gives for the same files,
 * derive the same baseline, hit the same derived-hash lock where one exists, and give the same time query context
 * (which the baseline does not cover).
 *
 * Inputs: every V2 input of the migration tests (./v2Store.fixture.ts migrationInputs: the public sample, the G2 and
 * 3C-1b fixtures, the frozen migrated and V2-space canonicals) and the three frozen V2 files of the script tests.
 * Not covered, because they cannot be migrated: the old-id-space canonicals (their place ids are old keys, not store
 * ids) and the V2-space `countryOfCity` (not valid V2: its editor state hides a city the registry does not have).
 * The 3C-1b tests themselves are unchanged.
 *
 * 3C-5B: the App's own path is checked too: the read model as the virtual module inlines it (JSON), read with
 * readReadModel and seen through officialViewOf (./projectCanonical.ts; ../appStoreCore.ts and ../rawInputs.ts make exactly
 * these calls). Its derived baseline must hit the same locks and its time query context must equal the readV2 path's.
 *
 * 3C-5 G: a media item without a place, created the way an import creates it, changes nothing the official view gives:
 * the same Canonical, the same locked baseline; the official reader lists it with placelessMedia().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { formalStateOfReadModel, readModelOf } from '../../worldgraph/readModel/build.ts'
import { readReadModel, validateReadModel } from '../../worldgraph/readModel/check.ts'
import { MIGRATED_LOCKS, V2_FILES_LOCKS, V2_SAMPLE_BASELINE_SHA256, V2_SPACE_LOCKS, lockedFixtureUrl } from '../canonical/baselineLocks.fixture.ts'
import { canonicalForInputs } from '../compat/v2/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import type { CanonicalData } from '../canonical/types.ts'
import type { V2Files } from '../compat/v2/v2Schema.ts'
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import { deriveTimeQueryContext } from '../derive/timeQueryContext.ts'
import { OFFICIAL_POLICY } from './officialDefinitions.ts'
import { officialViewOf, projectStoreToCanonical } from './projectCanonical.ts'
import { NOW as FIXTURE_NOW, migrateIntoEmptyStore, migrationInputs } from './v2Store.fixture.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import type { FormalState } from '../../worldgraph/store/formal.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import type { CanonicalMediaItem } from '../canonical/types.ts'
import { createMediaRecordCommands } from './mediaRecords.ts'
import { memoryScopeReader } from './scopeReader.ts'
import { officialReader } from './officialReader.ts'
import { indexReadModel } from '../../worldgraph/readModel/lookup.ts'

const NOW = '2000-01-01T00:00:00.000Z'
const baselineText = (canonical: CanonicalData) => stableStringify(buildBaseline(deriveAppDataFromCanonical(canonical, { now: NOW }), { now: NOW }))
const lockOf = (text: string) => createHash('sha256').update(`${text}\n`).digest('hex')

/** Locks by migrationInputs name; the inputs without one are compared with the readV2 path only. */
const LOCKS: Record<string, string> = {
  'public sample (src/data/v2-sample)': V2_SAMPLE_BASELINE_SHA256,
  'editor/fixtures/migrated-files.json': V2_FILES_LOCKS.find(([relative]) => relative.endsWith('/migrated-files.json'))![1],
  ...Object.fromEntries(Object.entries(MIGRATED_LOCKS).map(([name, lock]) => [`canonical/fixtures/migrated-canonical.json ${name}`, lock])),
  ...Object.fromEntries(Object.entries(V2_SPACE_LOCKS).map(([name, lock]) => [`canonical/fixtures/v2-space-canonical.json ${name}`, lock])),
}
const inputs: [name: string, files: () => V2Files, source: 'local' | 'sample', lock?: string][] = [
  ...migrationInputs().map(([name, files]): [string, () => V2Files, 'local' | 'sample', string?] =>
    [name, files, name.startsWith('public sample') ? 'sample' : 'local', LOCKS[name]]),
  ...V2_FILES_LOCKS.filter(([relative]) => !relative.endsWith('/migrated-files.json')).map(([relative, lock]): [string, () => V2Files, 'local', string] =>
    [relative.replace(/^(\.\.\/)+/, ''), () => JSON.parse(readFileSync(lockedFixtureUrl(relative), 'utf8')) as V2Files, 'local', lock]),
]

test('the inputs: every migratable fixture, and a lock wherever one exists', () => {
  assert.equal(inputs.length, 15)
  // Without a lock: the G2 synthetic data and the two 3C-1b edge-case inputs.
  assert.deepEqual(inputs.filter(([, , , lock]) => lock === undefined).map(([name]) => name), ['G2 synthetic (storeBridge.fixture)', '3C-1b edge cases', '3C-1b empty lists'])
})

for (const [name, files, source, lock] of inputs) test(`migration → read model → official view equals readV2 and keeps the derived baseline: ${name}`, () => {
  const viaV2 = canonicalForInputs({ v2Files: files(), source })
  const model = readModelOf(migrateIntoEmptyStore(files()).state, { origin: source === 'sample' ? 'sample' : 'local' })
  validateReadModel(model, OFFICIAL_POLICY)
  const viaReadModel = projectStoreToCanonical(formalStateOfReadModel(model), { source }).canonical
  assert.deepEqual(viaReadModel, viaV2)
  const text = baselineText(viaReadModel)
  assert.equal(text, baselineText(viaV2))
  if (lock !== undefined) assert.equal(lockOf(text), lock)
  assert.deepEqual(deriveTimeQueryContext(viaReadModel), deriveTimeQueryContext(viaV2))
})

for (const [name, files, source, lock] of inputs) test(`the App's path (3C-5B): the inlined read model → readReadModel → officialViewOf derives the locked baseline and the same time query context: ${name}`, () => {
  const viaV2 = canonicalForInputs({ v2Files: files(), source })
  const inlined = JSON.parse(JSON.stringify(readModelOf(migrateIntoEmptyStore(files()).state, { origin: source === 'sample' ? 'sample' : 'local' })))
  const viaApp = officialViewOf(readReadModel(inlined), source)
  assert.deepEqual(viaApp, viaV2)
  const text = baselineText(viaApp)
  assert.equal(text, baselineText(viaV2))
  if (lock !== undefined) assert.equal(lockOf(text), lock)
  assert.deepEqual(deriveTimeQueryContext(viaApp), deriveTimeQueryContext(viaV2))
})

/** The migrated store with one media record without a place, created as the media service creates records. */
function withPlacelessMedia(state: FormalState): FormalState {
  const allocateId = sequentialUuids(Date.UTC(2033, 0, 1))
  const item = {
    id: 'ignored', kind: 'photo', scope: 'city', src: '/media/user/0123456789abcdef/original.jpg', originalFileName: 'no-place.jpg',
    variants: { original: { src: '/media/user/0123456789abcdef/original.jpg', width: 4, height: 3 } }, width: 4, height: 3, isCover: false, status: 'ready',
  } as unknown as CanonicalMediaItem
  const records = [{ assetId: allocateId(), entityId: allocateId(), item, appendToCityOrder: true }]
  const { commands } = createMediaRecordCommands(records, { reader: memoryScopeReader(state), allocateId })
  return applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: FIXTURE_NOW, policy: OFFICIAL_POLICY }))
}

for (const [name, files, source, lock] of inputs) test(`3C-5 G: a media item without a place changes nothing the official view gives, and keeps the derived baseline: ${name}`, () => {
  const viaV2 = canonicalForInputs({ v2Files: files(), source })
  const state = withPlacelessMedia(migrateIntoEmptyStore(files()).state)
  const inlined = JSON.parse(JSON.stringify(readModelOf(state, { origin: source === 'sample' ? 'sample' : 'local' })))
  const model = readReadModel(inlined)
  const viaApp = officialViewOf(model, source)
  assert.deepEqual(viaApp, viaV2)
  const text = baselineText(viaApp)
  if (lock !== undefined) assert.equal(lockOf(text), lock)
  assert.equal(text, baselineText(viaV2))
  assert.deepEqual(officialReader(indexReadModel(model)).placelessMedia().map(media => media.originalFileName), ['no-place.jpg'])
})
