/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type FormalCommand, type FormalState, emptyFormalState, readFormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { StoreError } from '../../worldgraph/store/schema.ts'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../../worldgraph/layers.ts'
import { checkDefinitionChange } from '../../worldgraph/store/evolution.ts'
import {
  OFFICIAL, OFFICIAL_DEFINITIONS, OFFICIAL_DEFINITIONS_VERSION, OFFICIAL_POLICY, UNRESOLVED_KEY_PREFIX, V2_SOURCES, VIEW_SCOPES,
  mapListScope, officialDefinitionCommands, v2SourceDefinition,
} from './officialDefinitions.ts'
import { OFFICIAL_DEFINITION_HISTORY } from './officialDefinitionHistory.fixture.ts'
import { officialDefinitionSyncCommands, type OfficialDefinitionSet } from './definitionUpgrades.ts'

const NOW = '2026-10-13T00:00:00.000Z'
const fails = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof StoreError && e.code === code)
const plan = (state: FormalState, commands: readonly FormalCommand[], policy = OFFICIAL_POLICY) =>
  planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: NOW, policy })
const install = (): FormalState => applyChangeSet(emptyFormalState(), plan(emptyFormalState(), officialDefinitionCommands()))

test('official definitions install into an empty store in one batch and read back under the official policy', () => {
  const state = install()
  assert.equal(state.revision, 1)
  assert.deepEqual(readFormalState(JSON.parse(JSON.stringify(state)), OFFICIAL_POLICY), state)
  assert.deepEqual(state.entityTypes.map(r => r.id), [OFFICIAL.place, OFFICIAL.journey, OFFICIAL.media])
  assert.deepEqual(state.layers.map(r => [r.id, r.systemKey]), [[OFFICIAL.travel, TRAVEL_LAYER_ID], [OFFICIAL.wantToGo, WANT_TO_GO_LAYER_ID]])
  assert.deepEqual(state.relationTypes.map(r => r.id), [OFFICIAL.partOf])
  assert.deepEqual(state.sources.map(r => [r.id, r.origin]), [[OFFICIAL.user, 'user']])
})

test('commands come in dependency order: the planner rejects the reversed batch', () => {
  fails(() => plan(emptyFormalState(), [...officialDefinitionCommands()].reverse()), 'E_REFERENCE')
})

test('reinstalling identical definitions is a no-op', () => {
  const state = install(), again = plan(state, officialDefinitionCommands())
  assert.equal(again.nextRevision, state.revision)
  assert.deepEqual(again.upserts, [])
})

test('the official system keys need the host policy and cannot be claimed by another layer', () => {
  fails(() => plan(emptyFormalState(), officialDefinitionCommands(), {}), 'E_SYSTEM_KEY')
  const impostor = { ...OFFICIAL_DEFINITIONS.layers[0], id: 'user:footprints' }
  fails(() => plan(install(), [{ op: 'create', table: 'layers', value: impostor }]), 'E_SYSTEM_KEY')
})

test('field contract of every official definition', () => {
  const fields = (rows: readonly { id: string; fields?: readonly object[]; entryFields?: readonly object[] }[]) =>
    Object.fromEntries(rows.map(r => [r.id, r.fields ?? r.entryFields]))
  assert.deepEqual(fields(OFFICIAL_DEFINITIONS.entityTypes), {
    [OFFICIAL.place]: [{ key: 'subtype', kind: 'text', required: true }, { key: 'iso3166Alpha2', kind: 'text' }],
    [OFFICIAL.journey]: [],
    [OFFICIAL.media]: [{ key: 'place', kind: 'entity_ref', required: true }, { key: 'asset', kind: 'asset_ref', required: true }],
  })
  assert.deepEqual(fields(OFFICIAL_DEFINITIONS.layers), {
    [OFFICIAL.travel]: [{ key: 'date', kind: 'date_evidence', required: true }, { key: 'note', kind: 'text' }, { key: 'tripTitle', kind: 'text' }],
    [OFFICIAL.wantToGo]: [{ key: 'date', kind: 'date_evidence' }, { key: 'addedAt', kind: 'date' }, { key: 'note', kind: 'text' }, { key: 'tripTitle', kind: 'text' }],
  })
  assert.deepEqual(OFFICIAL_DEFINITIONS.relationTypes[0].fields, [])
  // Hiding is view state, never a field.
  for (const row of [...OFFICIAL_DEFINITIONS.entityTypes, ...OFFICIAL_DEFINITIONS.relationTypes]) assert.ok(row.fields.every(f => !/hidden/i.test(f.key)))
  for (const row of OFFICIAL_DEFINITIONS.layers) assert.ok(row.entryFields.every(f => !/hidden/i.test(f.key)))
})

test('definitions are constants: deterministic, frozen, and free of user content', () => {
  assert.deepEqual(officialDefinitionCommands(), officialDefinitionCommands())
  assert.ok(Object.isFrozen(officialDefinitionCommands()[0]))
  const ids = officialDefinitionCommands().map(c => (c as { value: { id: string } }).value.id)
  assert.ok(ids.every(id => id.startsWith('starmap:')))
  assert.equal(new Set(ids).size, ids.length)
})

test('V2 import sources keep the G2 namespaces and install after the official definitions', () => {
  const sources = Object.values(V2_SOURCES).map(id => v2SourceDefinition(id))
  assert.ok(sources.every(s => s.origin === 'import' && s.id.startsWith('v2:')))
  assert.deepEqual(v2SourceDefinition(V2_SOURCES.import, { v2: { places: { generated_at: 'x' } } }).extensions, { v2: { places: { generated_at: 'x' } } })
  const state = applyChangeSet(install(), plan(install(), sources.map(value => ({ op: 'create', table: 'sources', value }))))
  assert.equal(state.sources.length, 1 + sources.length)
  fails(() => v2SourceDefinition('v2:unknown'), 'E_SOURCE')
})

test('view scopes are distinct and stay within the 256-character scope limit with a place id appended', () => {
  const scopes = Object.values(VIEW_SCOPES)
  assert.equal(new Set(scopes).size, scopes.length)
  const longest = mapListScope(scopes.reduce((a, b) => (a.length >= b.length ? a : b)), '01a0ed02-3f48-70a0-9146-47667ddcbf4e')
  assert.ok(longest.length <= 256)
  assert.ok(UNRESOLVED_KEY_PREFIX.length > 0 && !scopes.some(s => s.startsWith(UNRESOLVED_KEY_PREFIX)))
})

test('3C-5 G: the definitions history is frozen, each version a compatible evolution of the one before, the last the current one', () => {
  const versions = Object.keys(OFFICIAL_DEFINITION_HISTORY).map(Number).sort((a, b) => a - b)
  assert.deepEqual(versions, Array.from({ length: OFFICIAL_DEFINITIONS_VERSION }, (_, index) => index + 1), 'one entry per version, none skipped')
  assert.deepEqual(OFFICIAL_DEFINITION_HISTORY[OFFICIAL_DEFINITIONS_VERSION], OFFICIAL_DEFINITIONS, 'the last version is OFFICIAL_DEFINITIONS')
  const tables = ['sources', 'entityTypes', 'relationTypes', 'layers'] as const
  for (const version of versions.slice(1)) {
    const before = OFFICIAL_DEFINITION_HISTORY[version - 1], after = OFFICIAL_DEFINITION_HISTORY[version]
    for (const table of tables) {
      for (const row of before[table]) {
        const next = (after[table] as readonly { id: string }[]).find(candidate => candidate.id === row.id)
        assert.ok(next, `version ${version} keeps ${table} ${row.id}`)
        checkDefinitionChange(table, row, next)
      }
    }
  }
  // An install of every version upgrades to the current one through the sync, and the planner accepts it.
  for (const version of versions) {
    const old = OFFICIAL_DEFINITION_HISTORY[version]
    const installed = applyChangeSet(emptyFormalState(), plan(emptyFormalState(), [
      ...old.sources.map(value => ({ op: 'create' as const, table: 'sources' as const, value })),
      ...old.entityTypes.map(value => ({ op: 'create' as const, table: 'entityTypes' as const, value })),
      ...old.relationTypes.map(value => ({ op: 'create' as const, table: 'relationTypes' as const, value })),
      ...old.layers.map(value => ({ op: 'create' as const, table: 'layers' as const, value })),
    ]))
    const sync = officialDefinitionSyncCommands(installed)
    const upgraded = sync.length ? applyChangeSet(installed, plan(installed, sync)) : installed
    assert.deepEqual(officialDefinitionSyncCommands(upgraded), [], `version ${version} → current, then nothing left`)
  }
})

test('3C-5 G: an incompatible definition is refused by the sync with E_SCHEMA_CHANGE', () => {
  const state = install()
  const narrowed = structuredClone(OFFICIAL_DEFINITIONS) as unknown as OfficialDefinitionSet & { layers: { acceptedEntityTypes: string[] }[] }
  narrowed.layers[0].acceptedEntityTypes = []
  // An empty list accepts every type (wider): compatible. A new required field is not.
  assert.equal(officialDefinitionSyncCommands(state, narrowed).length, 1)
  const required = structuredClone(OFFICIAL_DEFINITIONS) as unknown as { entityTypes: { fields: { key: string; kind: string; required?: boolean }[] }[] }
  required.entityTypes[0].fields.push({ key: 'synthetic', kind: 'text', required: true })
  fails(() => officialDefinitionSyncCommands(state, required as unknown as OfficialDefinitionSet), 'E_SCHEMA_CHANGE')
  assert.deepEqual(officialDefinitionSyncCommands(state), [], 'the current definitions need nothing')
})
