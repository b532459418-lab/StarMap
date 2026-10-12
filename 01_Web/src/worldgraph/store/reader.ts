/** Read access the planner needs: single rows, reverse references, tombstones and
 * unique-key lookups. No method returns a whole table, so a SQLite reader (3C-2)
 * can implement the same interface with indexed queries.
 */
import type { EntrySequence, Evidence, LayerEntry, ReviewReceipt, SourceRef, StoreAnchor, StoreEntity, StoreRelation } from './types.ts'
import {
  FORMAL_TABLES, type FormalEntityType, type FormalFieldDefinition, type FormalLayer, type FormalRelationType, type FormalRow,
  type FormalState, type FormalTable, type ViewItem, type ViewItemTable, type ViewSetting, claimKey, uniqueClaims,
} from './formal.ts'

/** `fromTable/fromId` refers to `toTable/toId` through `field`, a path such as
 * `entityId`, `fields.director` or `source.evidenceIds`. */
export interface Ref {
  readonly fromTable: FormalTable
  readonly fromId: string
  readonly field: string
  readonly toTable: FormalTable
  readonly toId: string
}
export interface StoreReader {
  /** Store-wide revision; every committed change set raises it by one. */
  readonly revision: number
  get(table: FormalTable, id: string): FormalRow | undefined
  /** References pointing at this row (reverse index). */
  dependents(table: FormalTable, id: string): readonly Ref[]
  isTombstoned(table: FormalTable, id: string): boolean
  findEntryByIdentity(entityId: string, layerId: string, sourceId: string, recordId: string): string | undefined
  findLayerBySystemKey(systemKey: string): string | undefined
  findReviewByProposal(proposalId: string): string | undefined
  findViewItem(scope: string, itemTable: ViewItemTable, itemId: string): string | undefined
  findViewSetting(scope: string, key: string): string | undefined
}
export const refKey = (ref: Ref): string => JSON.stringify([ref.fromTable,ref.fromId,ref.field,ref.toTable,ref.toId])
export const rowKey = (table: FormalTable, id: string): string => JSON.stringify([table,id])

/** Every reference a valid row holds. Which field values are references follows
 * the CURRENT definition; compatible definition changes never alter the kind of
 * an existing key, so stored references stay correct when definitions evolve. */
export function referencesOf(table: FormalTable, row: FormalRow, reader: Pick<StoreReader,'get'>): readonly Ref[] {
  const refs: Ref[] = []
  const add = (field: string, toTable: FormalTable, toId: unknown) => {
    if (typeof toId === 'string') refs.push({fromTable:table,fromId:row.id,field,toTable,toId})
  }
  const source = (s: SourceRef) => {
    add('source.sourceId','sources',s.sourceId)
    for (const id of s.evidenceIds) add('source.evidenceIds','evidence',id)
    if (s.reviewId !== undefined) add('source.reviewId','reviews',s.reviewId)
  }
  const fields = (values: Readonly<Record<string,unknown>>, definitions: readonly FormalFieldDefinition[] | undefined) => {
    for (const f of definitions ?? []) {
      if (!Object.hasOwn(values,f.key)) continue
      if (f.kind === 'entity_ref') add('fields.'+f.key,'entities',values[f.key])
      else if (f.kind === 'asset_ref') add('fields.'+f.key,'assets',values[f.key])
    }
  }
  switch (table) {
    case 'evidence': add('sourceId','sources',(row as Evidence).sourceId); break
    case 'reviews': add('sourceId','sources',(row as ReviewReceipt).sourceId); break
    case 'layers': for (const id of (row as FormalLayer).acceptedEntityTypes) add('acceptedEntityTypes','entityTypes',id); break
    case 'relationTypes': {
      const r = row as FormalRelationType
      for (const id of r.fromTypes) add('fromTypes','entityTypes',id)
      for (const id of r.toTypes) add('toTypes','entityTypes',id)
      break
    }
    case 'entities': {
      const r = row as StoreEntity
      add('typeId','entityTypes',r.typeId)
      fields(r.fields,(reader.get('entityTypes',r.typeId) as FormalEntityType | undefined)?.fields); source(r.source)
      break
    }
    case 'entries': {
      const r = row as LayerEntry
      add('layerId','layers',r.layerId); add('entityId','entities',r.entityId)
      fields(r.fields,(reader.get('layers',r.layerId) as FormalLayer | undefined)?.entryFields); source(r.source)
      break
    }
    case 'relations': {
      const r = row as StoreRelation
      add('typeId','relationTypes',r.typeId); add('fromEntityId','entities',r.fromEntityId); add('toEntityId','entities',r.toEntityId)
      fields(r.fields,(reader.get('relationTypes',r.typeId) as FormalRelationType | undefined)?.fields); source(r.source)
      break
    }
    case 'anchors': { const r = row as StoreAnchor; add('entityId','entities',r.entityId); source(r.source); break }
    case 'assets': source((row as { readonly source: SourceRef }).source); break
    case 'sequences': {
      const r = row as EntrySequence
      add('entityId','entities',r.entityId)
      for (const id of r.entryIds) add('entryIds','entries',id)
      source(r.source)
      break
    }
    case 'viewItems': {
      const r = row as ViewItem
      add('itemId',r.itemTable,r.itemId)
      if (r.layerId !== undefined) add('layerId','layers',r.layerId)
      break
    }
    case 'viewSettings': { const r = row as ViewSetting; if (r.ref) add('ref',r.ref.table,r.ref.id); break }
  }
  return refs
}

/** In-memory reader with forward and reverse indices over a valid FormalState
 * (from readFormalState, emptyFormalState or applyChangeSet). */
export function memoryReader(state: FormalState): StoreReader {
  const rows = new Map<FormalTable,Map<string,FormalRow>>()
  for (const table of FORMAL_TABLES) rows.set(table,new Map(state[table].map(r => [r.id,r] as const)))
  const get = (table: FormalTable, id: string) => rows.get(table)?.get(id)
  const dependents = new Map<string,Ref[]>()
  const unique = new Map<string,string>()
  for (const table of FORMAL_TABLES) for (const row of state[table]) {
    for (const ref of referencesOf(table,row,{get})) {
      const key = rowKey(ref.toTable,ref.toId)
      const list = dependents.get(key)
      if (list) list.push(ref); else dependents.set(key,[ref])
    }
    for (const claim of uniqueClaims(table,row)) unique.set(claimKey(claim),row.id)
  }
  for (const list of dependents.values()) Object.freeze(list)
  const tombstones = new Set(state.tombstones.map(t => rowKey(t.table,t.id)))
  const none: readonly Ref[] = Object.freeze([])
  return Object.freeze({
    revision: state.revision,
    get,
    dependents: (table: FormalTable, id: string) => dependents.get(rowKey(table,id)) ?? none,
    isTombstoned: (table: FormalTable, id: string) => tombstones.has(rowKey(table,id)),
    findEntryByIdentity: (entityId: string, layerId: string, sourceId: string, recordId: string) =>
      unique.get(claimKey({kind:'entry',parts:[entityId,layerId,sourceId,recordId]})),
    findLayerBySystemKey: (systemKey: string) => unique.get(claimKey({kind:'systemKey',parts:[systemKey]})),
    findReviewByProposal: (proposalId: string) => unique.get(claimKey({kind:'proposal',parts:[proposalId]})),
    findViewItem: (scope: string, itemTable: ViewItemTable, itemId: string) => unique.get(claimKey({kind:'viewItem',parts:[scope,itemTable,itemId]})),
    findViewSetting: (scope: string, key: string) => unique.get(claimKey({kind:'viewSetting',parts:[scope,key]})),
  })
}
