import type { AnyStoreRow, Proposal, ReviewReceipt, SourceRef, StoreCommand, StorePolicy, WorldStore } from './types.ts'
import { freezeCopy, opaqueId, reject, revision, shape, utcTimestamp, validateCommands, validateJson, validateWorldStore } from './schema.ts'
import { applyStoreCommands } from './commands.ts'

export function readStoreProposal(value: unknown, world: WorldStore, policy: StorePolicy = {}): Proposal {
  validateWorldStore(world,policy);validateJson(value)
  shape(value,['id','sourceId','evidenceIds','createdAt','baseRevision','reason','commands','status'])
  opaqueId(value.id,'proposal.id');utcTimestamp(value.createdAt,'proposal.createdAt');revision(value.baseRevision,'proposal.baseRevision')
  if(!world.sources.some(s=>s.id===value.sourceId))reject('E_REFERENCE','proposal.sourceId')
  if(typeof value.reason!=='string'||!['pending','accepted','rejected'].includes(value.status as string))reject('E_PROPOSAL','proposal')
  if(!Array.isArray(value.evidenceIds)||new Set(value.evidenceIds).size!==value.evidenceIds.length)reject('E_PROPOSAL','proposal.evidenceIds')
  for(const id of value.evidenceIds)if(!world.evidence.some(e=>e.id===id))reject('E_REFERENCE','proposal.evidenceIds')
  validateCommands(value.commands)
  if(value.commands.some(c=>!['entities','entries','relations','anchors','assets','sequences'].includes(c.table)))reject('E_PROPOSAL_SCOPE','proposal.commands')
  return freezeCopy(value as unknown as Proposal)
}
/** Calling host must obtain review authorization. The injected receipt is an audit
 * boundary, NOT a cryptographic proof or an IO transaction. Store + proposal must
 * be committed durably together by the future Repository.
 */
export function acceptStoreProposal(
  world:WorldStore,input:Proposal,decision:{readonly reviewId:string;readonly acceptedAt:string},policy:StorePolicy={},
):{readonly world:WorldStore;readonly proposal:Proposal}{
  const proposal=readStoreProposal(input,world,policy)
  if(proposal.status!=='pending')reject('E_PROPOSAL_REPLAY','proposal.status')
  if(proposal.baseRevision!==world.revision)reject('E_STALE','proposal.baseRevision')
  validateJson(decision);shape(decision,['reviewId','acceptedAt'])
  opaqueId(decision.reviewId,'review.id');utcTimestamp(decision.acceptedAt,'review.acceptedAt')
  if(Date.parse(decision.acceptedAt)<Date.parse(proposal.createdAt))reject('E_TIME','review.acceptedAt')
  const review:ReviewReceipt={id:decision.reviewId,revision:0,proposalId:proposal.id,sourceId:proposal.sourceId,acceptedAt:decision.acceptedAt}
  const commands:StoreCommand[]=proposal.commands.map(c=>{
    if(c.op==='remove')return c
    const row=c.value
    if(!('source' in row)||row.source.sourceId!==proposal.sourceId)reject('E_PROPOSAL_SOURCE','proposal.commands')
    const source:SourceRef={...row.source,evidenceIds:[...new Set([...row.source.evidenceIds,...proposal.evidenceIds])],reviewId:review.id}
    return {...c,value:{...row,source} as AnyStoreRow}
  })
  const next=applyStoreCommands(world,commands,proposal.baseRevision,{policy,acceptedReview:review})
  return freezeCopy({world:next,proposal:{...proposal,status:'accepted'}})
}
export function rejectStoreProposal(world:WorldStore,input:Proposal,policy:StorePolicy={}):Proposal{
  const proposal=readStoreProposal(input,world,policy)
  if(proposal.status!=='pending')reject('E_PROPOSAL_REPLAY','proposal.status')
  return freezeCopy({...proposal,status:'rejected'})
}
