/** Lookups over a read model (3C-5A): the questions the official view, the export filters and, later, the store-native
 * planners ask, answered from maps built once (`indexReadModel`), never by scanning a table per question.
 *
 * - `get(table, id)`: one row;
 * - `entriesOfLayer(layerId)`, `entriesOfEntity(entityId)`: entries, in id order;
 * - `relationsTo(entityId, typeId?)`, `relationsFrom(entityId, typeId?)`: relations by either end, optionally of one
 *   type; the reverse part-of lookup is `relationsTo(country, partOfType)`;
 * - `anchorsOf(entityId)`: an entity's anchors;
 * - `viewItemsOf(scope)`: a scope's items ordered by position, then id; `viewSettingsOf(scope)`: its settings by id.
 *
 * Returned lists are frozen and shared; rows are the model's own. Core knows no type, layer or scope by name: the
 * caller passes them.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewSetting } from '../store/formal.ts'
import type { LayerEntry, StoreAnchor, StoreRelation } from '../store/types.ts'
import { READ_MODEL_TABLES, compareIds, type ReadModel, type ReadModelRow, type ReadModelTable } from './types.ts'

export interface ReadModelIndex {
  readonly model: ReadModel
  get<T extends ReadModelTable>(table: T, id: string): ReadModelRow<T> | undefined
  entriesOfLayer(layerId: string): readonly LayerEntry[]
  entriesOfEntity(entityId: string): readonly LayerEntry[]
  relationsTo(entityId: string, typeId?: string): readonly StoreRelation[]
  relationsFrom(entityId: string, typeId?: string): readonly StoreRelation[]
  anchorsOf(entityId: string): readonly StoreAnchor[]
  viewItemsOf(scope: string): readonly ViewItem[]
  viewSettingsOf(scope: string): readonly ViewSetting[]
}

const NONE: readonly never[] = Object.freeze([])

function grouped<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, readonly T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row), list = groups.get(key)
    if (list) list.push(row); else groups.set(key, [row])
  }
  for (const list of groups.values()) Object.freeze(list)
  return groups as Map<string, readonly T[]>
}

/** The lookups of one read model. Building them reads every row once. */
export function indexReadModel(model: ReadModel): ReadModelIndex {
  const rows = new Map<ReadModelTable, Map<string, ReadModelRow>>()
  for (const table of READ_MODEL_TABLES) rows.set(table, new Map((model[table] as readonly ReadModelRow[]).map((row) => [row.id, row] as const)))
  const byLayer = grouped(model.entries, (entry) => entry.layerId)
  const byEntity = grouped(model.entries, (entry) => entry.entityId)
  const relationsTo = grouped(model.relations, (relation) => relation.toEntityId)
  const relationsFrom = grouped(model.relations, (relation) => relation.fromEntityId)
  const anchors = grouped(model.anchors, (anchor) => anchor.entityId)
  const items = grouped(
    [...model.viewItems].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : compareIds(a.id, b.id))),
    (item) => item.scope,
  )
  const settings = grouped(model.viewSettings, (setting) => setting.scope)
  const ofType = (list: readonly StoreRelation[] | undefined, typeId: string | undefined) =>
    !list ? NONE : typeId === undefined ? list : Object.freeze(list.filter((relation) => relation.typeId === typeId))
  return Object.freeze({
    model,
    get: <T extends ReadModelTable>(table: T, id: string) => rows.get(table)?.get(id) as ReadModelRow<T> | undefined,
    entriesOfLayer: (layerId: string) => byLayer.get(layerId) ?? NONE,
    entriesOfEntity: (entityId: string) => byEntity.get(entityId) ?? NONE,
    relationsTo: (entityId: string, typeId?: string) => ofType(relationsTo.get(entityId), typeId),
    relationsFrom: (entityId: string, typeId?: string) => ofType(relationsFrom.get(entityId), typeId),
    anchorsOf: (entityId: string) => anchors.get(entityId) ?? NONE,
    viewItemsOf: (scope: string) => items.get(scope) ?? NONE,
    viewSettingsOf: (scope: string) => settings.get(scope) ?? NONE,
  })
}
