import type { AnyStoreRow, StoreCommand, StorePolicy, StoreTable, WorldStore } from './types.ts'
import { STORE_TABLES, freezeCopy, jsonKey, reject, validateWorldStore } from './schema.ts'
import { applyStoreCommands } from './commands.ts'

export interface StoreConflict {
  readonly table: StoreTable
  readonly id: string
  readonly current: AnyStoreRow
  readonly incoming: AnyStoreRow
}
export type MergePlan =
  | {readonly status:'conflict';readonly conflicts:readonly StoreConflict[];readonly commands:readonly []}
  | {readonly status:'identical'|'ready';readonly conflicts:readonly [];readonly commands:readonly StoreCommand[];readonly baseRevision:number}

/** Preflight only. No input is changed and conflicts return NO partial write plan.
 * Importing nonzero history or new review receipts needs a later trusted import
 * policy; this API never resets history or fabricates confirmation implicitly.
 */
export function planStoreMerge(current: WorldStore, incoming: WorldStore, policy: StorePolicy = {}): MergePlan {
  validateWorldStore(current,policy);validateWorldStore(incoming,policy)
  const conflicts:StoreConflict[]=[],commands:StoreCommand[]=[]
  for(const table of STORE_TABLES){
    const existing=new Map<string,AnyStoreRow>(current[table].map(r=>[r.id,r]))
    for(const row of incoming[table]){
      const before=existing.get(row.id)
      if(!before)commands.push({op:'create',table,value:row})
      else if(jsonKey(before)!==jsonKey(row))conflicts.push({table,id:row.id,current:before,incoming:row})
    }
  }
  if(conflicts.length)return freezeCopy({status:'conflict',conflicts,commands:[]})
  if(commands.some(c=>c.op==='create'&&(c.value.revision!==0||c.table==='reviews')))reject('E_IMPORT_POLICY','merge')
  if(commands.length)applyStoreCommands(current,commands,current.revision,{policy})
  return freezeCopy({status:commands.length?'ready':'identical',conflicts:[],commands,baseRevision:current.revision})
}
