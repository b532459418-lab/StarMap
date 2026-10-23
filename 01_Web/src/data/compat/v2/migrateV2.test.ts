/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type FormalCommand, readFormalState } from '../../../worldgraph/store/formal.ts'
import { isPosition } from '../../../worldgraph/store/position.ts'
import { StoreError } from '../../../worldgraph/store/schema.ts'
import { sequentialUuids } from '../../canonical/v2.fixture.ts'
import { readV2 } from './v2Reader.ts'
import { validateV2Files, type V2Files } from './v2Schema.ts'
import { OFFICIAL, OFFICIAL_POLICY, V2_SOURCES, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import { listPositions, migrateV2, migrationProblems } from './migrateV2.ts'
import { NOW, edgeCaseFixture, migrateIntoEmptyStore, migrationInputs } from '../../store/v2Store.fixture.ts'

const counting = () => { let calls = 0; const next = sequentialUuids(); return { allocateId: () => { calls++; return next() }, calls: () => calls } }
const refused = (files: unknown, options: Partial<Parameters<typeof migrateV2>[1]> = {}) => {
  const allocator = counting()
  const result = migrateV2(files as V2Files, { now: NOW, allocateId: allocator.allocateId, ...options })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.deepEqual(result.commands, [])
  assert.equal(result.manifest, null)
  assert.equal(allocator.calls(), 0, 'no identity is allocated for a refused migration')
  return result.report.problems
}

for (const [name, input] of migrationInputs()) test(`${name}: migrates into an empty store in one planner pass`, () => {
  const files = input()
  assert.deepEqual(validateV2Files(files), [])
  const before = structuredClone(files)
  const { result, changeSet, state } = migrateIntoEmptyStore(files)
  assert.deepEqual(files, before, 'input is not modified')
  assert.ok(Object.isFrozen(result.commands) && Object.isFrozen(result.commands[0]))
  assert.equal(changeSet.baseRevision, 0)
  assert.equal(state.revision, 1)
  assert.equal(changeSet.upserts.length, result.commands.length, 'every command creates one row')
  assert.deepEqual(readFormalState(JSON.parse(JSON.stringify(state)), OFFICIAL_POLICY), state)
  const counts = result.report.counts
  assert.equal(counts.places, files.places.places.length)
  assert.equal(counts.footprintRecords + counts.plannedRecords, files.travel.records.length)
  assert.equal(counts.wantToGoItems, files.wantToGo.items.length)
  assert.equal(counts.media, files.media.items.length)
  assert.equal(state.entries.length, counts.footprintRecords + counts.plannedRecords + counts.wantToGoItems + counts.countryVisits)
  assert.equal(state.evidence.length, counts.addedCountries)
  assert.equal(state.assets.length, counts.media)
  assert.equal(state.sequences.length, counts.journeys)
  for (const [table, n] of Object.entries(result.report.rows)) assert.equal(state[table as keyof typeof result.report.rows].length, n)
})

test('commands follow the dependency order of the spec', () => {
  const { result } = migrateIntoEmptyStore(edgeCaseFixture())
  const phase = (c: FormalCommand): number => {
    const value = (c as { value: { id: string; typeId?: string } }).value
    switch (c.table) {
      case 'entityTypes': case 'relationTypes': case 'layers': return 0
      case 'sources': return value.id.startsWith('starmap:') ? 0 : 1
      case 'entities': return value.typeId === OFFICIAL.place ? 2 : value.typeId === OFFICIAL.media ? 4 : 7
      case 'anchors': case 'relations': return 3
      case 'assets': return 4
      case 'evidence': return 5
      case 'entries': return 6
      case 'sequences': return 7
      default: return 8
    }
  }
  const phases = result.commands.map(phase)
  assert.deepEqual(phases, [...phases].sort((x, y) => x - y))
  assert.deepEqual([...new Set(phases)], [0, 1, 2, 3, 4, 5, 6, 7, 8])
})

test('raw ids that collide across sources stay separate entries; planned never merges with want-to-go', () => {
  const { state } = migrateIntoEmptyStore(edgeCaseFixture())
  const shared = state.entries.filter(e => e.source.recordId === 'shared-id')
  assert.deepEqual(shared.map(e => [e.layerId, e.source.sourceId]).sort(), [[OFFICIAL.wantToGo, V2_SOURCES.planned], [OFFICIAL.wantToGo, V2_SOURCES.wantToGo]])
  const collision = state.entries.filter(e => e.source.recordId === 'collision')
  assert.deepEqual(collision.map(e => e.source.sourceId).sort(), [V2_SOURCES.travel, V2_SOURCES.wantToGo])
  assert.equal(new Set([...shared, ...collision].map(e => e.id)).size, 4)
})

test('fields take only values of their kind; everything else stays verbatim in extensions.v2', () => {
  const files = edgeCaseFixture(), { state, result } = migrateIntoEmptyStore(files)
  const entry = (sourceId: string, recordId: string) => state.entries.find(e => e.source.sourceId === sourceId && e.source.recordId === recordId)!
  const uncertain = entry(V2_SOURCES.travel, 'uncertain')
  assert.deepEqual(uncertain.fields, { date: { raw: { startDate: '2025-02-31', endDate: '2024-01-01', year: 'unknown' } } })
  assert.deepEqual(uncertain.extensions, { v2: { notes: null, hiddenFromHome: 'unknown' } })
  assert.deepEqual(entry(V2_SOURCES.travel, 'no-date').fields, { date: { raw: {} } })
  assert.deepEqual(entry(V2_SOURCES.wantToGo, 'shared-id').extensions, { v2: { addedAt: '2026-02-30' } })
  const planned = entry(V2_SOURCES.planned, 'shared-id')
  assert.deepEqual(planned.fields, { date: { raw: { startDate: '2027-03' } }, tripTitle: 'Synthetic plan' })
  assert.deepEqual(planned.extensions, { v2: { status: 'planned', journeyId: 'planned-journey' } })
  const [a, b] = files.places.places.filter(p => p.subtype === 'city')
  const place = (id: string) => state.entities.find(e => e.id === id)!
  assert.deepEqual(place(a.id).title, { names: {} })
  assert.deepEqual((place(a.id).extensions!.v2 as Record<string, unknown>).originalLanguage, 'fr')
  assert.deepEqual(place(b.id).title, { names: {} })
  assert.ok(Object.hasOwn(place(b.id).extensions!.v2 as object, 'names'))
  assert.equal(result.report.extensionKeys.place.legacyKeys, files.places.places.filter(p => p.legacyKeys).length)
  assert.equal(result.report.unresolvedViewElements[VIEW_SCOPES.hiddenMedia], 1)
  assert.equal(result.report.unresolvedViewElements[VIEW_SCOPES.countryOrder], 1)
})

test('hiding is view state: one scope per semantic, never a field', () => {
  const { state } = migrateIntoEmptyStore(edgeCaseFixture())
  const scope = (s: string) => state.viewItems.filter(v => v.scope === s)
  assert.deepEqual(scope(VIEW_SCOPES.recordHiddenFromHome).map(v => v.hidden), [true, false])
  assert.deepEqual(scope(VIEW_SCOPES.wantToGoHidden).map(v => [v.hidden, v.layerId]), [[true, OFFICIAL.wantToGo]])
  assert.ok(scope(VIEW_SCOPES.hiddenMedia).every(v => v.hidden && v.itemTable === 'assets'))
  const cover = state.viewSettings.filter(v => v.scope === VIEW_SCOPES.coverMediaByCity)
  assert.deepEqual(cover.map(v => v.ref ?? v.value).sort(), [{ table: 'assets', id: 'synthetic-photo' }, 'synthetic-missing-cover'].sort())
  for (const e of state.entries) assert.ok(!Object.hasOwn(e.fields, 'hidden') && !Object.hasOwn(e.fields, 'hiddenFromHome'))
})

test('rerun with the previous ledger produces exactly the same commands and ledger', () => {
  const first = migrateIntoEmptyStore(edgeCaseFixture()).result
  const again = migrateV2(edgeCaseFixture(), { now: NOW, manifest: first.manifest, allocateId: () => { throw new Error('no new identity') } })
  assert.equal(again.ok, true)
  assert.deepEqual(again.commands, first.commands)
  assert.deepEqual(again.manifest, first.manifest)
})

test('without a ledger only the allocated UUIDs differ', () => {
  const one = migrateIntoEmptyStore(edgeCaseFixture()).result
  const two = migrateIntoEmptyStore(edgeCaseFixture(), { allocateId: sequentialUuids(Date.UTC(2031, 0, 1)) }).result
  const normalize = (r: typeof one) => {
    let text = JSON.stringify(r.commands)
    for (const row of r.manifest.identities) text = text.split(row.id).join(`<${row.kind}|${row.sourceId}|${row.recordId}>`)
    return text
  }
  assert.notDeepEqual(one.commands, two.commands)
  assert.equal(normalize(one), normalize(two))
  assert.deepEqual(one.manifest.identities.map(r => [r.kind, r.sourceId, r.recordId]), two.manifest.identities.map(r => [r.kind, r.sourceId, r.recordId]))
})

test('invalid V2 files are refused with every problem and nothing generated', () => {
  const files = edgeCaseFixture()
  files.travel.records[0].placeId = sequentialUuids(Date.UTC(2032, 0, 1))()
  ;(files.wantToGo.items[0] as { hidden: unknown }).hidden = 'no'
  ;(files.wantToGo.items[0] as unknown as Record<string, unknown>).unexpected = true
  const problems = refused(files)
  assert.ok(problems.some(p => p.code === 'E_V2_INVALID' && p.file === 'travel' && p.path === '$.records[0].placeId'))
  assert.ok(problems.some(p => p.code === 'E_V2_INVALID' && p.file === 'wantToGo' && p.path === '$.items[0].hidden'))
  assert.deepEqual(problems.filter(p => p.code === 'E_V2_INVALID').length, validateV2Files(files).length)
})

test('a record readV2 would skip refuses the whole migration', () => {
  // readV2 rejects nothing per record today (V2 files are validated as a whole), so the
  // check is exercised through the reader seam of migrationProblems.
  const files = edgeCaseFixture()
  const skipping = (f: V2Files) => {
    const data = readV2(f)
    return { ...data, wantToGo: { ...data.wantToGo, problems: ['items[0]: synthetic skip'] }, media: { ...data.media, problems: ['items[1]: synthetic skip'] } }
  }
  const problems = migrationProblems(files, undefined, skipping)
  assert.deepEqual(problems.map(p => [p.code, p.file]), [['E_V2_SKIPPED', 'wantToGo'], ['E_V2_SKIPPED', 'media']])
  assert.deepEqual(migrationProblems(files), [])
})

test('source collisions and unusable ids are refused, each one reported', () => {
  const files = edgeCaseFixture()
  files.editorState.addedCountries.push(structuredClone(files.editorState.addedCountries[0]), structuredClone(files.editorState.addedCountries[1]))
  files.travel.records[3].id = 'x'.repeat(513)
  files.travel.records[0].journeyId = 'j'.repeat(513)
  const problems = refused(files)
  assert.deepEqual(problems.map(p => [p.code, p.path]), [
    ['E_ID', '$.records[0].journeyId'],
    ['E_ID', '$.records[3].id'],
    ['E_SOURCE_COLLISION', '$.addedCountries[2].placeId'],
    ['E_SOURCE_COLLISION', '$.addedCountries[3].placeId'],
  ])
})

test('a ledger that cannot be reused is refused; non-JSON input never runs getters', () => {
  const first = migrateIntoEmptyStore(edgeCaseFixture()).result
  const files = edgeCaseFixture()
  const placeClash = { ...first.manifest, identities: [{ ...first.manifest.identities[0], id: files.places.places[0].id }] }
  assert.deepEqual(refused(files, { manifest: placeClash }).map(p => p.code), ['E_BRIDGE_ID_COLLISION'])
  assert.deepEqual(refused(files, { manifest: { ...first.manifest, version: 2 } as never }).map(p => p.code), ['E_BRIDGE_MANIFEST'])
  let reads = 0
  Object.defineProperty(files.travel.records[0], 'custom', { enumerable: true, get() { reads++; return 'x' } })
  assert.deepEqual(refused(files).map(p => p.code), ['E_JSON'])
  assert.equal(reads, 0)
})

test('options are checked before anything else', () => {
  assert.throws(() => migrateV2(edgeCaseFixture(), { now: 'yesterday', allocateId: sequentialUuids() }), (e: unknown) => e instanceof StoreError && e.code === 'E_TIME')
})

test('listPositions: strictly increasing, valid and short even for large lists', () => {
  for (const n of [0, 1, 2, 3, 61, 62, 63, 1000, 10_000, 100_000]) {
    const keys = listPositions(n)
    assert.equal(keys.length, n)
    assert.ok(keys.every(isPosition))
    for (let i = 1; i < n; i++) assert.ok(keys[i - 1] < keys[i])
    if (n) assert.ok(Math.max(...keys.map(k => k.length)) <= 2 * Math.ceil(Math.log10(n + 1)) + 1)
  }
})
