/** Formal store (3C-1a): the row shapes the incremental planner writes.
 * Fact and definition rows keep the G1 shapes; field definitions may be
 * deprecated, and view state is one row per item or setting instead of the
 * G1 viewStates arrays. FormalState is an in-memory, JSON-serializable state
 * for tests and the reference executor (applyChangeSet), not a file format.
 */
import type {
  AssetReference, EntityTypeDefinition, EntrySequence, Evidence, FieldDefinition, JsonValue, LayerDefinition, LayerEntry,
  RelationTypeDefinition, ReviewReceipt, SourceDefinition, StoreAnchor, StoreEntity, StorePolicy, StoreRelation, StoreRow, StoreTable,
} from './types.ts'
import { type ObjectValue, freezeCopy, opaqueId, reject, revision, shape, utcTimestamp, validateJson } from './primitives.ts'
import { type RowLookup, validateRow, validateRowBase } from './rows.ts'

export type FormalTable = Exclude<StoreTable,'viewStates'> | 'viewItems' | 'viewSettings'
export const FORMAL_TABLES: readonly FormalTable[] = Object.freeze([
  'sources', 'evidence', 'reviews', 'entityTypes', 'layers', 'entities', 'entries',
  'relationTypes', 'relations', 'anchors', 'assets', 'sequences', 'viewItems', 'viewSettings',
])
/** A deprecated field keeps its stored values and stays readable; it accepts no new value. */
export interface FormalFieldDefinition extends FieldDefinition { readonly deprecated?: true }
export interface FormalEntityType extends Omit<EntityTypeDefinition,'fields'> { readonly fields: readonly FormalFieldDefinition[] }
export interface FormalLayer extends Omit<LayerDefinition,'entryFields'> { readonly entryFields: readonly FormalFieldDefinition[] }
export interface FormalRelationType extends Omit<RelationTypeDefinition,'fields'> { readonly fields: readonly FormalFieldDefinition[] }
export type ViewItemTable = 'entries' | 'entities' | 'assets'
/** One ordered/hidden item of an opaque view scope; (scope, itemTable, itemId) is unique. */
export interface ViewItem extends StoreRow {
  readonly scope: string
  readonly itemTable: ViewItemTable
  readonly itemId: string
  /** For an entry, the entry must belong to this layer. */
  readonly layerId?: string
  readonly position: string
  readonly hidden: boolean
}
/** One setting of an opaque view scope, such as a cover; (scope, key) is unique. */
export interface ViewSetting extends StoreRow {
  readonly scope: string
  readonly key: string
  readonly value?: JsonValue
  readonly ref?: { readonly table: ViewItemTable; readonly id: string }
}
export interface FormalTables {
  readonly sources: readonly SourceDefinition[]
  readonly evidence: readonly Evidence[]
  readonly reviews: readonly ReviewReceipt[]
  readonly entityTypes: readonly FormalEntityType[]
  readonly layers: readonly FormalLayer[]
  readonly entities: readonly StoreEntity[]
  readonly entries: readonly LayerEntry[]
  readonly relationTypes: readonly FormalRelationType[]
  readonly relations: readonly StoreRelation[]
  readonly anchors: readonly StoreAnchor[]
  readonly assets: readonly AssetReference[]
  readonly sequences: readonly EntrySequence[]
  readonly viewItems: readonly ViewItem[]
  readonly viewSettings: readonly ViewSetting[]
}
export type FormalRow = FormalTables[FormalTable][number]
/** A deleted id stays reserved forever: the same (table, id) can never be created again. */
export interface Tombstone { readonly table: FormalTable; readonly id: string; readonly deletedAt: string }
export interface FormalState extends FormalTables {
  readonly revision: number
  readonly tombstones: readonly Tombstone[]
}
export type FormalCommand =
  | { readonly op: 'create'; readonly table: FormalTable; readonly value: FormalRow }
  | { readonly op: 'update'; readonly table: FormalTable; readonly id: string; readonly expectedRevision: number; readonly value: FormalRow }
  | { readonly op: 'remove'; readonly table: FormalTable; readonly id: string; readonly expectedRevision: number }

/** Store-wide unique keys, answered by StoreReader.find* rather than by scanning. */
export type UniqueKind = 'entry' | 'systemKey' | 'proposal' | 'viewItem' | 'viewSetting'
export interface UniqueClaim { readonly kind: UniqueKind; readonly parts: readonly string[] }
export const UNIQUE_ERRORS: Readonly<Record<UniqueKind,readonly [code:string,path:string]>> = Object.freeze({
  entry: ['E_SOURCE_COLLISION','entries.source'],
  systemKey: ['E_DUPLICATE','layers.systemKey'],
  proposal: ['E_DUPLICATE','reviews.proposalId'],
  viewItem: ['E_DUPLICATE','viewItems.itemId'],
  viewSetting: ['E_DUPLICATE','viewSettings.key'],
})
export const claimKey = (claim: UniqueClaim): string => JSON.stringify([claim.kind,...claim.parts])
/** The unique keys a validated row occupies. */
export function uniqueClaims(table: FormalTable, row: FormalRow): readonly UniqueClaim[] {
  if (table==='entries') { const e=row as LayerEntry; return [{kind:'entry',parts:[e.entityId,e.layerId,e.source.sourceId,e.source.recordId]}] }
  if (table==='layers') { const l=row as FormalLayer; return l.systemKey===undefined?[]:[{kind:'systemKey',parts:[l.systemKey]}] }
  if (table==='reviews') return [{kind:'proposal',parts:[(row as ReviewReceipt).proposalId]}]
  if (table==='viewItems') { const v=row as ViewItem; return [{kind:'viewItem',parts:[v.scope,v.itemTable,v.itemId]}] }
  if (table==='viewSettings') { const v=row as ViewSetting; return [{kind:'viewSetting',parts:[v.scope,v.key]}] }
  return []
}

export const emptyFormalState = (): FormalState => freezeCopy({
  revision:0,tombstones:[],
  sources:[],evidence:[],reviews:[],entityTypes:[],layers:[],entities:[],entries:[],
  relationTypes:[],relations:[],anchors:[],assets:[],sequences:[],viewItems:[],viewSettings:[],
})

/** Whole-state validation with the shared row rules (formal dialect), for restoring
 * a serialized state. The planner never calls this: it validates touched rows only. */
export function readFormalState(value: unknown, policy: StorePolicy = {}): FormalState {
  validateJson(value)
  shape(value,['revision','tombstones',...FORMAL_TABLES])
  revision(value.revision,'$.revision')
  const indices=new Map<FormalTable,Map<unknown,ObjectValue>>()
  for (const table of FORMAL_TABLES) {
    const rows=value[table]; if (!Array.isArray(rows)) reject('E_SHAPE',table)
    const index=new Map<unknown,ObjectValue>()
    for (const row of rows) {
      validateRowBase(table,row)
      if (index.has(row.id)) reject('E_DUPLICATE',table)
      index.set(row.id,row)
    }
    indices.set(table,index)
  }
  const lookup:RowLookup={get:(table,id)=>indices.get(table as FormalTable)?.get(id)}
  const claimed=new Set<string>()
  for (const table of FORMAL_TABLES) for (const row of indices.get(table)!.values()) {
    validateRow(table,row,lookup,policy,'formal')
    for (const claim of uniqueClaims(table,row as unknown as FormalRow)) {
      const key=claimKey(claim)
      if (claimed.has(key)) reject(...UNIQUE_ERRORS[claim.kind]); claimed.add(key)
    }
  }
  if (!Array.isArray(value.tombstones)) reject('E_SHAPE','tombstones')
  const buried=new Set<string>()
  for (const t of value.tombstones) {
    shape(t,['table','id','deletedAt'],['table','id','deletedAt'],'tombstones')
    if (!FORMAL_TABLES.includes(t.table as FormalTable) || t.table==='reviews') reject('E_TOMBSTONE','tombstones.table')
    opaqueId(t.id,'tombstones.id'); utcTimestamp(t.deletedAt,'tombstones.deletedAt')
    const key=JSON.stringify([t.table,t.id])
    if (buried.has(key)) reject('E_DUPLICATE','tombstones'); buried.add(key)
    if (indices.get(t.table as FormalTable)!.has(t.id)) reject('E_TOMBSTONE','tombstones.id')
  }
  return freezeCopy(value as unknown as FormalState)
}
