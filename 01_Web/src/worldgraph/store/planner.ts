/** Incremental planner for the formal store (3C-1a): the formal write path.
 * planCommands reads only the rows a batch touches or references (through a
 * StoreReader) and returns a change set a host can execute without knowing
 * domain rules. applyStoreCommands (commands.ts) stays the G1 reference for the
 * shared semantics; the differences are listed in the store README.
 */
import type { ReviewReceipt, SourceDefinition, StorePolicy } from './types.ts'
import {
  FORMAL_TABLES, type FormalCommand, type FormalEntityType, type FormalFieldDefinition, type FormalLayer, type FormalRelationType,
  type FormalRow, type FormalState, type FormalTable, type Tombstone, UNIQUE_ERRORS, type UniqueClaim, type ViewItemTable, claimKey, uniqueClaims,
} from './formal.ts'
import { type Ref, type StoreReader, refKey, referencesOf, rowKey } from './reader.ts'
import { validateRow } from './rows.ts'
import { DEFINITION_TABLES, checkDefinitionChange } from './evolution.ts'
import { type ObjectValue, freezeCopy, jsonKey, opaqueId, plain, reject, revision, shape, utcTimestamp, validateJson } from './primitives.ts'
import { validateCommands } from './schema.ts'

export interface PlanContext {
  /** Store revision the client read. Any other current revision is E_STALE. */
  readonly baseRevision: number
  /** Injected UTC time for tombstones; Core reads no clock. */
  readonly now: string
  readonly policy?: StorePolicy
  /** Host review boundary only, as in G1: commands can never create receipts. */
  readonly acceptedReview?: ReviewReceipt
}
export interface TableCounts { readonly created: number; readonly updated: number; readonly removed: number }
/** Everything a host writes for one batch. Deletes before upserts with foreign keys
 * checked at commit is a safe execution order; every row was validated by the planner. */
export interface ChangeSet {
  readonly baseRevision: number
  readonly nextRevision: number
  readonly upserts: readonly { readonly table: FormalTable; readonly row: FormalRow }[]
  /** Rows that existed before the batch and do not exist after it. */
  readonly deletes: readonly { readonly table: FormalTable; readonly id: string }[]
  /** Every id deleted by the batch, including rows created and deleted within it. */
  readonly tombstones: readonly Tombstone[]
  readonly refsAdded: readonly Ref[]
  readonly refsRemoved: readonly Ref[]
  readonly summary: { readonly counts: Readonly<Record<FormalTable,TableCounts>> }
}

const VIEW_TABLES: readonly FormalTable[] = ['viewItems','viewSettings']
const sourceIdentity = (r: ObjectValue): string | undefined =>
  plain(r.source) ? JSON.stringify([r.source.sourceId,r.source.recordId]) : undefined
const tableOrder = (table: FormalTable) => FORMAL_TABLES.indexOf(table)

/** The batch's pending writes layered over `reader`, so later commands see earlier
 * ones. Base reads are cached: the reader's state cannot change while planning. */
function batchView(reader: StoreReader, now: string) {
  const cache = new Map<string,FormalRow | undefined>()
  const writes = new Map<string,{readonly table:FormalTable;readonly id:string;readonly existed:boolean;row:FormalRow | null}>()
  const claims = new Map<string,string | null>()
  const added = new Map<string,Ref>(), removed = new Map<string,Ref>()
  const get = (table: FormalTable, id: string): FormalRow | undefined => {
    const key = rowKey(table,id), write = writes.get(key)
    if (write) return write.row ?? undefined
    if (!cache.has(key)) cache.set(key,reader.get(table,id))
    return cache.get(key)
  }
  const find = (claim: UniqueClaim): string | undefined => {
    const key = claimKey(claim)
    if (claims.has(key)) return claims.get(key) ?? undefined
    const [a,b,c,d] = claim.parts
    switch (claim.kind) {
      case 'entry': return reader.findEntryByIdentity(a,b,c,d)
      case 'systemKey': return reader.findLayerBySystemKey(a)
      case 'proposal': return reader.findReviewByProposal(a)
      case 'viewItem': return reader.findViewItem(a,b as ViewItemTable,c)
      case 'viewSetting': return reader.findViewSetting(a,b)
    }
  }
  const view = {
    get,
    find,
    isTombstoned: (table: FormalTable, id: string) => writes.get(rowKey(table,id))?.row === null || reader.isTombstoned(table,id),
    dependents: (table: FormalTable, id: string): Ref[] => [
      ...reader.dependents(table,id).filter(ref => !removed.has(refKey(ref))),
      ...[...added.values()].filter(ref => ref.toTable === table && ref.toId === id),
    ],
    /** Write `row`, or delete with null. Keeps references and unique keys current. */
    put(table: FormalTable, id: string, row: FormalRow | null) {
      const key = rowKey(table,id), before = get(table,id)
      let write = writes.get(key)
      if (!write) { write = {table,id,existed:before !== undefined,row:null}; writes.set(key,write) }
      if (before) {
        for (const ref of referencesOf(table,before,view)) { const k = refKey(ref); if (added.has(k)) added.delete(k); else removed.set(k,ref) }
        for (const claim of uniqueClaims(table,before)) claims.set(claimKey(claim),null)
      }
      if (row) {
        for (const ref of referencesOf(table,row,view)) { const k = refKey(ref); if (removed.has(k)) removed.delete(k); else added.set(k,ref) }
        for (const claim of uniqueClaims(table,row)) claims.set(claimKey(claim),id)
      }
      write.row = row
    },
    changeSet(baseRevision: number): ChangeSet {
      const counts = Object.fromEntries(FORMAL_TABLES.map(t => [t,{created:0,updated:0,removed:0}])) as Record<FormalTable,{created:number;updated:number;removed:number}>
      const upserts: {table:FormalTable;row:FormalRow}[] = [], deletes: {table:FormalTable;id:string}[] = [], tombstones: Tombstone[] = []
      for (const w of writes.values()) {
        if (w.row) { upserts.push({table:w.table,row:w.row}); counts[w.table][w.existed ? 'updated' : 'created']++; continue }
        tombstones.push({table:w.table,id:w.id,deletedAt:now})
        if (w.existed) { deletes.push({table:w.table,id:w.id}); counts[w.table].removed++ }
      }
      const changed = writes.size > 0
      return freezeCopy({
        baseRevision, nextRevision: changed ? baseRevision + 1 : baseRevision,
        upserts, deletes, tombstones, refsAdded: [...added.values()], refsRemoved: [...removed.values()], summary: {counts},
      })
    },
  }
  return view
}

/** Plan one batch against `reader`. Commands run in order and later commands see
 * earlier ones; any failure rejects the whole batch with no partial result. Every
 * written row passes the shared row rules (rows.ts, formal dialect) against the
 * batch view, and store-wide uniqueness is asked of the reader, never scanned. */
export function planCommands(reader: StoreReader, commands: readonly FormalCommand[], ctx: PlanContext): ChangeSet {
  validateCommands(commands as unknown,FORMAL_TABLES)
  revision(ctx.baseRevision,'command.baseRevision'); utcTimestamp(ctx.now,'ctx.now')
  if (ctx.policy !== undefined) validateJson(ctx.policy,'ctx.policy')
  if (ctx.acceptedReview !== undefined) validateJson(ctx.acceptedReview,'ctx.acceptedReview')
  if (reader.revision !== ctx.baseRevision) reject('E_STALE','command.baseRevision')
  const policy = ctx.policy ?? {}, receipt = ctx.acceptedReview
  const view = batchView(reader,ctx.now)
  const check = (table: FormalTable, row: unknown) => validateRow(table,row,view,policy,'formal')
  const claimsFree = (table: FormalTable, id: string, row: FormalRow) => {
    for (const claim of uniqueClaims(table,row)) {
      const owner = view.find(claim)
      if (owner !== undefined && owner !== id) reject(...UNIQUE_ERRORS[claim.kind])
    }
  }
  const fieldDefinitions = (table: FormalTable, row: ObjectValue): readonly FormalFieldDefinition[] => {
    if (table === 'entities') return (view.get('entityTypes',row.typeId as string) as FormalEntityType).fields
    if (table === 'entries') return (view.get('layers',row.layerId as string) as FormalLayer).entryFields
    if (table === 'relations') return (view.get('relationTypes',row.typeId as string) as FormalRelationType).fields
    return []
  }
  /** A deprecated field may keep its stored value but never takes a different one. */
  const deprecatedUnchanged = (table: FormalTable, before: ObjectValue | undefined, after: ObjectValue) => {
    const next = after.fields as ObjectValue, prior = before?.fields as ObjectValue | undefined
    for (const field of fieldDefinitions(table,after)) {
      if (!field.deprecated || !Object.hasOwn(next,field.key)) continue
      const old = prior && Object.hasOwn(prior,field.key) ? jsonKey(prior[field.key]) : undefined
      if (old !== jsonKey(next[field.key])) reject('E_FIELD_DEPRECATED',`${table}.fields`)
    }
  }

  if (receipt) {
    const replay = receipt.revision !== 0
      || typeof receipt.id === 'string' && view.get('reviews',receipt.id) !== undefined
      || typeof receipt.proposalId === 'string' && view.find({kind:'proposal',parts:[receipt.proposalId]}) !== undefined
    if (replay) reject('E_REVIEW_REPLAY','reviews')
    check('reviews',receipt)
    view.put('reviews',receipt.id,receipt)
  }
  for (const c of commands) {
    const table = c.table
    if (table === 'reviews') reject('E_REVIEW_COMMAND','reviews')
    if (c.op === 'create') {
      const row = c.value as unknown as ObjectValue
      opaqueId(row.id,table+'.id')
      const id = row.id
      if (view.isTombstoned(table,id)) reject('E_RECREATE_ID',table)
      const existing = view.get(table,id)
      if (existing) { if (jsonKey(existing) !== jsonKey(row)) reject('E_CONFLICT',table); continue }
      const input = plain(row.source) ? row.source : undefined
      if (input && typeof input.sourceId === 'string' && (view.get('sources',input.sourceId) as SourceDefinition | undefined)?.origin === 'ai'
        && (!receipt || input.reviewId !== receipt.id || input.sourceId !== receipt.sourceId)) reject('E_UNCONFIRMED','command.create')
      if (row.revision !== 0) reject('E_REVISION',table)
      check(table,row)
      deprecatedUnchanged(table,undefined,row)
      claimsFree(table,id,c.value)
      view.put(table,id,c.value)
      continue
    }
    const before = view.get(table,c.id) as unknown as ObjectValue | undefined
    if (!before) reject('E_NOT_FOUND',table)
    if (before.revision !== c.expectedRevision) reject('E_STALE',table)
    if (c.op === 'remove') {
      const blocking: Ref[] = [], cascade: Ref[] = []
      for (const ref of view.dependents(table,c.id)) {
        if (ref.fromTable === table && ref.fromId === c.id) continue
        if (VIEW_TABLES.includes(ref.fromTable)) cascade.push(ref); else blocking.push(ref)
      }
      if (blocking.length) {
        const first = blocking.sort((x,y) => tableOrder(x.fromTable) - tableOrder(y.fromTable) || (x.fromId < y.fromId ? -1 : x.fromId > y.fromId ? 1 : 0))[0]
        reject('E_DEPENDENTS',`${first.fromTable}.${first.field}`)
      }
      // View state is not fact: a view row follows the row it points at.
      for (const ref of cascade) if (view.get(ref.fromTable,ref.fromId)) view.put(ref.fromTable,ref.fromId,null)
      view.put(table,c.id,null)
      continue
    }
    if (table === 'evidence') reject('E_SCHEMA_CHANGE',table)
    const row = c.value as unknown as ObjectValue
    if (row.id !== c.id || row.revision !== (before.revision as number) + 1) reject('E_REVISION',table)
    if (sourceIdentity(before) !== sourceIdentity(row)) reject('E_SOURCE_IDENTITY',table)
    if (table === 'entities' && 'typeId' in before && (!('typeId' in row) || row.typeId !== before.typeId)) reject('E_IDENTITY',table)
    if (table === 'entries' && 'createdAt' in before && 'createdAt' in row) {
      if (row.layerId !== before.layerId || row.entityId !== before.entityId || row.createdAt !== before.createdAt) reject('E_IDENTITY',table)
      if (Date.parse(row.updatedAt as string) < Date.parse(before.updatedAt as string)) reject('E_TIME',table)
    }
    check(table,row)
    if (DEFINITION_TABLES.includes(table)) checkDefinitionChange(table,before,row)
    deprecatedUnchanged(table,before,row)
    claimsFree(table,c.id,c.value)
    view.put(table,c.id,c.value)
  }
  return view.changeSet(ctx.baseRevision)
}

/** Reference executor: what a host does with a change set, as a pure function.
 * Rows are trusted (the planner validated them); only the revision is checked. */
export function applyChangeSet(state: FormalState, changeSet: ChangeSet): FormalState {
  validateJson(changeSet,'changeSet')
  shape(changeSet,['baseRevision','nextRevision','upserts','deletes','tombstones','refsAdded','refsRemoved','summary'],undefined,'changeSet')
  if (changeSet.baseRevision !== state.revision) reject('E_STALE','changeSet.baseRevision')
  if (changeSet.nextRevision !== state.revision && changeSet.nextRevision !== state.revision + 1) reject('E_REVISION','changeSet.nextRevision')
  const tables = Object.fromEntries(FORMAL_TABLES.map(t => [t,[...state[t]]])) as unknown as Record<FormalTable,FormalRow[]>
  const rowsOf = (table: FormalTable) => Object.hasOwn(tables,table) ? tables[table] : reject('E_SHAPE','changeSet')
  for (const {table,id} of changeSet.deletes) {
    const rows = rowsOf(table), at = rows.findIndex(r => r.id === id)
    if (at < 0) reject('E_NOT_FOUND',table)
    rows.splice(at,1)
  }
  for (const {table,row} of changeSet.upserts) {
    const rows = rowsOf(table), at = rows.findIndex(r => r.id === row.id)
    if (at < 0) rows.push(row); else rows[at] = row
  }
  return freezeCopy({...tables,revision:changeSet.nextRevision,tombstones:[...state.tombstones,...changeSet.tombstones]} as unknown as FormalState)
}
