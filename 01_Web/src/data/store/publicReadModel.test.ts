/// <reference types="node" />
/** The public export's rules (3C-5A spec §2.3), one test per rule, on the 3C-1b edge-case fixture migrated into a
 * store, with Iceland, Reykjavik and Reykjavik's photo made public. Neutral synthetic data only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JsonObject, StoreAnchor, StoreEntity } from '../../worldgraph/store/types.ts'
import { formalStateOfReadModel, readModelOf } from '../../worldgraph/readModel/build.ts'
import { validateReadModel } from '../../worldgraph/readModel/check.ts'
import { READ_MODEL_TABLES, type ReadModel, type ReadModelRow, type ReadModelTable } from '../../worldgraph/readModel/types.ts'
import { OFFICIAL, OFFICIAL_POLICY, UNRESOLVED_KEY_PREFIX, V2_SOURCES, VIEW_SCOPES } from './officialDefinitions.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { PUBLIC_EXTENSION_KEYS, publicReadModelOf } from './publicReadModel.ts'
import { edgeCaseFixture, migrateIntoEmptyStore } from './v2Store.fixture.ts'

const ICELAND = '01a0ed02-3f45-7743-8aec-d757b6c28eba'
const REYKJAVIK = '01a0ed02-3f48-70a0-9146-47667ddcbf4e'
const VIK = '01a0ed02-3f48-74aa-9bea-237f235aac61'
const AKUREYRI = '01a0ed02-3f48-7cdd-8d8c-70c026b27a4c'
const PUBLIC_PHOTO = 'synthetic-photo'

/** The edge-case library as a read model, with the given entities public and the given anchors' own visibility. */
function library(publicIds: readonly string[], anchorVisibility: Record<string, 'public' | 'private'> = {}): ReadModel {
  const model = readModelOf(migrateIntoEmptyStore(edgeCaseFixture()).state, { origin: 'local' })
  const photo = model.entities.find((row) => row.typeId === OFFICIAL.media && row.fields.asset === PUBLIC_PHOTO)!.id
  const ids = new Set(publicIds.map((value) => (value === PUBLIC_PHOTO ? photo : value)))
  return {
    ...model,
    entities: model.entities.map((row) => (ids.has(row.id) ? { ...row, visibility: 'public' } : row)),
    anchors: model.anchors.map((row) => (Object.hasOwn(anchorVisibility, row.entityId) ? { ...row, visibility: anchorVisibility[row.entityId] } : row)) as StoreAnchor[],
  }
}
const ids = (model: ReadModel, table: ReadModelTable) => (model[table] as readonly ReadModelRow[]).map((row) => row.id)
const exported = publicReadModelOf(library([ICELAND, REYKJAVIK, PUBLIC_PHOTO], { [ICELAND]: 'private', [AKUREYRI]: 'public' }))

test('only entities whose visibility is public are exported', () => {
  assert.ok(exported.entities.every((row) => row.visibility === 'public'))
  assert.deepEqual(exported.entities.map((row) => row.typeId).sort(), [OFFICIAL.media, OFFICIAL.place, OFFICIAL.place])
  assert.deepEqual(ids(exported, 'entities').filter((id) => id === ICELAND || id === REYKJAVIK), [ICELAND, REYKJAVIK])
  // The journey entity is private: its sequence goes with it.
  assert.deepEqual(exported.sequences, [])
})

test('anchors use their own visibility, and otherwise their entity\'s', () => {
  // Reykjavik's anchor inherits public; Iceland's is private on its own; Akureyri's is public but its entity is not.
  assert.deepEqual(exported.anchors.map((row) => row.entityId), [REYKJAVIK])
})

test('entries follow their entity', () => {
  const source = library([ICELAND, REYKJAVIK, PUBLIC_PHOTO])
  const expected = source.entries.filter((row) => row.entityId === ICELAND || row.entityId === REYKJAVIK).map((row) => row.id)
  assert.deepEqual(ids(exported, 'entries'), expected)
  assert.ok(expected.length >= 5, 'the fixture has footprint, planned, want-to-go and country-visit entries there')
})

test('only assets a kept entity refers to are exported; a hidden list does not keep one alive', () => {
  assert.deepEqual(ids(exported, 'assets'), [PUBLIC_PHOTO])
  // The drone asset is named by a drone order and a hidden list, but its media entity is private.
  assert.ok(!exported.viewItems.some((row) => row.itemId === 'synthetic-drone'))
})

test('relations need both ends', () => {
  assert.deepEqual(exported.relations.map((row) => [row.fromEntityId, row.toEntityId]), [[REYKJAVIK, ICELAND]])
  assert.ok(library([]).relations.some((row) => row.fromEntityId === VIK && row.toEntityId === ICELAND), 'Vik is part of Iceland in the source')
})

test('view rows need their target; unresolved elements and other value settings go; display settings stay', () => {
  const kept = new Set([...exported.entities, ...exported.entries, ...exported.assets].map((row) => row.id))
  assert.ok(exported.viewItems.every((row) => kept.has(row.itemId)))
  assert.ok(exported.viewItems.some((row) => row.scope === VIEW_SCOPES.placeOrder && row.itemId === REYKJAVIK))
  assert.ok(exported.viewSettings.every((row) => row.ref === undefined ? row.scope === VIEW_SCOPES.display : kept.has(row.ref.id)))
  assert.ok(!exported.viewSettings.some((row) => row.key.startsWith(UNRESOLVED_KEY_PREFIX)))
  // The cover with a raw media id (no reference) goes; the cover that refers to the public photo stays.
  assert.deepEqual(exported.viewSettings.filter((row) => row.scope === VIEW_SCOPES.coverMediaByCity).map((row) => [row.key, row.ref?.id]), [[REYKJAVIK, PUBLIC_PHOTO]])
  assert.deepEqual(exported.viewSettings.filter((row) => row.scope === VIEW_SCOPES.display).map((row) => row.key), ['regionIncludes'])
})

test('extensions keep only the verbatim values the official view reads', () => {
  for (const table of READ_MODEL_TABLES) {
    for (const row of exported[table] as readonly ReadModelRow[]) {
      const extensions = (row as { extensions?: JsonObject }).extensions
      if (extensions === undefined) continue
      assert.deepEqual(Object.keys(extensions), ['v2'], `${table} ${row.id}`)
      for (const key of Object.keys(extensions.v2 as JsonObject)) assert.ok(PUBLIC_EXTENSION_KEYS[table]?.includes(key), `${table}.extensions.v2.${key}`)
    }
  }
  // Reykjavik keeps its names (the store title could not hold them) but not its old name-derived keys.
  const source = library([]).entities.find((row) => row.id === REYKJAVIK) as StoreEntity
  assert.ok(Object.hasOwn((source.extensions as JsonObject).v2 as JsonObject, 'legacyKeys'))
  const reykjavik = ((exported.entities.find((row) => row.id === REYKJAVIK) as StoreEntity).extensions as JsonObject).v2 as JsonObject
  assert.ok(Object.hasOwn(reykjavik, 'names') && Object.hasOwn(reykjavik, 'originalLanguage') && !Object.hasOwn(reykjavik, 'legacyKeys'))
})

test('definitions and evidence: only what the exported rows use; the result validates and projects', () => {
  assert.ok(!ids(exported, 'sources').includes(V2_SOURCES.import), 'the V2 file headers are not published')
  assert.ok(!ids(exported, 'sources').includes(V2_SOURCES.journey))
  assert.deepEqual(ids(exported, 'entityTypes').sort(), [OFFICIAL.media, OFFICIAL.place])
  assert.deepEqual(ids(exported, 'relationTypes'), [OFFICIAL.partOf])
  // Iceland's country visit names its evidence: it stays. Faroe's container has no kept entry.
  assert.deepEqual(exported.evidence.map((row) => row.recordId), [ICELAND])
  assert.equal(exported.revision, library([]).revision); assert.equal(exported.origin, 'local')
  assert.doesNotThrow(() => validateReadModel(exported, OFFICIAL_POLICY))
  assert.doesNotThrow(() => projectStoreToCanonical(formalStateOfReadModel(exported), { source: 'local' }))
})

test('a library with nothing public exports definitions-free, fact-free rows that still validate', () => {
  const none = publicReadModelOf(library([]))
  for (const table of READ_MODEL_TABLES) {
    if (table === 'viewSettings') assert.deepEqual(none.viewSettings.map((row) => row.scope), [VIEW_SCOPES.display])
    else assert.deepEqual(none[table], [], table)
  }
  assert.doesNotThrow(() => validateReadModel(none, OFFICIAL_POLICY))
})
