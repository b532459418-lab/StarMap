/// <reference types="node" />
/** The planner reads what a batch touches, not the store: with 10,000 entities and
 * 30,000 entries, a small batch makes a handful of reader calls. Timings are
 * reported as diagnostics only, never asserted. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, id } from './store.fixture.ts'
import { type FormalCommand, type FormalRow, type FormalState, emptyFormalState, readFormalState } from './formal.ts'
import { type StoreReader, memoryReader } from './reader.ts'
import { planCommands } from './planner.ts'
import type { JsonObject, LayerEntry } from './types.ts'

const READER_MEMBERS = ['revision','get','dependents','isTombstoned','findEntryByIdentity','findLayerBySystemKey','findReviewByProposal','findViewItem','findViewSetting']
const ENTITIES = 10_000, ENTRIES = 30_000
function largeState(): FormalState {
  const sourceId = 'scale:source', typeId = 'scale:type', layers = ['scale:a','scale:b','scale:c']
  const ref = (recordId: string) => ({sourceId,recordId,evidenceIds:[]})
  return {...emptyFormalState(),
    sources:[{id:sourceId,revision:0,title:{names:{}},origin:'user'}],
    entityTypes:[{id:typeId,revision:0,title:{names:{}},schemaVersion:1,fields:[{key:'name',kind:'text',required:true},{key:'friend',kind:'entity_ref'}]}],
    layers:layers.map(layerId => ({id:layerId,revision:0,title:{names:{}},schemaVersion:1,acceptedEntityTypes:[typeId],entryFields:[{key:'rating',kind:'number',min:0,max:10}]})),
    entities:Array.from({length:ENTITIES},(_,i) => ({id:id(i + 1),revision:0,typeId,title:{names:{}},
      fields:(i ? {name:'e'+i,friend:id(i)} : {name:'e0'}) as JsonObject,source:ref('entity-'+i),visibility:'private' as const})),
    entries:Array.from({length:ENTRIES},(_,i) => ({id:id(100_000 + i),revision:0,layerId:layers[i % 3],entityId:id(Math.floor(i / 3) + 1),
      fields:{rating:i % 11},source:ref('entry-'+i),createdAt:NOW,updatedAt:NOW})),
  }
}
/** Records every member the planner touches on the reader. */
function counted(reader: StoreReader) {
  const touched: string[] = []
  const proxy = new Proxy(reader,{get(target,member,receiver) { touched.push(String(member)); return Reflect.get(target,member,receiver) }})
  return {reader:proxy,touched}
}
const ms = (start: number) => Math.round((performance.now() - start) * 100) / 100

test('planning on 10,000 entities and 30,000 entries reads only what the batch touches',t => {
  let start = performance.now()
  const state = readFormalState(largeState())
  const validated = ms(start); start = performance.now()
  const base = memoryReader(state)
  const indexed = ms(start)
  assert.deepEqual([state.entities.length,state.entries.length],[ENTITIES,ENTRIES])
  const middle = state.entries[12_345] as LayerEntry
  const scenarios: [string, FormalCommand[]][] = [
    ['update one entry',[{op:'update',table:'entries',id:middle.id,expectedRevision:0,
      value:{...middle,revision:1,fields:{rating:4},updatedAt:'2026-10-06T00:00:00.000Z'} as FormalRow}]],
    ['create one entity and one entry',[
      {op:'create',table:'entities',value:{id:id(ENTITIES + 1),revision:0,typeId:'scale:type',title:{names:{}},fields:{name:'new',friend:id(5)},
        source:{sourceId:'scale:source',recordId:'entity-new',evidenceIds:[]},visibility:'private'} as FormalRow},
      {op:'create',table:'entries',value:{id:id(900_000),revision:0,layerId:'scale:b',entityId:id(ENTITIES + 1),fields:{rating:7},
        source:{sourceId:'scale:source',recordId:'entry-new',evidenceIds:[]},createdAt:NOW,updatedAt:NOW} as FormalRow}]],
  ]
  const report: string[] = [`readFormalState ${validated} ms, memoryReader ${indexed} ms`]
  for (const [name,commands] of scenarios) {
    const {reader,touched} = counted(base)
    start = performance.now()
    const changes = planCommands(reader,commands,{baseRevision:state.revision,now:NOW})
    const planned = ms(start)
    assert.equal(changes.nextRevision,state.revision + 1)
    assert.ok(touched.length <= 50,`${name}: ${touched.length} reader calls`)
    assert.deepEqual(touched.filter(member => !READER_MEMBERS.includes(member)),[])
    const counts = Object.fromEntries(READER_MEMBERS.map(m => [m,touched.filter(x => x === m).length]).filter(([,n]) => n))
    report.push(`${name}: ${touched.length} reader calls ${JSON.stringify(counts)}, planned in ${planned} ms`)
  }
  for (const line of report) t.diagnostic(line)
})
