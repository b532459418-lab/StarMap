/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, fixture, id } from './store.fixture.ts'
import { LAYER_SCOPE, formalFixture } from './formal.fixture.ts'
import { FORMAL_TABLES, type FormalRow, type FormalState, type FormalTable, emptyFormalState, readFormalState } from './formal.ts'
import { type Ref, memoryReader, referencesOf } from './reader.ts'
import { type RowLookup, validateRow } from './rows.ts'
import { MAX_POSITION_LENGTH, isPosition, positionBetween } from './position.ts'
import { StoreError, readWorldStore } from './schema.ts'

const throws=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:unknown)=>e instanceof StoreError&&e.code===code)
const modify=(fn:(v:Record<string,unknown>)=>void):unknown=>{
  const value=structuredClone(formalFixture()) as unknown as Record<string,unknown>;fn(value);return value
}
const rows=(v:Record<string,unknown>,table:string):Record<string,unknown>[]=>v[table] as Record<string,unknown>[]

test('formal state survives JSON serialization as a simulated restart',()=>{
  const state=formalFixture(),restored=readFormalState(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored,state);assert.ok(Object.isFrozen(restored.viewItems[0]))
  assert.deepEqual(readFormalState(JSON.parse(JSON.stringify(emptyFormalState()))),emptyFormalState())
  const buried=readFormalState({...state,tombstones:[{table:'entities',id:id(9),deletedAt:NOW}]})
  assert.deepEqual(readFormalState(JSON.parse(JSON.stringify(buried))).tombstones,[{table:'entities',id:id(9),deletedAt:NOW}])
})
test('formal tables replace viewStates with view rows and keep every G1 row rule',()=>{
  assert.deepEqual([...FORMAL_TABLES].filter(t=>!['viewItems','viewSettings'].includes(t)),[
    'sources','evidence','reviews','entityTypes','layers','entities','entries','relationTypes','relations','anchors','assets','sequences'])
  throws(()=>readFormalState(modify(v=>{v.viewStates=[]})),'E_SHAPE')
  throws(()=>readFormalState(modify(v=>{rows(v,'entities')[0].id='name-derived'})),'E_UUID7')
  throws(()=>readFormalState(modify(v=>{rows(v,'entities')[0].fields={}})),'E_REQUIRED')
  throws(()=>readFormalState(modify(v=>{rows(v,'entries')[0].fields={rating:6}})),'E_FIELDS')
  throws(()=>readFormalState(modify(v=>{rows(v,'entities')[0].source={sourceId:'test:ai',recordId:'r',evidenceIds:[]}})),'E_UNCONFIRMED')
  throws(()=>readFormalState(modify(v=>{rows(v,'anchors')[0].lat=91})),'E_COORDINATE')
  throws(()=>readFormalState(modify(v=>{rows(v,'entries')[1].source=rows(v,'entries')[0].source;rows(v,'entries')[1].entityId=id(1)})),'E_SOURCE_COLLISION')
  throws(()=>readFormalState(modify(v=>{rows(v,'layers')[0].systemKey='reading'})),'E_SYSTEM_KEY')
  assert.equal(readFormalState(modify(v=>{rows(v,'layers')[0].systemKey='reading'}),{officialLayers:{reading:'user:reading'}}).layers[0].systemKey,'reading')
})
test('view items: references, layer membership, unique key, position and scope',()=>{
  throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].layerId='user:favorites'})),'E_VIEW_LAYER')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].itemId=id(999)})),'E_REFERENCE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].layerId='missing'})),'E_REFERENCE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].itemTable='relations'})),'E_VIEW_TABLE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[1].itemId=id(12)})),'E_DUPLICATE')
  for(const position of ['','V0','a-b','x'.repeat(MAX_POSITION_LENGTH+1),5])throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].position=position})),'E_POSITION')
  for(const scope of ['',' ','s'.repeat(257),7])throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].scope=scope})),'E_SCOPE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewItems')[0].hidden='no'})),'E_SHAPE')
  // Entities and assets may be ordered in any scope; layerId only constrains entries.
  const state=readFormalState(modify(v=>{rows(v,'viewItems').push(
    {id:'item-c',revision:0,scope:'s'.repeat(256),itemTable:'entities',itemId:id(1),layerId:'user:favorites',position:'1',hidden:false},
    {id:'item-d',revision:0,scope:LAYER_SCOPE,itemTable:'assets',itemId:'synthetic-asset',position:'V',hidden:false})}))
  assert.equal(state.viewItems.length,4)
})
test('view settings: unique (scope, key), JSON value and checked ref',()=>{
  throws(()=>readFormalState(modify(v=>{rows(v,'viewSettings').push({id:'cover-two',revision:0,scope:'entity:'+id(1),key:'cover',value:1})})),'E_DUPLICATE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewSettings')[0].ref={table:'assets',id:'missing'}})),'E_REFERENCE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewSettings')[0].ref={table:'layers',id:'user:reading'}})),'E_VIEW_TABLE')
  throws(()=>readFormalState(modify(v=>{rows(v,'viewSettings')[0].ref={table:'assets',id:'synthetic-asset',extra:1}})),'E_SHAPE')
  const state=readFormalState(modify(v=>{rows(v,'viewSettings').push({id:'sort-one',revision:0,scope:LAYER_SCOPE,key:'sort',value:{by:'position',desc:false}})}))
  assert.deepEqual(state.viewSettings[1].value,{by:'position',desc:false})
})
test('deprecated is a formal-only field flag that cannot be required',()=>{
  const deprecated={key:'note',kind:'text',deprecated:true}
  const state=readFormalState(modify(v=>{rows(v,'layers')[0].entryFields=[...(rows(v,'layers')[0].entryFields as unknown[]),{key:'legacy',kind:'text',deprecated:true}]}))
  assert.equal(state.layers[0].entryFields.at(-1)!.deprecated,true)
  throws(()=>readFormalState(modify(v=>{rows(v,'entityTypes')[0].fields=[{key:'author',kind:'text',required:true,deprecated:true}]})),'E_SCHEMA')
  throws(()=>readFormalState(modify(v=>{rows(v,'relationTypes')[0].fields=[{...deprecated,deprecated:false}]})),'E_SCHEMA')
  throws(()=>readWorldStore({...fixture(),relationTypes:[{...fixture().relationTypes[0],fields:[deprecated]}]}),'E_SHAPE')
})
test('tombstones reserve ids of rows that no longer exist',()=>{
  const state=formalFixture()
  throws(()=>readFormalState({...state,tombstones:[{table:'entities',id:id(1),deletedAt:NOW}]}),'E_TOMBSTONE')
  throws(()=>readFormalState({...state,tombstones:[{table:'reviews',id:'r',deletedAt:NOW}]}),'E_TOMBSTONE')
  throws(()=>readFormalState({...state,tombstones:[{table:'viewStates',id:'r',deletedAt:NOW}]}),'E_TOMBSTONE')
  throws(()=>readFormalState({...state,tombstones:[{table:'entities',id:id(9),deletedAt:'yesterday'}]}),'E_TIME')
  throws(()=>readFormalState({...state,tombstones:[{table:'entities',id:id(9),deletedAt:NOW},{table:'entities',id:id(9),deletedAt:NOW}]}),'E_DUPLICATE')
})
test('validateRow checks one row through a lookup and keeps the two dialects apart',()=>{
  const state=formalFixture(),reader=memoryReader(state),lookup:RowLookup={get:(table,rowId)=>reader.get(table as FormalTable,rowId)}
  const entry={...state.entries[0],id:id(50),source:{sourceId:'test:manual',recordId:'new',evidenceIds:[]}}
  validateRow('entries',entry,lookup,{},'formal');validateRow('entries',entry,lookup)
  throws(()=>validateRow('entries',{...entry,entityId:id(999)},lookup,{},'formal'),'E_REFERENCE')
  throws(()=>validateRow('viewItems',state.viewItems[0],lookup),'E_TABLE')
  throws(()=>validateRow('viewStates',fixture().viewStates[0],lookup,{},'formal'),'E_TABLE')
})

const refSummary=(refs:readonly Ref[])=>refs.map(r=>`${r.field}->${r.toTable}`)
function richState():FormalState{
  return readFormalState(modify(v=>{
    v.reviews=[{id:'review-one',revision:0,proposalId:'proposal-one',sourceId:'test:saved',acceptedAt:NOW}]
    rows(v,'entities')[0].fields={author:'A',related:id(2),cover:'synthetic-asset'}
    rows(v,'entities')[0].source={sourceId:'test:saved',recordId:'entity-1',evidenceIds:['proof-one'],reviewId:'review-one'}
    rows(v,'layers')[1].entryFields=[{key:'rating',kind:'number'},{key:'companion',kind:'entity_ref'}]
    rows(v,'entries').push({id:id(20),revision:0,layerId:'user:favorites',entityId:id(2),fields:{companion:id(3)},source:{sourceId:'test:manual',recordId:'fav',evidenceIds:[]},createdAt:NOW,updatedAt:NOW})
    rows(v,'relationTypes')[0].fields=[{key:'note',kind:'text'},{key:'via',kind:'asset_ref'}]
    rows(v,'relations')[0].fields={note:'n',via:'synthetic-asset'}
  }))
}
test('referencesOf covers every reference kind of the formal tables',()=>{
  const state=richState(),reader=memoryReader(state)
  const of=(table:FormalTable,rowId:string)=>refSummary(referencesOf(table,reader.get(table,rowId)!,reader))
  assert.deepEqual(of('entities',id(1)),['typeId->entityTypes','fields.related->entities','fields.cover->assets','source.sourceId->sources','source.evidenceIds->evidence','source.reviewId->reviews'])
  assert.deepEqual(of('entries',id(20)),['layerId->layers','entityId->entities','fields.companion->entities','source.sourceId->sources'])
  assert.deepEqual(of('relations','relation-one'),['typeId->relationTypes','fromEntityId->entities','toEntityId->entities','fields.via->assets','source.sourceId->sources'])
  assert.deepEqual(of('anchors','location-one'),['entityId->entities','source.sourceId->sources'])
  assert.deepEqual(of('assets','synthetic-asset'),['source.sourceId->sources'])
  assert.deepEqual(of('sequences','original-order'),['entityId->entities','entryIds->entries','entryIds->entries','entryIds->entries','source.sourceId->sources'])
  assert.deepEqual(of('evidence','proof-one'),['sourceId->sources'])
  assert.deepEqual(of('reviews','review-one'),['sourceId->sources'])
  assert.deepEqual(of('layers','user:reading'),['acceptedEntityTypes->entityTypes'])
  assert.deepEqual(of('relationTypes','custom:related'),['fromTypes->entityTypes','toTypes->entityTypes'])
  assert.deepEqual(of('viewItems','item-a'),['itemId->entries','layerId->layers'])
  assert.deepEqual(of('viewSettings','cover-one'),['ref->assets'])
  assert.deepEqual(of('sources','test:manual'),[]);assert.deepEqual(of('entityTypes','custom:book'),[])
  assert.deepEqual(referencesOf('entities',reader.get('entities',id(1))!,reader).find(r=>r.field==='fields.related'),
    {fromTable:'entities',fromId:id(1),field:'fields.related',toTable:'entities',toId:id(2)})
})
test('which field values are references follows the current definition',()=>{
  const state=formalFixture(),reader=memoryReader(state)
  const row={...state.entities[0],fields:{author:'A',mentor:id(2)}} as FormalRow
  const withMentor={...state.entityTypes[0],fields:[...state.entityTypes[0].fields,{key:'mentor',kind:'entity_ref' as const}]}
  const current={get:(table:FormalTable,rowId:string)=>table==='entityTypes'?withMentor:reader.get(table,rowId)}
  assert.ok(!refSummary(referencesOf('entities',row,reader)).includes('fields.mentor->entities'))
  assert.ok(refSummary(referencesOf('entities',row,current)).includes('fields.mentor->entities'))
})
test('memoryReader answers rows, reverse references, tombstones and unique keys',()=>{
  const state=readFormalState({...richState(),tombstones:[{table:'entries',id:id(99),deletedAt:NOW}]}),reader=memoryReader(state)
  assert.equal(reader.revision,state.revision);assert.equal(reader.get('entries',id(10))!.id,id(10));assert.equal(reader.get('entries',id(99)),undefined)
  const deps=(table:FormalTable,rowId:string)=>reader.dependents(table,rowId).map(r=>`${r.fromTable}:${r.fromId}:${r.field}`).sort()
  assert.deepEqual(deps('entities',id(1)),['anchors:location-one:entityId','anchors:time-one:entityId','entries:'+id(10)+':entityId','relations:relation-one:fromEntityId'])
  assert.deepEqual(deps('entities',id(3)),['entries:'+id(12)+':entityId','entries:'+id(20)+':fields.companion'])
  assert.deepEqual(deps('assets','synthetic-asset'),['entities:'+id(1)+':fields.cover','relations:relation-one:fields.via','viewSettings:cover-one:ref'])
  assert.deepEqual(deps('entries',id(10)),['sequences:original-order:entryIds','viewItems:item-b:itemId'])
  assert.deepEqual(deps('reviews','review-one'),['entities:'+id(1)+':source.reviewId'])
  assert.deepEqual(deps('entities',id(4)),['sequences:original-order:entityId'])
  assert.ok(Object.isFrozen(reader.dependents('entities',id(1))));assert.deepEqual(reader.dependents('entities',id(999)),[])
  assert.equal(reader.isTombstoned('entries',id(99)),true);assert.equal(reader.isTombstoned('entities',id(99)),false)
  assert.equal(reader.findEntryByIdentity(id(1),'user:reading','test:manual','record-10'),id(10))
  assert.equal(reader.findEntryByIdentity(id(1),'user:favorites','test:manual','record-10'),undefined)
  assert.equal(reader.findReviewByProposal('proposal-one'),'review-one');assert.equal(reader.findLayerBySystemKey('reading'),undefined)
  assert.equal(reader.findViewItem(LAYER_SCOPE,'entries',id(12)),'item-a');assert.equal(reader.findViewItem(LAYER_SCOPE,'entities',id(12)),undefined)
  assert.equal(reader.findViewSetting('entity:'+id(1),'cover'),'cover-one')
  const official=memoryReader(readFormalState({...state,layers:state.layers.map((l,i)=>i?l:{...l,systemKey:'reading'})},{officialLayers:{reading:'user:reading'}}))
  assert.equal(official.findLayerBySystemKey('reading'),'user:reading')
  assert.equal(memoryReader({...emptyFormalState(),revision:7}).revision,7)
})

let seed=0x5eed
const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/0x100000000}
test('positionBetween orders keys in code-unit order and is deterministic',()=>{
  assert.deepEqual(['z','a','Z','A','9','0'].sort(),['0','9','A','Z','a','z'])
  assert.equal(positionBetween(),'V');assert.equal(positionBetween('V','k'),positionBetween('V','k'))
  const keys:string[]=[]
  for(let i=0;i<2000;i++){
    const at=Math.floor(random()*(keys.length+1)),key=positionBetween(keys[at-1],keys[at])
    if(at>0)assert.ok(keys[at-1]<key);if(at<keys.length)assert.ok(key<keys[at])
    assert.ok(isPosition(key));keys.splice(at,0,key)
  }
  assert.deepEqual([...keys].sort(),keys);assert.equal(new Set(keys).size,keys.length)
})
test('positionBetween appends, prepends and inserts repeatedly without running out early',()=>{
  const grow=(next:(last:string)=>string)=>{let last=positionBetween();for(let i=0;i<1000;i++)last=next(last);return last}
  const tail=grow(last=>{const key=positionBetween(last);assert.ok(key>last);return key})
  const head=grow(first=>{const key=positionBetween(undefined,first);assert.ok(key<first);return key})
  assert.ok(tail.length<=40&&head.length<=40)
  let upper='W'
  for(let i=0;i<500;i++){const key=positionBetween('V',upper);assert.ok('V'<key&&key<upper);upper=key}
  assert.ok(upper.length<=MAX_POSITION_LENGTH)
})
test('positionBetween rejects malformed or unordered bounds and exhausted space',()=>{
  for(const [before,after] of [['V','V'],['W','V'],['V0',undefined],['a-b',undefined],['',undefined],[undefined,'x'.repeat(65)]])
    throws(()=>positionBetween(before,after),'E_POSITION')
  throws(()=>positionBetween('z'.repeat(MAX_POSITION_LENGTH)),'E_POSITION')
  throws(()=>positionBetween(undefined,'0'.repeat(MAX_POSITION_LENGTH-1)+'1'),'E_POSITION')
  assert.equal(positionBetween('z'.repeat(MAX_POSITION_LENGTH-1)).length,MAX_POSITION_LENGTH)
})
