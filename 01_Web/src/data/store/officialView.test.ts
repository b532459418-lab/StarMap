/// <reference types="node" />
/** The official view (3C-5B spec §2.1): the projection's own implementation with its two options, which drop work and
 * never change the result. Every V2 input of the migration tests, migrated into a store. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readModelOf } from '../../worldgraph/readModel/build.ts'
import type { FormalLayer, FormalState } from '../../worldgraph/store/formal.ts'
import { OFFICIAL } from './officialDefinitions.ts'
import { officialViewOf, projectStoreToCanonical } from './projectCanonical.ts'
import { migrateIntoEmptyStore, migrationInputs } from './v2Store.fixture.ts'

for (const [name, files] of migrationInputs()) test(`the official view equals the projection, without skipped rows or a frozen copy: ${name}`, () => {
  const { state } = migrateIntoEmptyStore(files())
  const full = projectStoreToCanonical(state, { source: 'local' })
  assert.ok(Object.isFrozen(full.canonical))
  const view = officialViewOf(readModelOf(state, { origin: 'local' }), 'local')
  assert.deepEqual(view, full.canonical)
  assert.ok(!Object.isFrozen(view), 'no frozen copy')
  const untracked = projectStoreToCanonical(state, { source: 'local', track: false })
  assert.deepEqual(untracked.skipped, [])
  assert.deepEqual(untracked.canonical, full.canonical)
  assert.deepEqual(projectStoreToCanonical(state, { source: 'sample', freeze: false }).canonical, projectStoreToCanonical(state, { source: 'sample' }).canonical)
})

test('track: false lists no skipped rows even when the store holds rows Canonical cannot express', () => {
  const [, files] = migrationInputs()[0]
  const { state } = migrateIntoEmptyStore(files())
  const layer: FormalLayer = { id: 'synthetic:layer', revision: 0, title: { names: { en: 'Synthetic' } }, schemaVersion: 1, acceptedEntityTypes: [OFFICIAL.place], entryFields: [] }
  const custom: FormalState = { ...state, layers: [...state.layers, layer] }
  assert.deepEqual(projectStoreToCanonical(custom, { source: 'local' }).skipped, [{ table: 'layers', id: 'synthetic:layer' }])
  assert.deepEqual(projectStoreToCanonical(custom, { source: 'local', track: false }).skipped, [])
  assert.deepEqual(officialViewOf(readModelOf(custom, { origin: 'local' }), 'local'), projectStoreToCanonical(state, { source: 'local' }).canonical)
})
