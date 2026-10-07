import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { previewRepositoryBranchHistory as preview, assertRepositoryBranchHistoryCurrent as current } from './world-store-branch-history-preview.mjs'

function parent(name='parent', family='family') {
  const state=readRepositoryState({format:'starmap.world-repository',formatVersion:1,revision:0,world:seed().world,
    identities:{format:'starmap.v2-store-identities',version:1,identities:[]},proposals:[],retired:[]})
  return {format:'starmap.world-repository-v2',formatVersion:2,identity:{libraryId:family,branchId:name,genesisId:name+'-initial'},
    baseline:{sourceVersion:1,sourceDigest:digest(state),coverage:'baselineOnly',state,receipts:[]},history:[],state}
}
function branch(source=parent(), name='child', family='family') {
  const fork=previewRepositoryArchive(source), binding={hostId:'synthetic',locationDigest:'a'.repeat(64)}
  const descriptor={format:'starmap.repository-branch',formatVersion:1,identity:{libraryId:family,branchId:name,genesisId:name+'-initial'},
    origin:{kind:source.formatVersion===1?'upgrade':'fork',source:fork.source},binding}
  const creation={status:'completed',operationId:'create-'+name,requestDigest:digest({operationId:'create-'+name,previewDigest:fork.previewDigest,binding}),
    previewDigest:fork.previewDigest,policyDigest:digest({})}
  return {format:'starmap.world-repository-branch',formatVersion:3,descriptor,sourceArchive:source,creation,
    markerDigest:digest({format:'starmap.repository-branch-location',formatVersion:1,descriptor,creation}),state:source.state,history:[]}
}
function append(value, name, action, identities) {
  const before=value.state, request={id:name,expectedRevision:before.revision,action,...(identities?{identities}:{})}
  const after=transitionRepositoryState(before,request)
  const receipt={status:'committed',operationId:name,repositoryRevision:after.revision,worldRevision:after.world.revision,
    ...(value.formatVersion===3?{identity:value.descriptor.identity}:{})}
  value.history.push({operationId:name,request,requestDigest:digest(request),beforeDigest:digest(before),afterDigest:digest(after),after,receipt})
  value.state=after
  return value
}
function edit(value, name='edit', note=name, record=id(10)) {
  const row=value.state.world.entries.find(row=>row.id===record)
  return append(value,name,{kind:'commands',commands:[{op:'update',table:'entries',id:row.id,expectedRevision:row.revision,
    value:{...row,revision:row.revision+1,fields:{...row.fields,note}}}]})
}
const kinds=report=>report.conflicts.map(row=>row.kind)
const refuses=(fn,code)=>assert.throws(fn,error=>error.code===code)

test('exact archives are immutable/read-only with full local operation identities',()=>{
  const value=edit(branch()), before=structuredClone(value), report=preview(value,value)
  assert.equal(report.classification,'identical-archive'); assert.equal(report.executable,false)
  assert.deepEqual(report.commands,[]); assert.deepEqual(report.decisions,[])
  assert.equal(report.operations.identical.length,1); assert.equal(report.foreignReceiptsBecomeLocal,false)
  assert.deepEqual(value,before); assert.ok(Object.isFrozen(report.operations.identical[0].identity))
  assert.deepEqual(current(report,value,value),report)
})
test('siblings identify the exact shared known parent and independent same-named operations',()=>{
  const base=parent(), target=edit(branch(base,'left'),'same','left'), source=edit(branch(base,'right'),'same','right')
  const report=preview(target,source)
  assert.equal(report.commonBase.stateDigest,digest(base.state)); assert.equal(report.commonBase.identity.branchId,'parent')
  assert.equal(report.operations.conflicting.length,0); assert.equal(report.operations.incomingOnly.length,1)
  assert.equal(report.operations.targetOnly.length,1); assert.deepEqual(report.tables.entries.bothChanged,[id(10)])
  assert.ok(kinds(report).includes('record'))
})
test('one-sided foreign edit differs from competing edits without pretending it is executable',()=>{
  const base=parent(), target=branch(base,'left'), incoming=edit(branch(base,'right'))
  const report=preview(target,incoming)
  assert.equal(report.classification,'review-required'); assert.deepEqual(report.tables.entries.incomingChanged,[id(10)])
  assert.deepEqual(report.tables.entries.bothChanged,[]); assert.deepEqual(report.conflicts,[])
  assert.deepEqual(report.commands,[])
})
test('latest shared checkpoint includes a parent edit inherited by descendants',()=>{
  const base=edit(branch(parent(),'first'),'shared'), child=edit(branch(base,'second'),'later')
  const report=preview(base,child)
  assert.equal(report.commonBase.identity.branchId,'first'); assert.equal(report.commonBase.repositoryRevision,1)
  assert.equal(report.operations.identical.length,1); assert.equal(report.operations.incomingOnly.length,1)
  assert.equal(report.legacy.identical.length,1)
})
test('a live v2 parent can advance after the exact snapshot used to fork',()=>{
  const original=edit(parent(),'first'), target=branch(structuredClone(original)), incoming=edit(structuredClone(original),'later')
  const report=preview(target,incoming)
  assert.equal(report.commonBase.repositoryRevision,1); assert.equal(report.commonBase.identity.branchId,'parent')
  assert.equal(report.operations.identical.length,1); assert.equal(report.operations.incomingOnly.length,1)
})
test('same operation namespace with different content reports explicit conflict',()=>{
  const base=parent(), left=edit(structuredClone(base),'same','left'), right=edit(structuredClone(base),'same','right')
  const report=preview(left,right)
  assert.ok(kinds(report).includes('operation-identity')); assert.equal(report.operations.conflicting.length,1)
})
test('equal states reached by different operations do not become a fabricated shared checkpoint',()=>{
  const target=edit(parent(),'left-operation','same-result'), incoming=edit(parent(),'right-operation','same-result')
  assert.equal(digest(target.state),digest(incoming.state))
  const report=preview(target,incoming)
  assert.equal(report.commonBase.repositoryRevision,0)
  assert.equal(report.operations.identical.length,0);assert.equal(report.operations.incomingOnly.length,1)
  assert.equal(report.operations.targetOnly.length,1)
})
test('different genesis for the same family/branch never deduplicates an operation',()=>{
  const target=edit(parent()), incoming=edit(parent())
  incoming.identity.genesisId='different'
  const report=preview(target,incoming)
  assert.ok(kinds(report).includes('branch-genesis')); assert.ok(kinds(report).includes('operation-identity'))
  assert.equal(report.commonBase,null)
})
test('different library families remain a conflict even with equal facts',()=>{
  const report=preview(parent('a','one'),parent('a','two'))
  assert.ok(kinds(report).includes('library-family')); assert.equal(report.commonBase,null)
  assert.equal(report.operations.identical.length,0)
})
test('equal states and revisions in unrelated known branches do not prove common ancestry',()=>{
  const report=preview(parent('one'),parent('two'))
  assert.equal(report.classification,'ancestry-unproven'); assert.equal(report.commonBase,null)
})
test('same permanent identity with a different historical origin reports conflict even with equal current facts',()=>{
  const target=parent(), incoming=parent()
  incoming.baseline.state=structuredClone(incoming.baseline.state)
  incoming.baseline.state.world.entries[0].fields.note='different-baseline'
  incoming.baseline.sourceDigest=digest(incoming.baseline.state);incoming.state=incoming.baseline.state
  const report=preview(target,incoming)
  assert.ok(kinds(report).includes('branch-origin'));assert.equal(report.commonBase,null)
})
test('metadata/definition IDs remain table-local rather than inventing a global namespace',()=>{
  const value=parent(), state=structuredClone(value.state)
  state.world.sources[0].id='custom:book'
  for(const table of ['entities','entries','relations','anchors','assets','sequences'])for(const row of state.world[table]){
    if(row.source?.sourceId==='test:manual')row.source.sourceId='custom:book'
  }
  value.baseline.state=state;value.baseline.sourceDigest=digest(state);value.state=state
  const report=preview(value,value)
  assert.deepEqual(report.conflicts,[]);assert.equal(report.classification,'identical-archive')
  assert.equal(report.combinedStateValidated,false)
})
test('legacy exact packages are comparable without inventing permanent operation identities',()=>{
  const state=parent().state, legacy={format:'starmap.world-repository-legacy',formatVersion:1,coverage:'baselineOnly',editBodies:'unavailable',state,receipts:[]}
  const report=preview(legacy,legacy)
  assert.equal(report.classification,'identical-archive'); assert.equal(report.source.identity,null)
  assert.equal(report.commonBase,null); assert.deepEqual(report.operations.identical,[])
  assert.equal(report.legacy.identical.length,1); assert.equal(report.legacy.crossPackageDeduplication,false)
  const different=structuredClone(legacy); different.state.world.entries[0].fields.note='unproven'
  const unknown=preview(legacy,different)
  assert.equal(unknown.commonBase,null); assert.equal(unknown.legacy.incomingOnly.length,1)
})
test('legacy snapshots with equal current facts but different receipts cannot be cross-package deduplicated',()=>{
  const state=structuredClone(parent().state);state.revision=1
  const target={format:'starmap.world-repository-legacy',formatVersion:1,coverage:'baselineOnly',editBodies:'unavailable',state,
    receipts:[{status:'committed',operationId:'old',requestDigest:'a'.repeat(64),repositoryRevision:1,worldRevision:0}]}
  const incoming=structuredClone(target);incoming.receipts[0].requestDigest='b'.repeat(64)
  const report=preview(target,incoming)
  assert.equal(report.classification,'identity-insufficient');assert.equal(report.legacy.identical.length,0)
  assert.equal(report.legacy.incomingOnly[0].receiptCount,1);assert.equal(report.legacy.targetOnly[0].receiptCount,1)
  assert.deepEqual(report.operations.identical,[]);assert.equal(report.commonBase,null)
})
test('a reused branch namespace within one ancestry chain is refused rather than hidden by a map overwrite',()=>{
  const invalid=branch(branch(parent(),'middle'),'parent')
  refuses(()=>preview(invalid,parent()),'E_BRANCH_HISTORY_NAMESPACE')
})
test('descendants of one upgraded legacy archive share the new known branch checkpoint',()=>{
  const legacy={format:'starmap.world-repository-legacy',formatVersion:1,coverage:'baselineOnly',editBodies:'unavailable',state:parent().state,receipts:[]}
  const upgraded=branch(legacy,'upgraded'), child=edit(branch(upgraded,'child'))
  const report=preview(upgraded,child)
  assert.equal(report.commonBase.identity.branchId,'upgraded'); assert.equal(report.legacy.identical.length,1)
})
test('incoming deletion cannot erase a target edit and tombstone comparison is explicit',()=>{
  const base=append(parent(),'create',{kind:'commands',commands:[{op:'create',table:'entries',value:entry(60)}]})
  const target=edit(branch(base,'left'),'edit','local',id(60))
  const incoming=append(branch(base,'right'),'delete',{kind:'commands',commands:[{op:'remove',table:'entries',id:id(60),expectedRevision:0}]})
  const report=preview(target,incoming)
  assert.deepEqual(report.tables.entries.incomingDeleted,[id(60)])
  assert.equal(report.conflicts.find(row=>row.kind==='incoming-retired').targetChangedSinceBase,true)
  assert.deepEqual(report.tombstones.incomingOnly,[{table:'entries',id:id(60)}])
})
test('target tombstone cannot be revived by an incoming live snapshot',()=>{
  const base=append(parent(),'create',{kind:'commands',commands:[{op:'create',table:'entries',value:entry(60)}]})
  const target=append(branch(base,'left'),'delete',{kind:'commands',commands:[{op:'remove',table:'entries',id:id(60),expectedRevision:0}]})
  const report=preview(target,branch(base,'right'))
  assert.ok(kinds(report).includes('target-retired')); assert.deepEqual(report.tables.entries.targetDeleted,[id(60)])
  assert.equal(report.missingIncomingRecordsAreDeletions,false)
})
test('same missing records/tombstones are retained as exact history evidence',()=>{
  const base=append(parent(),'create',{kind:'commands',commands:[{op:'create',table:'entries',value:entry(60)}]})
  append(base,'delete',{kind:'commands',commands:[{op:'remove',table:'entries',id:id(60),expectedRevision:0}]})
  const report=preview(branch(base,'left'),branch(base,'right'))
  assert.deepEqual(report.tombstones.identical,[{table:'entries',id:id(60)}]); assert.deepEqual(report.conflicts,[])
})
test('missing incoming rows alone never become deletions',()=>{
  const target=append(parent('one'),'create',{kind:'commands',commands:[{op:'create',table:'entries',value:entry(60)}]})
  const report=preview(target,parent('two'))
  assert.deepEqual(report.tables.entries.targetOnly,[id(60)]); assert.deepEqual(report.tables.entries.incomingDeleted,[])
})
test('accepted candidate and review cannot be downgraded by an external pending snapshot',()=>{
  const base=append(parent(),'stage',{kind:'stage-proposal',proposal:candidate()})
  const target=append(branch(base,'left'),'accept',{kind:'accept-proposal',proposalId:'synthetic-proposal',decision:{reviewId:'synthetic-review',acceptedAt:NOW}})
  const report=preview(target,branch(base,'right'))
  assert.ok(kinds(report).includes('accepted-proposal-regression'))
  assert.deepEqual(report.proposals.changed,['synthetic-proposal']); assert.deepEqual(report.tables.reviews.targetChanged,['synthetic-review'])
})
test('external accepted candidate remains a coupled review conflict rather than an ordinary row copy',()=>{
  const base=append(parent(),'stage',{kind:'stage-proposal',proposal:candidate()})
  const incoming=append(branch(base,'right'),'accept',{kind:'accept-proposal',proposalId:'synthetic-proposal',decision:{reviewId:'synthetic-review',acceptedAt:NOW}})
  assert.ok(kinds(preview(branch(base,'left'),incoming)).includes('proposal'))
})
test('allocation conflicts survive even when neither allocated row is currently live',()=>{
  const target=append(parent('one'),'reserve',{kind:'stage-proposal',proposal:candidate()},[{kind:'entry',sourceId:'test:manual',recordId:'a',id:id(60)}])
  const incoming=append(parent('two'),'reserve',{kind:'stage-proposal',proposal:candidate()},[{kind:'entry',sourceId:'test:manual',recordId:'b',id:id(60)}])
  assert.ok(kinds(preview(target,incoming)).includes('identity-id'))
  const other=append(parent('three'),'reserve',{kind:'stage-proposal',proposal:candidate()},[{kind:'entry',sourceId:'test:manual',recordId:'a',id:id(61)}])
  assert.ok(kinds(preview(target,other)).includes('identity-record'))
})
test('same logical Entry source under different stable IDs is reported',()=>{
  const target=append(parent('one'),'create',{kind:'commands',commands:[{op:'create',table:'entries',value:entry(60)}]})
  const incoming=append(parent('two'),'create',{kind:'commands',commands:[{op:'create',table:'entries',value:{...entry(61),source:entry(60).source}}]})
  assert.ok(kinds(preview(target,incoming)).includes('entry-source'))
})
test('whole report, target/source history and policy changes invalidate freshness',()=>{
  const target=branch(), incoming=branch(parent(),'source'), report=preview(target,incoming)
  const changed=structuredClone(report); changed.executable=true
  refuses(()=>current(changed,target,incoming),'E_BRANCH_HISTORY_PREVIEW_STALE')
  refuses(()=>current(report,edit(structuredClone(target)),incoming),'E_BRANCH_HISTORY_PREVIEW_STALE')
  refuses(()=>current(report,target,edit(structuredClone(incoming))),'E_BRANCH_HISTORY_PREVIEW_STALE')
  // Branch creation proof itself pins its policy; a mismatched policy refuses
  // archive validation before report freshness can even be compared.
  refuses(()=>current(report,target,incoming,{maxEntries:10}),'E_BRANCH_CORRUPT')
})
test('tampered logs, missing ancestors and unknown versions are refused before comparison',()=>{
  const source=edit(branch()), target=branch(parent(),'target')
  for(const mutate of [v=>{v.history[0].request.action.commands[0].value.fields.note='tamper'},v=>{v.sourceArchive=null},v=>{v.formatVersion=99},v=>{v.history=[]}]){
    const bad=structuredClone(source); mutate(bad); assert.throws(()=>preview(target,bad))
  }
})
test('accessors and cyclic reports never execute during validation',()=>{
  let calls=0; const input=parent()
  Object.defineProperty(input,'history',{enumerable:true,get(){calls++;return []}})
  assert.throws(()=>preview(parent(),input)); assert.equal(calls,0)
  const policy={};Object.defineProperty(policy,'officialLayers',{enumerable:true,get(){calls++;return {}}})
  assert.throws(()=>preview(parent(),parent(),policy));assert.equal(calls,0)
  const report={}; report.self=report; assert.throws(()=>current(report,parent(),parent()))
})
