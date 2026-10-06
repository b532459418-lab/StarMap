/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, id, entry, source, title } from './store.fixture.ts'
import type { AnyStoreRow, StoreCommand, StoreTable, WorldStore } from './types.ts'
import { StoreError, readWorldStore } from './schema.ts'
import { applyStoreCommands, entryIdentityKey, readonlyCommands, sourceRecordKey } from './commands.ts'
import { queryOriginalAdjacency, queryStoreLayer } from './query.ts'
import { planStoreMerge } from './conflicts.ts'
const create=(table:StoreTable,value:AnyStoreRow):StoreCommand=>({op:'create',table,value})
const throws=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:unknown)=>e instanceof StoreError&&e.code===code)
function remove(w:WorldStore,table:StoreTable,row:AnyStoreRow){return applyStoreCommands(w,[{op:'remove',table,id:row.id,expectedRevision:row.revision}],w.revision)}

test('custom layer lifecycle creates, updates, deletes last entry and retains entity',()=>{
  let w=fixture()
  const layer={...w.layers[0],id:'user:never-prespecified',title:title('Custom')}
  w=applyStoreCommands(w,[create('layers',layer),create('entries',entry(50,layer.id))],w.revision)
  const updated={...w.entries.find(e=>e.id===id(50))!,fields:{rating:4,note:'Synthetic update'},revision:1}
  w=applyStoreCommands(w,[{op:'update',table:'entries',id:updated.id,expectedRevision:0,value:updated}],w.revision)
  assert.equal(queryStoreLayer(w,layer.id)[0].entry.fields.rating,4)
  w=remove(w,'entries',updated)
  assert.equal(queryStoreLayer(w,layer.id).length,0);assert.ok(w.entities.some(e=>e.id===id(1)))
  w=applyStoreCommands(w,[create('entries',entry(51,'user:favorites'))],w.revision)
  assert.equal(queryStoreLayer(w,'user:favorites')[0].entity.id,id(1))
})
test('multiple same-entity records and same raw ID from different sources remain distinct',()=>{
  const a={...entry(50),source:source('same-id','test:saved')},b={...entry(51),source:source('same-id','test:planned')}
  const w=applyStoreCommands(fixture(),[create('entries',a),create('entries',b)],0)
  assert.equal(queryStoreLayer(w,'user:reading').filter(r=>r.entity.id===id(1)).length,3)
  assert.notEqual(sourceRecordKey(a.source),sourceRecordKey(b.source));assert.notEqual(entryIdentityKey(a),entryIdentityKey(b))
  throws(()=>applyStoreCommands(w,[create('entries',{...a,id:id(52)})],w.revision),'E_SOURCE_COLLISION')
})
test('unknown custom type and layer names require only registered data',()=>{
  for(const name of ['song','building','something-new']){
    const w=fixture(),t={...w.entityTypes[0],id:'custom:'+name},l={...w.layers[0],id:'user:'+name,acceptedEntityTypes:[t.id]},e={...w.entities[0],id:id(50),typeId:t.id,source:source(name)}
    const next=applyStoreCommands(w,[create('entityTypes',t),create('layers',l),create('entities',e),create('entries',{...entry(60,l.id),entityId:e.id})],0)
    assert.equal(queryStoreLayer(next,l.id)[0].entity.typeId,t.id)
  }
})
test('entity and entry schema ownership are not interchangeable',()=>{
  const w=fixture()
  throws(()=>applyStoreCommands(w,[create('entries',{...entry(50),fields:{author:'Wrong owner'}})],0),'E_FIELDS')
  assert.equal(w.entities[0].fields.author,'Synthetic author')
})
test('failed batch refuses partial mutation and conflicting create never silently wins',()=>{
  const w=fixture(),before=JSON.stringify(w)
  throws(()=>applyStoreCommands(w,[create('entries',entry(50)),create('entities',{...w.entities[0],title:title('Conflict')})],0),'E_CONFLICT')
  assert.equal(JSON.stringify(w),before)
})
test('identical create is an idempotent no-op with unchanged revision',()=>{
  const w=fixture(),next=applyStoreCommands(w,[create('entities',w.entities[0])],0)
  assert.equal(next.revision,w.revision);assert.equal(next.entities.length,w.entities.length)
})
test('world and object revisions block stale edits and unknown IDs do not fabricate records',()=>{
  const w=fixture(),updated={...entry(10),revision:1}
  throws(()=>applyStoreCommands(w,[{op:'update',table:'entries',id:id(10),expectedRevision:0,value:updated}],1),'E_STALE')
  throws(()=>applyStoreCommands(w,[{op:'update',table:'entries',id:id(10),expectedRevision:9,value:updated}],0),'E_STALE')
  throws(()=>remove(w,'entries',entry(999)),'E_NOT_FOUND')
})
test('schema changes and record identity/source moves require explicit later migration',()=>{
  const w=fixture()
  throws(()=>applyStoreCommands(w,[{op:'update',table:'layers',id:w.layers[0].id,expectedRevision:0,value:{...w.layers[0],revision:1}}],0),'E_SCHEMA_CHANGE')
  throws(()=>applyStoreCommands(w,[{op:'update',table:'entries',id:id(10),expectedRevision:0,value:{...w.entries[0],revision:1,layerId:'user:favorites'}}],0),'E_IDENTITY')
  throws(()=>applyStoreCommands(w,[{op:'update',table:'entries',id:id(10),expectedRevision:0,value:{...w.entries[0],revision:1,source:source('other-source')}}],0),'E_SOURCE_IDENTITY')
})
test('removing referenced objects or assets fails whole-store reference checks',()=>{
  const w=fixture()
  for(const [table,row] of [['entities',w.entities[0]],['entries',w.entries[0]],['layers',w.layers[0]],['sources',w.sources[0]],['relationTypes',w.relationTypes[0]]] as const)throws(()=>remove(w,table,row),'E_REFERENCE')
  const assetWorld=readWorldStore({...w,entities:w.entities.map((e,i)=>i===0?{...e,fields:{...e.fields,cover:w.assets[0].id}}:e)})
  throws(()=>remove(assetWorld,'assets',assetWorld.assets[0]),'E_REFERENCE')
})
test('explicit dependency removal can commit as one validated batch',()=>{
  const w=fixture(),next=applyStoreCommands(w,[
    {op:'remove',table:'viewStates',id:w.viewStates[0].id,expectedRevision:0},
    {op:'remove',table:'sequences',id:w.sequences[0].id,expectedRevision:0},
    {op:'remove',table:'entries',id:id(10),expectedRevision:0},
  ],0)
  assert.equal(next.entries.length,2);assert.ok(next.entities.some(e=>e.id===id(1)))
})
test('nested results and inputs do not alias; query preserves hidden and coordinate-less records',()=>{
  const raw=structuredClone(fixture()),w=readWorldStore(raw)
  ;(raw.entities[0].fields as Record<string,string>).author='External mutation'
  assert.equal(w.entities[0].fields.author,'Synthetic author')
  assert.throws(()=>{(w.entities[0].fields as Record<string,string>).author='Mutation'},TypeError)
  const result=queryStoreLayer(w,'user:reading')
  assert.equal(result.length,3);assert.ok(result.some(r=>r.entry.id===id(11)))
  assert.throws(()=>{(result[0].entity.title.names as Record<string,string>).en='Mutation'},TypeError)
  const commands=[create('entries',entry(50))],copied=readonlyCommands(commands)
  commands.length=0;assert.equal(copied.length,1);assert.ok(Object.isFrozen(copied[0]))
})
test('sequence query preserves original adjacency and never bridges a filtered middle visit',()=>{
  const w=fixture()
  assert.equal(queryOriginalAdjacency(w,'original-order',[id(10),id(11),id(12)]).length,2)
  assert.deepEqual(queryOriginalAdjacency(w,'original-order',[id(10),id(12)]),[])
  assert.equal(queryOriginalAdjacency(w,'original-order',[id(10),id(11)]).length,1)
})
test('merge conflict is explicit and returns no partially applicable commands',()=>{
  const w=fixture(),incoming=readWorldStore({...w,entities:w.entities.map((e,i)=>i===0?{...e,fields:{author:'Other'}}:e),entries:[...w.entries,entry(50)]})
  const plan=planStoreMerge(w,incoming)
  assert.equal(plan.status,'conflict');assert.equal(plan.commands.length,0);assert.equal(plan.conflicts[0].table,'entities')
  assert.equal(w.entries.length,3)
})
test('merge deduplicates identical data and preflights explicit addition without applying it',()=>{
  const w=fixture();assert.equal(planStoreMerge(w,w).status,'identical')
  const incoming=readWorldStore({...w,entries:[...w.entries,entry(50)]}),plan=planStoreMerge(w,incoming)
  assert.equal(plan.status,'ready');assert.equal(w.entries.length,3)
  if(plan.status==='ready')assert.equal(applyStoreCommands(w,plan.commands,plan.baseRevision).entries.length,4)
})
test('importing revision history requires explicit policy rather than silent reset',()=>{
  const w=fixture(),incoming=readWorldStore({...w,entries:[...w.entries,{...entry(50),revision:2}]})
  throws(()=>planStoreMerge(w,incoming),'E_IMPORT_POLICY')
})
test('remove and recreate cannot bypass schema/source identity changes in the same batch',()=>{
  const w=fixture()
  throws(()=>applyStoreCommands(w,[{op:'remove',table:'entityTypes',id:w.entityTypes[0].id,expectedRevision:0},create('entityTypes',{...w.entityTypes[0],fields:[]})],0),'E_RECREATE_ID')
  throws(()=>applyStoreCommands(w,[{op:'remove',table:'sources',id:w.sources[0].id,expectedRevision:0},create('sources',{...w.sources[0],origin:'ai'})],0),'E_RECREATE_ID')
})
