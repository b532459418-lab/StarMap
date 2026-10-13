/// <reference types="node" />
/** A third, randomly named layer goes through its whole life on the formal path.
 * Fixed seeds generate every type, layer, source and field name, so no branch in
 * the code can depend on a particular name. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, id } from './store.fixture.ts'
import { type FormalCommand, type FormalRow, type FormalState, type FormalTable, emptyFormalState, readFormalState } from './formal.ts'
import { memoryReader } from './reader.ts'
import { applyChangeSet, planCommands } from './planner.ts'
import { StoreError } from './schema.ts'
import type { JsonObject } from './types.ts'

const generator = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }
const fails = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof StoreError && e.code === code)
const create = (table: FormalTable, value: unknown): FormalCommand => ({op:'create',table,value:value as FormalRow})
const update = <T extends {id: string; revision: number}>(table: FormalTable, value: T): FormalCommand =>
  ({op:'update',table,id:value.id,expectedRevision:value.revision - 1,value:value as unknown as FormalRow})
const remove = (table: FormalTable, row: {id: string; revision: number}): FormalCommand => ({op:'remove',table,id:row.id,expectedRevision:row.revision})

for (const seed of [11, 2026, 31337]) test(`a randomly named third layer lives its whole lifecycle (seed ${seed})`, () => {
  const random = generator(seed)
  const word = () => Array.from({length:8}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('')
  const named = (prefix: string) => `${word()}${prefix}${word()}`
  const sourceId = named(':'), typeId = named(':'), layerId = named('/'), otherLayerId = named('.'), relationTypeId = named(':')
  const nameKey = word(), ratingKey = word(), noteKey = word(), extraKey = word()
  const uuid = () => id(1 + Math.floor(random() * 999_999_999))
  const entityId = uuid(), friendId = uuid(), firstId = uuid(), secondId = uuid(), thirdId = uuid()
  const text = (value: string) => ({names:{und:value}})
  let state: FormalState = emptyFormalState()
  const step = (commands: FormalCommand[]) => { state = applyChangeSet(state, planCommands(memoryReader(state), commands, {baseRevision:state.revision, now:NOW})) }
  const plan = (commands: FormalCommand[]) => planCommands(memoryReader(state), commands, {baseRevision:state.revision, now:NOW})
  const get = <T>(table: FormalTable, rowId: string) => memoryReader(state).get(table, rowId) as T

  // 1. Define the entity type, two layers and a relation type.
  step([
    create('sources', {id:sourceId, revision:0, title:text('source'), origin:'user'}),
    create('entityTypes', {id:typeId, revision:0, title:text('type'), schemaVersion:1, fields:[{key:nameKey, kind:'text', required:true}]}),
    create('layers', {id:layerId, revision:0, title:text('layer'), schemaVersion:1, acceptedEntityTypes:[typeId], entryFields:[{key:ratingKey, kind:'number', min:0, max:10}]}),
    create('layers', {id:otherLayerId, revision:0, title:text('other'), schemaVersion:1, acceptedEntityTypes:[], entryFields:[{key:noteKey, kind:'text'}]}),
    create('relationTypes', {id:relationTypeId, revision:0, title:text('relation'), schemaVersion:1, fromTypes:[typeId], toTypes:[typeId], fields:[]}),
  ])
  const sourceRef = (recordId: string) => ({sourceId, recordId, evidenceIds:[]})
  const entity = (rowId: string, fields: JsonObject) => ({id:rowId, revision:0, typeId, title:text(word()), fields, source:sourceRef(word()), visibility:'private'})
  const layerEntry = (rowId: string, layer: string, fields: JsonObject) => ({id:rowId, revision:0, layerId:layer, entityId, fields, source:sourceRef(word()), createdAt:NOW, updatedAt:NOW})
  // 2. An entity with two entries in the new layer, plus a related entity.
  step([
    create('entities', entity(entityId, {[nameKey]:'first'})), create('entities', entity(friendId, {[nameKey]:'friend'})),
    create('entries', layerEntry(firstId, layerId, {[ratingKey]:3})), create('entries', layerEntry(secondId, layerId, {[ratingKey]:7})),
    create('relations', {id:word(), revision:0, typeId:relationTypeId, fromEntityId:entityId, toEntityId:friendId, source:sourceRef(word()), fields:{}}),
  ])
  assert.equal(state.entries.filter(e => e.layerId === layerId).length, 2)
  // 3. Update an entry; the layer's range still applies.
  const first = get<{id: string; revision: number; fields: JsonObject; updatedAt: string}>('entries', firstId)
  step([update('entries', {...first, revision:1, fields:{[ratingKey]:9}, updatedAt:'2026-10-06T00:00:00.000Z'})])
  fails(() => plan([update('entries', {...get<typeof first>('entries', firstId), revision:2, fields:{[ratingKey]:11}})]), 'E_FIELDS')
  // 4. Delete one entry: the entity stays.
  step([remove('entries', get('entries', secondId))])
  assert.ok(get('entities', entityId)); assert.equal(get('entries', secondId), undefined)
  // 5. Put the entity on the other layer too.
  step([create('entries', layerEntry(thirdId, otherLayerId, {[noteKey]:'also here'}))])
  assert.deepEqual(state.entries.filter(e => e.entityId === entityId).map(e => e.layerId).sort(), [layerId, otherLayerId].sort())
  // 6. Add an optional field to the type, then write it.
  const type = get<{id: string; revision: number; fields: readonly object[]}>('entityTypes', typeId)
  step([update('entityTypes', {...type, revision:1, fields:[...type.fields, {key:extraKey, kind:'text'}]})])
  const subject = get<{id: string; revision: number; fields: JsonObject}>('entities', entityId)
  step([update('entities', {...subject, revision:1, fields:{...subject.fields, [extraKey]:'value'}})])
  // 7. Deprecate it: the stored value stays readable and may be kept, never replaced.
  const widened = get<typeof type>('entityTypes', typeId)
  step([update('entityTypes', {...widened, revision:2, fields:widened.fields.map(f => ({...f, ...((f as {key: string}).key === extraKey ? {deprecated:true} : {})}))})])
  const kept = get<typeof subject>('entities', entityId)
  assert.equal(kept.fields[extraKey], 'value')
  fails(() => plan([update('entities', {...kept, revision:2, fields:{...kept.fields, [extraKey]:'other'}})]), 'E_FIELD_DEPRECATED')
  step([update('entities', {...kept, revision:2, fields:{...kept.fields, [nameKey]:'renamed'}})])
  // 8. The entity is still referenced (entries, relation): deleting it is refused.
  fails(() => plan([remove('entities', get('entities', entityId))]), 'E_DEPENDENTS')
  // 9. After a simulated restart, the deleted entry id cannot be reused.
  const restarted = readFormalState(JSON.parse(JSON.stringify(state)))
  fails(() => planCommands(memoryReader(restarted), [create('entries', layerEntry(secondId, layerId, {[ratingKey]:1}))], {baseRevision:restarted.revision, now:NOW}), 'E_RECREATE_ID')
  assert.equal(restarted.revision, 9)
})
