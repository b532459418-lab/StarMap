/** A read model index that follows the commits (3C-5 C1, design 3C-5 §3): the host's write path plans on it and moves it
 * on with each commit's changed rows, without reading the store or rebuilding the index.
 *
 * - The lookups are those of `indexReadModel` (./lookup.ts), with the same orders: lists in id order (compareIds),
 *   a scope's view items by position, then id. Lists are built on first use and kept until a change touches them.
 * - `apply(changes)`: the changes a commit returns (the planner's change set: upserts and deletes) applied in place. The
 *   revision must be the change set's base revision (E_STALE). Cost: the changed rows, not the tables.
 * - `model`: the read model of the current revision, built from the last one with the pending change sets
 *   (applyReadModelDelta) when asked for, so a write never copies the tables.
 * - `referencesTo(table, id)`: the rows that refer to a row (Core's referencesOf, the reverse of the planner's own
 *   index), built on first use and kept up to date by `apply`.
 *
 * Rows are the model's own and must not be modified. Mutable on purpose: one owner (the host session) applies its
 * commits in order.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalRow, ViewItem, ViewSetting } from '../store/formal.ts'
import type { ChangeSet } from '../store/planner.ts'
import { reject } from '../store/primitives.ts'
import { referencesOf, type Ref } from '../store/reader.ts'
import type { LayerEntry, StoreAnchor, StoreEntity, StoreRelation } from '../store/types.ts'
import { applyReadModelDelta } from './delta.ts'
import type { ReadModelIndex } from './lookup.ts'
import { READ_MODEL_TABLES, compareIds, type ReadModel, type ReadModelRow, type ReadModelTable } from './types.ts'

/** What a commit returns (store-host commit()'s `changes`): the planner's change set without tombstones and references. */
export type ReadModelChanges = Pick<ChangeSet, 'baseRevision' | 'nextRevision' | 'upserts' | 'deletes'>

export interface LiveReadModelIndex extends ReadModelIndex {
  /** The revision of the rows the index holds. */
  readonly revision: number
  /** Move on with one commit's changes (see the file header). */
  apply(changes: ReadModelChanges): void
  /** Rows referring to `table`/`id` (Core's referencesOf), in no particular order. */
  referencesTo(table: ReadModelTable, id: string): readonly Ref[]
}

const NONE: readonly never[] = Object.freeze([])
const isReadModelTable = (table: string): table is ReadModelTable => (READ_MODEL_TABLES as readonly string[]).includes(table)
const byId = (a: { readonly id: string }, b: { readonly id: string }) => compareIds(a.id, b.id)
const byPosition = (a: ViewItem, b: ViewItem) => (a.position < b.position ? -1 : a.position > b.position ? 1 : compareIds(a.id, b.id))
const keyOf = (table: string, id: string) => `${table}\u0000${id}`

/** Rows grouped by one key, each group's sorted list built on first use. */
class Groups<T extends { readonly id: string }> {
  private readonly groups = new Map<string, Map<string, T>>()
  private readonly lists = new Map<string, readonly T[]>()
  private readonly keyOf: (row: T) => string
  private readonly order: (a: T, b: T) => number
  constructor(keyOf: (row: T) => string, order: (a: T, b: T) => number) {
    this.keyOf = keyOf
    this.order = order
  }
  add(row: T) {
    const key = this.keyOf(row)
    let group = this.groups.get(key)
    if (!group) this.groups.set(key, group = new Map())
    group.set(row.id, row)
    this.lists.delete(key)
  }
  remove(row: T) {
    const key = this.keyOf(row), group = this.groups.get(key)
    if (!group?.delete(row.id)) return
    if (group.size === 0) this.groups.delete(key)
    this.lists.delete(key)
  }
  list(key: string): readonly T[] {
    let list = this.lists.get(key)
    if (list) return list
    const group = this.groups.get(key)
    if (!group) return NONE
    list = Object.freeze([...group.values()].sort(this.order))
    this.lists.set(key, list)
    return list
  }
}

/** The live index of `model` (see the file header). */
export function liveReadModelIndex(model: ReadModel): LiveReadModelIndex {
  let base = model
  let pending: ReadModelChanges[] = []
  let revision = model.revision
  const rows = new Map<ReadModelTable, Map<string, ReadModelRow>>()
  for (const table of READ_MODEL_TABLES) rows.set(table, new Map((model[table] as readonly ReadModelRow[]).map((row) => [row.id, row] as const)))
  const byType = new Groups<StoreEntity>((entity) => entity.typeId, byId)
  const byLayer = new Groups<LayerEntry>((entry) => entry.layerId, byId)
  const byEntity = new Groups<LayerEntry>((entry) => entry.entityId, byId)
  const relationsTo = new Groups<StoreRelation>((relation) => relation.toEntityId, byId)
  const relationsFrom = new Groups<StoreRelation>((relation) => relation.fromEntityId, byId)
  const anchors = new Groups<StoreAnchor>((anchor) => anchor.entityId, byId)
  const items = new Groups<ViewItem>((item) => item.scope, byPosition)
  const settings = new Groups<ViewSetting>((setting) => setting.scope, byId)
  /** The groups a table's rows are in (typed by row, as each table's rows are). */
  type RowGroups = { add(row: ReadModelRow): void; remove(row: ReadModelRow): void }
  const as = (...groups: unknown[]) => groups as RowGroups[]
  const groupsOf = (table: ReadModelTable): RowGroups[] => {
    switch (table) {
      case 'entities': return as(byType)
      case 'entries': return as(byLayer, byEntity)
      case 'relations': return as(relationsTo, relationsFrom)
      case 'anchors': return as(anchors)
      case 'viewItems': return as(items)
      case 'viewSettings': return as(settings)
      default: return []
    }
  }
  for (const table of READ_MODEL_TABLES) for (const row of rows.get(table)!.values()) for (const groups of groupsOf(table)) groups.add(row)

  const get = <T extends ReadModelTable>(table: T, id: string) => rows.get(table)?.get(id) as ReadModelRow<T> | undefined
  const lookup = { get: (table: string, id: string) => (isReadModelTable(table) ? get(table, id) : undefined) as FormalRow | undefined }

  // Reverse references: target key → (source key → reference). Built on first use.
  let reverse: Map<string, Map<string, Ref>> | undefined
  const addRefs = (table: ReadModelTable, row: ReadModelRow) => {
    for (const ref of referencesOf(table, row as FormalRow, lookup)) {
      const target = keyOf(ref.toTable, ref.toId)
      let refs = reverse!.get(target)
      if (!refs) reverse!.set(target, refs = new Map())
      refs.set(`${keyOf(ref.fromTable, ref.fromId)}\u0000${ref.field}`, ref)
    }
  }
  const removeRefs = (table: ReadModelTable, row: ReadModelRow) => {
    for (const ref of referencesOf(table, row as FormalRow, lookup)) {
      const target = keyOf(ref.toTable, ref.toId), refs = reverse!.get(target)
      refs?.delete(`${keyOf(ref.fromTable, ref.fromId)}\u0000${ref.field}`)
      if (refs?.size === 0) reverse!.delete(target)
    }
  }
  const referencesTo = (table: ReadModelTable, id: string): readonly Ref[] => {
    if (!reverse) {
      reverse = new Map()
      for (const name of READ_MODEL_TABLES) for (const row of rows.get(name)!.values()) addRefs(name, row)
    }
    const refs = reverse.get(keyOf(table, id))
    return refs ? Object.freeze([...refs.values()]) : NONE
  }

  return Object.freeze({
    get model() {
      if (pending.length) {
        for (const changes of pending) base = applyReadModelDelta(base, changes)
        pending = []
      }
      return base
    },
    get revision() { return revision },
    get,
    entitiesOfType: (typeId: string) => byType.list(typeId),
    entriesOfLayer: (layerId: string) => byLayer.list(layerId),
    entriesOfEntity: (entityId: string) => byEntity.list(entityId),
    relationsTo: (entityId: string, typeId?: string) => {
      const list = relationsTo.list(entityId)
      return typeId === undefined ? list : Object.freeze(list.filter((relation) => relation.typeId === typeId))
    },
    relationsFrom: (entityId: string, typeId?: string) => {
      const list = relationsFrom.list(entityId)
      return typeId === undefined ? list : Object.freeze(list.filter((relation) => relation.typeId === typeId))
    },
    anchorsOf: (entityId: string) => anchors.list(entityId),
    viewItemsOf: (scope: string) => items.list(scope),
    viewSettingsOf: (scope: string) => settings.list(scope),
    referencesTo,
    apply(changes: ReadModelChanges) {
      if (changes.baseRevision !== revision) reject('E_STALE', 'changes.baseRevision')
      if (changes.nextRevision !== revision && changes.nextRevision !== revision + 1) reject('E_REVISION', 'changes.nextRevision')
      // References are computed with the definitions of the moment: old rows' before the batch, new rows' after it.
      const removed: [ReadModelTable, ReadModelRow][] = []
      for (const { table, id } of changes.deletes) {
        if (!isReadModelTable(table)) continue
        const row = rows.get(table)!.get(id)
        if (!row) reject('E_NOT_FOUND', table)
        removed.push([table, row!])
      }
      const replaced: [ReadModelTable, ReadModelRow][] = []
      for (const { table, row } of changes.upserts) {
        if (!isReadModelTable(table)) continue
        const old = rows.get(table)!.get(row.id)
        if (old) replaced.push([table, old])
      }
      for (const [table, row] of [...removed, ...replaced]) {
        if (reverse) removeRefs(table, row)
        for (const groups of groupsOf(table)) groups.remove(row)
        rows.get(table)!.delete(row.id)
      }
      const added: [ReadModelTable, ReadModelRow][] = []
      for (const { table, row } of changes.upserts) {
        if (!isReadModelTable(table)) continue
        rows.get(table)!.set(row.id, row as ReadModelRow)
        for (const groups of groupsOf(table)) groups.add(row as ReadModelRow)
        added.push([table, row as ReadModelRow])
      }
      if (reverse) for (const [table, row] of added) addRefs(table, row)
      revision = changes.nextRevision
      pending.push(changes)
    },
  })
}
