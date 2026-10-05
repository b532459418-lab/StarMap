/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, id } from './store.fixture.ts'
import { STORE_TABLES, StoreError, jsonKey, readWorldStore, validateCommands, validateJson, validateWorldStore } from './schema.ts'
import { classifyStoredDates } from './query.ts'

const throws = (fn:()=>unknown,code:string) => assert.throws(fn,(e:unknown)=>e instanceof StoreError&&e.code===code)
const modify = (fn:(v:Record<string,unknown>)=>void):unknown=>{
  const value=structuredClone(fixture()) as unknown as Record<string,unknown>;fn(value);return value
}
const rows = (v:Record<string,unknown>,table:string):Record<string,unknown>[]=>v[table] as Record<string,unknown>[]
test('complete logical store accepts anchors/relations/assets/sequence/views without inventing memberships',()=>{
  const w=fixture();assert.equal(w.entities.length,4);assert.equal(w.entries.length,3)
  assert.equal(w.reviews.length,0);assert.equal(w.assets.length,1)
})
for(const table of STORE_TABLES){
  test(`strict ${table} rows reject unexpected fields`,()=>{
    if(table==='reviews'){
      const value=modify(v=>{v.reviews=[{id:'r',revision:0,proposalId:'p',sourceId:'test:manual',acceptedAt:'2026-10-05T00:00:00Z',unexpected:true}]})
      throws(()=>readWorldStore(value),'E_SHAPE')
    }else throws(()=>readWorldStore(modify(v=>{rows(v,table)[0].unexpected=true})),'E_SHAPE')
  })
}
test('unsupported format and schemas refuse editing rather than discarding data',()=>{
  throws(()=>readWorldStore({...fixture(),formatVersion:2}),'E_VERSION')
  throws(()=>readWorldStore(modify(v=>{rows(v,'layers')[0].schemaVersion=2})),'E_SCHEMA_VERSION')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entityTypes')[0].schemaVersion=2})),'E_SCHEMA_VERSION')
})
test('UUIDv7 facts, opaque record IDs, and localized titles stay distinct',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].id='name-derived'})),'E_UUID7')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entries')[0].id='entry:record'})),'E_UUID7')
  const w=readWorldStore(modify(v=>{rows(v,'entities')[0].title={names:{},};rows(v,'entries')[0].source={sourceId:'test:manual',recordId:'legacy:opaque/value',evidenceIds:[]}}))
  assert.deepEqual(w.entities[0].title.names,{})
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].title={names:{en:'Name'},originalLanguage:'ja'}})),'E_TITLE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].title={names:{},originalLanguage:'constructor'}})),'E_TITLE')
})
test('custom entity/asset references are checked before deletion or load',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].fields={author:'A',related:id(999)}})),'E_REFERENCE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].fields={author:'A',cover:'missing'}})),'E_REFERENCE')
  const w=readWorldStore(modify(v=>{rows(v,'entities')[0].fields={author:'A',related:id(2),cover:'synthetic-asset'}}))
  assert.equal(w.entities[0].fields.cover,'synthetic-asset')
})
test('source/evidence/review references cannot silently become trusted facts',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].source={sourceId:'missing',recordId:'r',evidenceIds:[]}})),'E_REFERENCE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].source={sourceId:'test:manual',recordId:'r',evidenceIds:['missing']}})),'E_REFERENCE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].source={sourceId:'test:ai',recordId:'r',evidenceIds:[]}})),'E_UNCONFIRMED')
  throws(()=>readWorldStore(modify(v=>{v.reviews=[{id:'r',revision:0,proposalId:'p',sourceId:'test:saved',acceptedAt:'2026-10-05T00:00:00Z'}];rows(v,'entities')[0].source={sourceId:'test:ai',recordId:'r',evidenceIds:[],reviewId:'r'}})),'E_REVIEW_SOURCE')
})
test('date evidence preserves partial, invalid, null and missing raw values with RD04 semantics',()=>{
  for(const raw of [{startDate:'2025'},{startDate:'2025-02-29'},{startDate:null},{},{startDate:'2025-12-31',endDate:'2026-01-02'}]){
    const w=readWorldStore(modify(v=>{rows(v,'entries')[0].fields={dateEvidence:{raw}}}))
    assert.deepEqual(w.entries[0].fields.dateEvidence,{raw})
  }
  assert.equal(classifyStoredDates({raw:{startDate:'2025'}}).precision,'year')
  assert.equal(classifyStoredDates({raw:{startDate:'2025-02-29'}}).quality,'invalid')
  assert.equal(classifyStoredDates({raw:{}}).quality,'missing')
  assert.deepEqual(classifyStoredDates({raw:{startDate:'2025-12-31',endDate:'2026-01-02'}}).range,{from:'2025-12-31',to:'2026-01-02'})
})
test('date and date_evidence primitives deliberately have different validity requirements',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'entries')[0].fields={readAt:'2025-02-29'}})),'E_DATE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entries')[0].fields={dateEvidence:{raw:{startDate:'2025'},extra:true}}})),'E_SHAPE')
})
test('anchor coordinates and disclosure precision do not guess location or accept relation fields',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'anchors')[0].lat=91})),'E_COORDINATE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'anchors')[0].toEntityId=id(2)})),'E_SHAPE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'anchors')[0].precision='unknown'})),'E_PRECISION')
  assert.equal(fixture().anchors[0].kind,'location')
})
test('view references must belong to its layer, sequence references must exist',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'entries')[0].layerId='user:favorites'})),'E_VIEW_LAYER')
  throws(()=>readWorldStore(modify(v=>{rows(v,'sequences')[0].entryIds=[id(999)]})),'E_REFERENCE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'viewStates')[0].hiddenEntryIds=[id(999)]})),'E_REFERENCE')
})
test('system keys require trusted host binding and cannot be claimed by arbitrary layers',()=>{
  const w=modify(v=>{rows(v,'layers')[0].systemKey='reading'})
  throws(()=>readWorldStore(w),'E_SYSTEM_KEY')
  throws(()=>readWorldStore(w,{officialLayers:{reading:'wrong-layer'}}),'E_SYSTEM_KEY')
  assert.equal(readWorldStore(w,{officialLayers:{reading:'user:reading'}}).layers[0].systemKey,'reading')
})
test('enum-shaped arrays cannot bypass field, origin, visibility or precision checks',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'sources')[0].origin=['user']})),'E_SOURCE')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].visibility=['private']})),'E_VISIBILITY')
  throws(()=>readWorldStore(modify(v=>{rows(v,'anchors')[0].precision=['exact']})),'E_PRECISION')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entityTypes')[0].fields=[{key:'x',kind:['text']}]})),'E_FIELD_KIND')
})
test('finite bounds, mandatory fields and duplicate definitions fail closed',()=>{
  throws(()=>readWorldStore(modify(v=>{rows(v,'entities')[0].fields={}})),'E_REQUIRED')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entries')[0].fields={rating:6}})),'E_FIELDS')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entityTypes')[0].fields=[{key:'x',kind:'number',min:10,max:1}]})),'E_SCHEMA')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entityTypes')[0].fields=[{key:'x',kind:'text'},{key:'x',kind:'text'}]})),'E_SCHEMA')
  throws(()=>readWorldStore(modify(v=>{rows(v,'entityTypes')[0].fields=[{key:'__proto__',kind:'text'}]})),'E_SCHEMA')
})
test('JSON boundary rejects non-JSON values, accessors, cyclic and sparse arrays',()=>{
  for(const value of [NaN,Infinity,undefined,new Date(),1n,()=>0,Symbol('test')])throws(()=>validateJson(value),'E_JSON')
  const cycle:Record<string,unknown>={};cycle.self=cycle;throws(()=>validateJson(cycle),'E_JSON_CYCLE')
  const sparse:unknown[]=[];sparse.length=1;throws(()=>validateJson(sparse),'E_JSON_ARRAY')
  let touched=false;const getter={};Object.defineProperty(getter,'value',{enumerable:true,get(){touched=true;return 1}})
  throws(()=>validateWorldStore(getter),'E_JSON');assert.equal(touched,false)
})
test('structural equality sorts object keys without reordering array evidence',()=>{
  assert.equal(jsonKey({b:2,a:1}),jsonKey({a:1,b:2}))
  assert.notEqual(jsonKey(['A','B']),jsonKey(['B','A']))
})
test('malformed commands return safe error codes without leaking values',()=>{
  throws(()=>validateCommands([{op:'create',table:'entities',value:null}]),'E_SHAPE')
  const secretText='SYNTHETIC_PRIVATE_NOTE'
  assert.throws(()=>readWorldStore({...fixture(),extra:secretText}),(e:unknown)=>e instanceof StoreError&&!e.message.includes(secretText))
})
test('opaque extensions preserve unknown source fields without executing or treating them as references',()=>{
  const extra={originalDate:'historical text',externalIds:{other:'opaque-id'},arbitrary:[1,'not-a-reference']}
  const w=readWorldStore(modify(v=>{rows(v,'entities')[0].extensions=extra}))
  assert.deepEqual(w.entities[0].extensions,extra);assert.ok(Object.isFrozen(w.entities[0].extensions!.externalIds))
  throws(()=>readWorldStore(modify(v=>{rows(v,'entries')[0].extensions=[]})),'E_EXTENSIONS')
})
