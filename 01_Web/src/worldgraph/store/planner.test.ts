/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, entry, id, source, title } from './store.fixture.ts'
import { LAYER_SCOPE, formalFixture } from './formal.fixture.ts'
import { FORMAL_TABLES, type FormalCommand, type FormalRow, type FormalState, type FormalTable, readFormalState } from './formal.ts'
import { memoryReader, refKey, referencesOf } from './reader.ts'
import { type ChangeSet, type PlanContext, applyChangeSet, planCommands } from './planner.ts'
import { checkDefinitionChange } from './evolution.ts'
import { positionBetween } from './position.ts'
import { StoreError } from './schema.ts'
import type { JsonObject, StoreEntity } from './types.ts'

const LATER='2026-10-06T00:00:00.000Z'
const fails=(fn:()=>unknown,code:string,path?:string)=>assert.throws(fn,(e:unknown)=>e instanceof StoreError&&e.code===code&&(path===undefined||e.path===path))
const create=(table:FormalTable,value:unknown):FormalCommand=>({op:'create',table,value:value as FormalRow})
const update=(table:FormalTable,value:{id:string;revision:number}):FormalCommand=>({op:'update',table,id:value.id,expectedRevision:value.revision-1,value:value as unknown as FormalRow})
const remove=(table:FormalTable,row:{id:string;revision:number}):FormalCommand=>({op:'remove',table,id:row.id,expectedRevision:row.revision})
const plan=(state:FormalState,commands:FormalCommand[],extra:Partial<PlanContext>={}):ChangeSet=>planCommands(memoryReader(state),commands,{baseRevision:state.revision,now:NOW,...extra})
const run=(state:FormalState,commands:FormalCommand[],extra:Partial<PlanContext>={}):FormalState=>applyChangeSet(state,plan(state,commands,extra))
const entity=(n:number,fields:JsonObject={author:'A'}):StoreEntity=>({id:id(n),revision:0,typeId:'custom:book',title:title('Entity '+n),fields,source:source('entity-'+n),visibility:'private'})
const bump=<T extends {revision:number}>(row:T,patch:Partial<T>):T=>({...row,...patch,revision:row.revision+1})
const row=<T>(state:FormalState,table:FormalTable,rowId:string)=>memoryReader(state).get(table,rowId) as T

const book={id:'custom:book',revision:0,title:title('Book'),schemaVersion:1,fields:[
  {key:'author',kind:'text',required:true},{key:'pages',kind:'number',min:1,max:1000},{key:'note',kind:'text'}]}
const layer={id:'user:layer',revision:0,title:title('Layer'),schemaVersion:1,acceptedEntityTypes:['a'],entryFields:[{key:'rating',kind:'number'}]}
const relationType={id:'custom:rel',revision:0,title:title('Rel'),schemaVersion:1,fromTypes:['a'],toTypes:['a'],fields:[]}
const fieldsWith=(fields:unknown[])=>({...book,revision:1,fields})
test('checkDefinitionChange allows every compatible edit',()=>{
  const ok=(table:FormalTable,before:unknown,after:unknown)=>assert.doesNotThrow(()=>checkDefinitionChange(table,before,after))
  ok('entityTypes',book,{...book,revision:1,title:title('Renamed'),extensions:{icon:'book'}})
  ok('entityTypes',book,fieldsWith([...book.fields,{key:'isbn',kind:'text'}]))
  ok('entityTypes',book,fieldsWith([book.fields[0],book.fields[1],{key:'note',kind:'text',deprecated:true}]))
  ok('entityTypes',fieldsWith([book.fields[0],book.fields[1],{key:'note',kind:'text',deprecated:true}]),book)
  ok('entityTypes',book,fieldsWith([{key:'author',kind:'text'},book.fields[1],book.fields[2]]))
  ok('entityTypes',book,fieldsWith([book.fields[0],{key:'pages',kind:'number',min:0,max:2000},book.fields[2]]))
  ok('entityTypes',book,fieldsWith([book.fields[0],{key:'pages',kind:'number'},book.fields[2]]))
  ok('entityTypes',book,fieldsWith([book.fields[2],book.fields[1],book.fields[0]]))
  ok('layers',layer,{...layer,acceptedEntityTypes:['a','b'],entryFields:[...layer.entryFields,{key:'note',kind:'text'}]})
  ok('layers',layer,{...layer,acceptedEntityTypes:[]})
  ok('relationTypes',relationType,{...relationType,fromTypes:['a','b'],toTypes:[]})
  ok('sources',{id:'s',revision:0,title:title('S'),origin:'import'},{id:'s',revision:1,title:title('Renamed'),origin:'import'})
})
test('checkDefinitionChange rejects every edit that changes what stored values mean',()=>{
  const no=(table:FormalTable,before:unknown,after:unknown,path:string)=>fails(()=>checkDefinitionChange(table,before,after),'E_SCHEMA_CHANGE',path)
  no('entityTypes',book,fieldsWith([book.fields[0],book.fields[1]]),'entityTypes.fields')
  no('entityTypes',book,fieldsWith([book.fields[0],book.fields[1],{key:'note',kind:'date'}]),'entityTypes.fields')
  no('entityTypes',book,fieldsWith([book.fields[0],book.fields[1],{key:'note',kind:'text',required:true}]),'entityTypes.fields')
  no('entityTypes',book,fieldsWith([...book.fields,{key:'isbn',kind:'text',required:true}]),'entityTypes.fields')
  no('entityTypes',book,fieldsWith([book.fields[0],{key:'pages',kind:'number',min:2,max:1000},book.fields[2]]),'entityTypes.fields')
  no('entityTypes',book,fieldsWith([book.fields[0],{key:'pages',kind:'number',min:1,max:999},book.fields[2]]),'entityTypes.fields')
  no('entityTypes',fieldsWith([book.fields[0],{key:'pages',kind:'number'},book.fields[2]]),book,'entityTypes.fields')
  no('layers',layer,{...layer,entryFields:[]},'layers.entryFields')
  no('layers',{...layer,acceptedEntityTypes:['a','b']},layer,'layers.acceptedEntityTypes')
  no('layers',{...layer,acceptedEntityTypes:[]},layer,'layers.acceptedEntityTypes')
  no('layers',layer,{...layer,systemKey:'travel'},'layers.systemKey')
  no('layers',{...layer,systemKey:'travel'},{...layer,systemKey:'want_to_go'},'layers.systemKey')
  no('layers',{...layer,systemKey:'travel'},layer,'layers.systemKey')
  no('relationTypes',{...relationType,fromTypes:['a','b']},relationType,'relationTypes.fromTypes')
  no('relationTypes',relationType,{...relationType,toTypes:['b']},'relationTypes.toTypes')
  no('relationTypes',relationType,{...relationType,fields:[{key:'x',kind:'text',required:true}]},'relationTypes.fields')
  no('sources',{id:'s',revision:0,title:title('S'),origin:'import'},{id:'s',revision:1,title:title('S'),origin:'ai'},'sources.origin')
  no('evidence',{},{},'evidence')
})
test('planner applies compatible definition edits that G1 refuses, and only those',()=>{
  let state=formalFixture()
  const type=state.entityTypes[0]
  state=run(state,[update('entityTypes',bump(type,{title:title('Novel'),fields:[...type.fields,{key:'isbn',kind:'text'}]}))])
  assert.equal(row<{fields:unknown[]}>(state,'entityTypes','custom:book').fields.length,4)
  state=run(state,[update('entities',bump(state.entities[0],{fields:{author:'A',isbn:'x'}}))])
  const typeNow=row<typeof type>(state,'entityTypes','custom:book')
  fails(()=>plan(state,[update('entityTypes',bump(typeNow,{fields:typeNow.fields.slice(1)}))]),'E_SCHEMA_CHANGE','entityTypes.fields')
  fails(()=>plan(state,[update('layers',bump(state.layers[1],{acceptedEntityTypes:['custom:book']}))]),'E_SCHEMA_CHANGE','layers.acceptedEntityTypes')
  const manual=state.sources[0]
  state=run(state,[update('sources',bump(manual,{title:title('Manual input')}))])
  fails(()=>plan(state,[update('sources',bump(row<typeof manual>(state,'sources',manual.id),{origin:'ai'}))]),'E_SCHEMA_CHANGE','sources.origin')
  fails(()=>plan(state,[update('evidence',bump(state.evidence[0],{attributes:{}}))]),'E_SCHEMA_CHANGE','evidence')
  // A definition edit is validated like any row: a required field cannot also be deprecated.
  const deprecateRequired=bump(typeNow,{fields:typeNow.fields.map(f=>f.key==='author'?{...f,deprecated:true as const}:f)})
  fails(()=>plan(state,[update('entityTypes',deprecateRequired)]),'E_SCHEMA')
})
test('a deprecated field keeps its stored value but takes no new one',()=>{
  let state=formalFixture()
  const reading=state.layers[0],tenth=state.entries[0]
  state=run(state,[update('entries',bump(tenth,{fields:{rating:5,note:'kept'}}))])
  state=run(state,[update('layers',bump(reading,{entryFields:reading.entryFields.map(f=>f.key==='note'?{...f,deprecated:true as const}:f)}))])
  const kept=row<typeof tenth>(state,'entries',tenth.id)
  assert.deepEqual(kept.fields,{rating:5,note:'kept'})
  state=run(state,[update('entries',bump(kept,{fields:{rating:4,note:'kept'},updatedAt:LATER}))])
  const now=row<typeof tenth>(state,'entries',tenth.id)
  fails(()=>plan(state,[update('entries',bump(now,{fields:{rating:4,note:'changed'}}))]),'E_FIELD_DEPRECATED','entries.fields')
  fails(()=>plan(state,[create('entries',{...entry(50),fields:{note:'new'}})]),'E_FIELD_DEPRECATED','entries.fields')
  assert.equal(run(state,[create('entries',{...entry(50),fields:{rating:1}})]).entries.length,4)
  assert.deepEqual(run(state,[update('entries',bump(now,{fields:{rating:4}}))]).entries[0].fields,{rating:4})
  // Clearing deprecation makes the field writable again.
  const deprecated=row<typeof reading>(state,'layers',reading.id)
  state=run(state,[update('layers',bump(deprecated,{entryFields:reading.entryFields}))])
  assert.equal(run(state,[update('entries',bump(now,{fields:{rating:4,note:'changed'}}))]).entries[0].fields.note,'changed')
})
test('tombstones refuse recreation in the same batch, a later batch and after a restart',()=>{
  let state=run(formalFixture(),[create('entries',entry(50,'user:favorites'))])
  const fiftieth=row<{id:string;revision:number}>(state,'entries',id(50))
  fails(()=>plan(state,[remove('entries',fiftieth),create('entries',entry(50,'user:favorites'))]),'E_RECREATE_ID','entries')
  const changes=plan(state,[remove('entries',fiftieth)],{now:LATER})
  assert.deepEqual(changes.tombstones,[{table:'entries',id:id(50),deletedAt:LATER}])
  assert.deepEqual(changes.deletes,[{table:'entries',id:id(50)}])
  state=applyChangeSet(state,changes)
  fails(()=>plan(state,[create('entries',entry(50,'user:favorites'))]),'E_RECREATE_ID','entries')
  const restarted=readFormalState(JSON.parse(JSON.stringify(state)))
  fails(()=>plan(restarted,[create('entries',entry(50,'user:favorites'))]),'E_RECREATE_ID','entries')
  fails(()=>plan(restarted,[update('entries',{...entry(50,'user:favorites'),revision:1})]),'E_NOT_FOUND','entries')
  // Created and deleted in one batch: nothing to write or delete, but the id is buried.
  const transient=plan(restarted,[create('entries',entry(51,'user:favorites')),remove('entries',entry(51,'user:favorites'))])
  assert.deepEqual([transient.upserts,transient.deletes],[[],[]]);assert.equal(transient.tombstones[0].id,id(51))
  assert.equal(transient.nextRevision,restarted.revision+1)
})
test('deleting a row that is still referenced reports the first referencing table',()=>{
  const state=run(formalFixture(),[create('entities',entity(60)),create('entities',entity(61,{author:'A',related:id(60)}))])
  fails(()=>plan(state,[remove('entities',state.entities[0])]),'E_DEPENDENTS','entries.entityId')
  fails(()=>plan(state,[remove('entities',state.entities[3])]),'E_DEPENDENTS','sequences.entityId')
  fails(()=>plan(state,[remove('entities',row(state,'entities',id(60)))]),'E_DEPENDENTS','entities.fields.related')
  const lonely=run(state,[remove('sequences',state.sequences[0]),remove('entries',state.entries[0])])
  fails(()=>plan(lonely,[remove('entities',lonely.entities[0])]),'E_DEPENDENTS','relations.fromEntityId')
  const noRelation=run(lonely,[remove('relations',lonely.relations[0])])
  fails(()=>plan(noRelation,[remove('entities',noRelation.entities[0])]),'E_DEPENDENTS','anchors.entityId')
  fails(()=>plan(noRelation,[remove('entityTypes',noRelation.entityTypes[0])]),'E_DEPENDENTS','layers.acceptedEntityTypes')
  fails(()=>plan(noRelation,[remove('sources',noRelation.sources[0])]),'E_DEPENDENTS','entities.source.sourceId')
  fails(()=>plan(noRelation,[remove('assets',{...noRelation.assets[0]}),create('entities',entity(62,{author:'A',cover:'synthetic-asset'}))]),'E_REFERENCE','entities.fields')
  const withCover=run(noRelation,[create('entities',entity(62,{author:'A',cover:'synthetic-asset'}))])
  fails(()=>plan(withCover,[remove('assets',withCover.assets[0])]),'E_DEPENDENTS','entities.fields.cover')
  // The referencing rows are deleted earlier in the same batch: allowed.
  const cleared=run(noRelation,[remove('anchors',noRelation.anchors[0]),remove('anchors',noRelation.anchors[1]),remove('entities',noRelation.entities[0])])
  assert.equal(row(cleared,'entities',id(1)),undefined)
  // Order matters: commands run in sequence, so the dependent must go first.
  fails(()=>plan(noRelation,[remove('entities',noRelation.entities[0]),remove('anchors',noRelation.anchors[0]),remove('anchors',noRelation.anchors[1])]),'E_DEPENDENTS','anchors.entityId')
  // A self reference never blocks its own row.
  const self=run(state,[create('entities',entity(63)),update('entities',bump(entity(63),{fields:{author:'A',related:id(63)}}))])
  assert.equal(row(run(self,[remove('entities',row(self,'entities',id(63)))]),'entities',id(63)),undefined)
})
test('deleting the last entry keeps the entity; view rows follow their target with tombstones',()=>{
  const state=formalFixture()
  const changes=plan(state,[remove('sequences',state.sequences[0]),remove('entries',row(state,'entries',id(12)))])
  assert.deepEqual(changes.deletes,[{table:'sequences',id:'original-order'},{table:'viewItems',id:'item-a'},{table:'entries',id:id(12)}])
  assert.deepEqual(changes.tombstones.map(t=>t.table+':'+t.id),['sequences:original-order','viewItems:item-a','entries:'+id(12)])
  assert.deepEqual(changes.summary.counts.viewItems,{created:0,updated:0,removed:1})
  const next=applyChangeSet(state,changes)
  assert.ok(row(next,'entities',id(3)));assert.equal(next.viewItems.length,1)
  const coverless=run(state,[remove('assets',state.assets[0])])
  assert.deepEqual([coverless.assets.length,coverless.viewSettings.length],[0,0])
  assert.ok(coverless.tombstones.some(t=>t.table==='viewSettings'&&t.id==='cover-one'))
  fails(()=>plan(coverless,[create('viewSettings',state.viewSettings[0])]),'E_RECREATE_ID','viewSettings')
})
test('an empty layer can be deleted; a layer with entries cannot',()=>{
  const state=run(formalFixture(),[create('viewItems',{id:'fav-item',revision:0,scope:'layer:user:favorites',itemTable:'entities',itemId:id(1),layerId:'user:favorites',position:'V',hidden:false})])
  const favorites=state.layers[1]
  const changes=plan(state,[remove('layers',favorites)])
  assert.deepEqual(changes.deletes,[{table:'viewItems',id:'fav-item'},{table:'layers',id:'user:favorites'}])
  fails(()=>plan(state,[remove('layers',state.layers[0])]),'E_DEPENDENTS','entries.layerId')
  const withEntry=run(state,[create('entries',entry(50,'user:favorites'))])
  fails(()=>plan(withEntry,[remove('layers',row(withEntry,'layers','user:favorites'))]),'E_DEPENDENTS','entries.layerId')
})
test('view rows: unique keys through the reader, layer membership and reordering',()=>{
  const state=formalFixture(),itemA=state.viewItems[0],itemB=state.viewItems[1]
  const viewItem=(patch:Record<string,unknown>)=>({...itemA,id:'item-z',...patch})
  fails(()=>plan(state,[create('viewItems',viewItem({}))]),'E_DUPLICATE','viewItems.itemId')
  fails(()=>plan(state,[update('viewItems',bump(itemB,{itemId:id(12)}))]),'E_DUPLICATE','viewItems.itemId')
  fails(()=>plan(state,[create('viewItems',viewItem({itemId:id(11),layerId:'user:favorites'}))]),'E_VIEW_LAYER','viewItems.layerId')
  fails(()=>plan(state,[create('viewSettings',{...state.viewSettings[0],id:'cover-two'})]),'E_DUPLICATE','viewSettings.key')
  // Freed within the batch: the key moves to a new row.
  const moved=run(state,[remove('viewItems',itemA),create('viewItems',viewItem({}))])
  assert.equal(memoryReader(moved).findViewItem(LAYER_SCOPE,'entries',id(12)),'item-z')
  const swapped=run(state,[update('viewItems',bump(itemA,{scope:'other'})),update('viewItems',bump(itemB,{itemId:id(12)}))])
  assert.equal(memoryReader(swapped).findViewItem(LAYER_SCOPE,'entries',id(12)),'item-b')
  // Reorder: item-a moves after item-b ('V' < 'k').
  const reordered=run(state,[update('viewItems',bump(itemA,{position:positionBetween(itemB.position)}))])
  const order=[...reordered.viewItems].sort((x,y)=>x.position<y.position?-1:1).map(v=>v.id)
  assert.deepEqual(order,['item-b','item-a'])
  fails(()=>plan(state,[update('viewItems',bump(itemA,{position:'V0'}))]),'E_POSITION','viewItems.position')
})

const allRefs=(state:FormalState)=>{
  const reader=memoryReader(state),keys=new Set<string>()
  for(const table of FORMAL_TABLES)for(const r of state[table])for(const ref of referencesOf(table,r,reader))keys.add(refKey(ref))
  return keys
}
test('refsAdded and refsRemoved equal the reference diff before and after',()=>{
  const start=run(formalFixture(),[create('entities',entity(60))])
  const batches:FormalCommand[][]=[
    [create('entities',entity(61,{author:'A',related:id(60),cover:'synthetic-asset'})),create('entries',{...entry(50),entityId:id(61)})],
    [update('entities',bump(entity(61,{author:'A',related:id(60),cover:'synthetic-asset'}),{fields:{author:'A',related:id(2)}}))],
    [remove('sequences',start.sequences[0]),remove('entries',row(start,'entries',id(12))),remove('assets',start.assets[0])],
    [update('entities',bump(start.entities[0],{source:{...start.entities[0].source,evidenceIds:['proof-one']}}))],
  ]
  let state=start
  for(const commands of batches){
    const changes=plan(state,commands),next=applyChangeSet(state,changes),before=allRefs(state),after=allRefs(next)
    assert.deepEqual(changes.refsAdded.map(refKey).sort(),[...after].filter(k=>!before.has(k)).sort())
    assert.deepEqual(changes.refsRemoved.map(refKey).sort(),[...before].filter(k=>!after.has(k)).sort())
    state=next
  }
})
test('change sets are complete, frozen JSON with one store revision step',()=>{
  const state=formalFixture()
  const changes=plan(state,[create('entities',entity(60)),update('entities',bump(entity(60),{fields:{author:'B'}}))])
  assert.equal(changes.nextRevision,state.revision+1);assert.ok(Object.isFrozen(changes)&&Object.isFrozen(changes.upserts[0].row))
  assert.deepEqual(JSON.parse(JSON.stringify(changes)),changes)
  assert.deepEqual(changes.upserts,[{table:'entities',row:bump(entity(60),{fields:{author:'B'}})}])
  assert.deepEqual(changes.summary.counts.entities,{created:1,updated:0,removed:0})
  assert.deepEqual(Object.keys(changes.summary.counts),[...FORMAL_TABLES])
  const same=plan(state,[create('entities',state.entities[0])])
  assert.equal(same.nextRevision,state.revision);assert.deepEqual([same.upserts,same.tombstones,same.refsAdded],[[],[],[]])
  const updated=applyChangeSet(state,plan(state,[update('entities',bump(state.entities[1],{title:title('Edited')}))]))
  assert.equal(updated.revision,state.revision+1);assert.equal(updated.entities[1].title.names.en,'Edited')
})
test('stale store revisions are refused by the planner and by applyChangeSet',()=>{
  const state=formalFixture(),changes=plan(state,[create('entities',entity(60))])
  fails(()=>planCommands(memoryReader(state),[create('entities',entity(60))],{baseRevision:state.revision+1,now:NOW}),'E_STALE','command.baseRevision')
  const next=applyChangeSet(state,changes)
  fails(()=>applyChangeSet(next,changes),'E_STALE','changeSet.baseRevision')
  fails(()=>applyChangeSet(state,{...changes,baseRevision:state.revision+1}),'E_STALE','changeSet.baseRevision')
  assert.equal(next.revision,state.revision+1);assert.equal(state.entities.length,4)
  fails(()=>planCommands(memoryReader(state),[create('entities',entity(60))],{baseRevision:state.revision,now:'not a time'}),'E_TIME','ctx.now')
})
test('a failing command rejects the whole batch with no partial change set',()=>{
  const state=formalFixture()
  fails(()=>plan(state,[create('entities',entity(60)),create('entities',{...state.entities[0],title:title('Conflict')})]),'E_CONFLICT','entities')
  fails(()=>plan(state,[create('entities',entity(60)),create('entries',{...entry(50),entityId:id(999)})]),'E_REFERENCE','entries.entityId')
  // Later commands see earlier ones: a forward reference is refused.
  fails(()=>plan(state,[create('entries',{...entry(50),entityId:id(60)}),create('entities',entity(60))]),'E_REFERENCE','entries.entityId')
  assert.equal(run(state,[create('entities',entity(60)),create('entries',{...entry(50),entityId:id(60)})]).entries.length,4)
})
test('review receipts enter only through the accepted review, once per proposal, across batches',()=>{
  const state=formalFixture(),review={id:'review-one',revision:0,proposalId:'proposal-one',sourceId:'test:ai',acceptedAt:NOW}
  const aiEntry={...entry(50),source:{...source('ai-record','test:ai'),reviewId:'review-one'}}
  fails(()=>plan(state,[create('entries',aiEntry)]),'E_UNCONFIRMED','command.create')
  fails(()=>plan(state,[create('reviews',review)]),'E_REVIEW_COMMAND','reviews')
  const accepted=run(state,[create('entries',aiEntry)],{acceptedReview:review})
  assert.equal(row<{proposalId:string}>(accepted,'reviews','review-one').proposalId,'proposal-one')
  fails(()=>plan(accepted,[create('entries',{...aiEntry,id:id(51),source:{...aiEntry.source,recordId:'other'}})],{acceptedReview:{...review,id:'review-two'}}),'E_REVIEW_REPLAY','reviews')
  fails(()=>plan(accepted,[create('entities',entity(60))],{acceptedReview:review}),'E_REVIEW_REPLAY','reviews')
  fails(()=>plan(accepted,[remove('reviews',review)]),'E_REVIEW_COMMAND','reviews')
})
test('official layer keys are bound by host policy',()=>{
  const state=formalFixture(),official={...state.layers[1],id:'starmap:travel',systemKey:'travel'}
  fails(()=>plan(state,[create('layers',official)]),'E_SYSTEM_KEY','layers.systemKey')
  fails(()=>plan(state,[create('layers',official)],{policy:{officialLayers:{travel:'other'}}}),'E_SYSTEM_KEY','layers.systemKey')
  const next=run(state,[create('layers',official)],{policy:{officialLayers:{travel:'starmap:travel'}}})
  assert.equal(memoryReader(next).findLayerBySystemKey('travel'),'starmap:travel')
})
