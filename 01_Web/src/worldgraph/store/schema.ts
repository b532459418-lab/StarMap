import type { StorePolicy, StoreTable, WorldStore, StoreCommand } from './types.ts'
import { freezeCopy, opaqueId, plain, reject, revision, shape, validateJson, type ObjectValue } from './primitives.ts'
import { type RowLookup, validateRow, validateRowBase } from './rows.ts'
export { StoreError, freezeCopy, jsonKey, opaqueId, reject, revision, shape, utcTimestamp, validateJson, validateStoredDates } from './primitives.ts'

export const STORE_TABLES: readonly StoreTable[] = Object.freeze([
  'sources', 'evidence', 'reviews', 'entityTypes', 'layers', 'entities', 'entries',
  'relationTypes', 'relations', 'anchors', 'assets', 'sequences', 'viewStates',
])

/** Index every table, then run the shared row rules (rows.ts) in table order.
 * Store-wide uniqueness is checked right after each row, as before the split, so
 * the first reported error is unchanged. */
export function validateWorldStore(value: unknown, policy: StorePolicy = {}): asserts value is WorldStore {
  validateJson(value)
  shape(value,['format','formatVersion','revision',...STORE_TABLES])
  if (value.format !== 'starmap.world-store' || value.formatVersion !== 1) reject('E_VERSION','$')
  revision(value.revision,'$.revision')
  const indices = new Map<StoreTable,Map<unknown,ObjectValue>>()
  for (const table of STORE_TABLES) {
    const rows=value[table]; if (!Array.isArray(rows)) reject('E_SHAPE',table)
    const index=new Map<unknown,ObjectValue>()
    for (const row of rows) {
      validateRowBase(table,row)
      if (index.has(row.id)) reject('E_DUPLICATE',table)
      index.set(row.id,row)
    }
    indices.set(table,index)
  }
  const lookup:RowLookup={get:(table,id)=>indices.get(table)!.get(id)}
  const proposalIds=new Set<unknown>(),systemKeys=new Set<unknown>(),identities=new Set<string>()
  for (const table of STORE_TABLES) for (const r of [...indices.get(table)!.values()]) {
    validateRow(table,r,lookup,policy)
    if (table==='reviews') {
      if (proposalIds.has(r.proposalId)) reject('E_DUPLICATE','reviews.proposalId'); proposalIds.add(r.proposalId)
    } else if (table==='layers' && r.systemKey!==undefined) {
      if (systemKeys.has(r.systemKey)) reject('E_DUPLICATE','layers.systemKey'); systemKeys.add(r.systemKey)
    } else if (table==='entries') {
      const s=r.source as ObjectValue
      const key=JSON.stringify([r.entityId,r.layerId,s.sourceId,s.recordId])
      if (identities.has(key)) reject('E_SOURCE_COLLISION','entries.source'); identities.add(key)
    }
  }
}

export function validateCommands(value: unknown): asserts value is readonly StoreCommand[] {
  validateJson(value)
  if (!Array.isArray(value) || !value.length) reject('E_COMMAND','$')
  for (const c of value) {
    if (!plain(c) || !STORE_TABLES.includes(c.table as StoreTable)) reject('E_COMMAND','$')
    if (c.op==='create') { shape(c,['op','table','value']); if (!plain(c.value)) reject('E_SHAPE','command.value') }
    else if (c.op==='update') {
      shape(c,['op','table','id','expectedRevision','value']); opaqueId(c.id,'command.id'); revision(c.expectedRevision,'command.expectedRevision')
      if (!plain(c.value)) reject('E_SHAPE','command.value')
    } else if (c.op==='remove') { shape(c,['op','table','id','expectedRevision']); opaqueId(c.id,'command.id'); revision(c.expectedRevision,'command.expectedRevision') }
    else reject('E_COMMAND','$')
  }
}
export function readWorldStore(value: unknown, policy: StorePolicy = {}): WorldStore {
  validateWorldStore(value,policy); return freezeCopy(value)
}
export const emptyWorldStore = (): WorldStore => freezeCopy({
  format:'starmap.world-store',formatVersion:1,revision:0,
  sources:[],evidence:[],reviews:[],entityTypes:[],layers:[],entities:[],entries:[],
  relationTypes:[],relations:[],anchors:[],assets:[],sequences:[],viewStates:[],
})
