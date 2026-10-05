/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, entry, source, NOW, id } from './store.fixture.ts'
import type { Proposal } from './types.ts'
import { StoreError } from './schema.ts'
import { applyStoreCommands } from './commands.ts'
import { queryStoreLayer } from './query.ts'
import { acceptStoreProposal, readStoreProposal, rejectStoreProposal } from './proposals.ts'
const candidate=():Proposal=>({id:'synthetic-proposal',status:'pending',sourceId:'test:ai',evidenceIds:['proof-one'],createdAt:NOW,baseRevision:0,reason:'Synthetic candidate',commands:[{op:'create',table:'entries',value:{...entry(50),source:source('ai-record','test:ai')}}]})
const decision={reviewId:'synthetic-review',acceptedAt:NOW}
const throws=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:unknown)=>e instanceof StoreError&&e.code===code)
test('pending/rejected proposals are separate from facts and never counted by queries',()=>{
  const w=fixture(),p=readStoreProposal(candidate(),w)
  assert.equal(queryStoreLayer(w,'user:reading').length,3)
  const rejected=rejectStoreProposal(w,p);assert.equal(rejected.status,'rejected');assert.equal(w.entries.length,3)
  throws(()=>acceptStoreProposal(w,rejected,decision),'E_PROPOSAL_REPLAY')
})
test('acceptance records review, retains AI source and evidence, and mutates only a new world',()=>{
  const w=fixture(),accepted=acceptStoreProposal(w,candidate(),decision)
  assert.equal(accepted.world.entries.length,4);assert.equal(w.entries.length,3)
  const added=accepted.world.entries.find(e=>e.id===id(50))!
  assert.equal(added.source.sourceId,'test:ai');assert.equal(added.source.reviewId,decision.reviewId)
  assert.deepEqual(added.source.evidenceIds,['proof-one']);assert.equal(accepted.world.reviews[0].proposalId,'synthetic-proposal')
  assert.equal(accepted.proposal.status,'accepted');assert.ok(Object.isFrozen(accepted.proposal))
})
test('unconfirmed AI bypass and ordinary review receipt commands are refused',()=>{
  const w=fixture()
  throws(()=>applyStoreCommands(w,candidate().commands,0),'E_UNCONFIRMED')
  throws(()=>applyStoreCommands(w,[{op:'create',table:'reviews',value:{id:'fake',revision:0,proposalId:'p',sourceId:'test:ai',acceptedAt:NOW}}],0),'E_REVIEW_COMMAND')
})
test('stale/replayed or invalid proposal acceptance cannot partly commit a receipt',()=>{
  const w=fixture(),accepted=acceptStoreProposal(w,candidate(),decision)
  throws(()=>acceptStoreProposal(accepted.world,accepted.proposal,decision),'E_PROPOSAL_REPLAY')
  throws(()=>acceptStoreProposal(accepted.world,candidate(),decision),'E_STALE')
  const bad={...candidate(),commands:[{op:'create' as const,table:'entries' as const,value:{...entry(50),source:source('ai-record','test:ai'),fields:{rating:100}}}]}
  throws(()=>acceptStoreProposal(w,bad,decision),'E_FIELDS');assert.equal(w.reviews.length,0);assert.equal(w.entries.length,3)
})
test('candidate may not fabricate sources or register schemas to bypass evidence policy',()=>{
  const w=fixture()
  throws(()=>acceptStoreProposal(w,{...candidate(),commands:[{op:'create',table:'entries',value:entry(50)}]},decision),'E_PROPOSAL_SOURCE')
  throws(()=>readStoreProposal({...candidate(),commands:[{op:'create',table:'sources',value:w.sources[0]}]},w),'E_PROPOSAL_SCOPE')
  throws(()=>readStoreProposal({...candidate(),evidenceIds:['missing']},w),'E_REFERENCE')
})
test('review before candidate creation is invalid and errors expose no candidate reason',()=>{
  const w=fixture()
  throws(()=>acceptStoreProposal(w,candidate(),{...decision,acceptedAt:'2026-10-04T00:00:00Z'}),'E_TIME')
  assert.throws(()=>readStoreProposal({...candidate(),commands:[]},w),(e:unknown)=>e instanceof StoreError&&!e.message.includes('Synthetic candidate'))
})
