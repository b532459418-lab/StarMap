import type { AnyStoreRow, ReviewReceipt, StoreCommand, StorePolicy, SourceRef, WorldStore } from './types.ts'
import { freezeCopy, jsonKey, readWorldStore, reject, revision, validateCommands, validateWorldStore } from './schema.ts'

interface CommandContext {
  readonly policy?: StorePolicy
  /** Host review boundary only; persisted Proposal commands cannot create receipts. */
  readonly acceptedReview?: ReviewReceipt
}
const immutableDefinitions = new Set(['sources','evidence','reviews','entityTypes','layers','relationTypes'])
const sourceIdentity = (r: AnyStoreRow): string | undefined => {
  if (!('source' in r)) return undefined
  return JSON.stringify([r.source.sourceId,r.source.recordId])
}
/** No IO or durable transaction claim. All validation precedes returning a new world. */
export function applyStoreCommands(
  world: WorldStore, commands: readonly StoreCommand[], expectedRevision: number, context: CommandContext = {},
): WorldStore {
  const policy=context.policy??{}
  validateWorldStore(world,policy); validateCommands(commands); revision(expectedRevision,'command.worldRevision')
  if (world.revision!==expectedRevision) reject('E_STALE','command.worldRevision')
  const next=structuredClone(world)
  const mutable=next as unknown as Record<string,AnyStoreRow[]>
  let changed=false
  const removed=new Set<string>()
  if (context.acceptedReview) {
    const receipt=context.acceptedReview
    if (receipt.revision!==0 || next.reviews.some(r=>r.id===receipt.id || r.proposalId===receipt.proposalId)) reject('E_REVIEW_REPLAY','reviews')
    mutable.reviews.push(structuredClone(receipt)); changed=true
  }
  for (const c of commands) {
    if (c.table==='reviews') reject('E_REVIEW_COMMAND','reviews')
    const rows=mutable[c.table]
    if (c.op==='create') {
      const inputSource = 'source' in c.value ? c.value.source : undefined
      if (inputSource && world.sources.some(source => source.id === inputSource.sourceId && source.origin === 'ai')
        && (!context.acceptedReview || inputSource.reviewId !== context.acceptedReview.id || inputSource.sourceId !== context.acceptedReview.sourceId)) reject('E_UNCONFIRMED','command.create')
      if(removed.has(JSON.stringify([c.table,c.value.id])))reject('E_RECREATE_ID',c.table)
      const before=rows.find(r=>r.id===c.value.id)
      if (before) { if(jsonKey(before)!==jsonKey(c.value))reject('E_CONFLICT',c.table); continue }
      if(c.value.revision!==0)reject('E_REVISION',c.table)
      rows.push(structuredClone(c.value)); changed=true
    } else {
      const index=rows.findIndex(r=>r.id===c.id)
      if(index<0)reject('E_NOT_FOUND',c.table)
      const before=rows[index]
      if(before.revision!==c.expectedRevision)reject('E_STALE',c.table)
      if(c.op==='remove'){removed.add(JSON.stringify([c.table,c.id]));rows.splice(index,1);changed=true;continue}
      if(immutableDefinitions.has(c.table))reject('E_SCHEMA_CHANGE',c.table)
      if(c.value.id!==c.id || c.value.revision!==before.revision+1)reject('E_REVISION',c.table)
      if(sourceIdentity(before)!==sourceIdentity(c.value))reject('E_SOURCE_IDENTITY',c.table)
      if(c.table==='entities' && 'typeId' in before && (!('typeId' in c.value)||c.value.typeId!==before.typeId))reject('E_IDENTITY',c.table)
      if(c.table==='entries' && 'createdAt' in before && 'createdAt' in c.value){
        if(c.value.layerId!==before.layerId || c.value.entityId!==before.entityId || c.value.createdAt!==before.createdAt)reject('E_IDENTITY',c.table)
        if(Date.parse(c.value.updatedAt)<Date.parse(before.updatedAt))reject('E_TIME',c.table)
      }
      rows[index]=structuredClone(c.value);changed=true
    }
  }
  const result={...next,revision:changed?world.revision+1:world.revision}
  return readWorldStore(result,policy)
}
/** Same raw record ID from two sources remains distinct; delimiter-safe and opaque. */
export const sourceRecordKey = (source: Pick<SourceRef,'sourceId'|'recordId'>): string =>
  JSON.stringify([source.sourceId,source.recordId])
export const entryIdentityKey = (entry: {readonly entityId:string;readonly layerId:string;readonly source:SourceRef}): string =>
  JSON.stringify([entry.entityId,entry.layerId,entry.source.sourceId,entry.source.recordId])
export const readonlyCommands = (commands: readonly StoreCommand[]): readonly StoreCommand[] => {
  validateCommands(commands);return freezeCopy(commands)
}
