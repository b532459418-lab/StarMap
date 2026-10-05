import { classifyRecordDate, type DateEvidence } from '../timeFilter.ts'
import type { LayerEntry, StoreEntity, StorePolicy, StoredDates, WorldStore } from './types.ts'
import { freezeCopy, reject, validateStoredDates, validateWorldStore } from './schema.ts'

export interface LayerRow { readonly entity: StoreEntity; readonly entry: LayerEntry }
/** Complete management rows, including view-hidden and coordinate-less records.
 * Visibility is data, not an access check: the host must authorize the world.
 */
export function queryStoreLayer(world: WorldStore, layerId: string, policy: StorePolicy = {}): readonly LayerRow[] {
  validateWorldStore(world,policy)
  if(!world.layers.some(l=>l.id===layerId))reject('E_NOT_FOUND','query.layerId')
  const entities=new Map(world.entities.map(e=>[e.id,e]))
  return freezeCopy(world.entries.filter(e=>e.layerId===layerId).map(entry=>({entry,entity:entities.get(entry.entityId)!})))
}
export function classifyStoredDates(date: StoredDates): DateEvidence {
  validateStoredDates(date)
  return freezeCopy(classifyRecordDate(date.raw))
}
/** Original adjacency ONLY; removing a middle entry never invents an A -> C pair. */
export function queryOriginalAdjacency(world: WorldStore, sequenceId: string, visibleEntryIds: readonly string[], policy: StorePolicy = {}): readonly {readonly from:LayerEntry;readonly to:LayerEntry}[] {
  validateWorldStore(world,policy)
  const sequence=world.sequences.find(s=>s.id===sequenceId)
  if(!sequence)reject('E_NOT_FOUND','query.sequenceId')
  const entries=new Map(world.entries.map(e=>[e.id,e])),visible=new Set(visibleEntryIds)
  const pairs:{from:LayerEntry;to:LayerEntry}[]=[]
  for(let i=1;i<sequence.entryIds.length;i++){
    const from=sequence.entryIds[i-1],to=sequence.entryIds[i]
    if(visible.has(from)&&visible.has(to))pairs.push({from:entries.get(from)!,to:entries.get(to)!})
  }
  return freezeCopy(pairs)
}
