/** The public export of a read model (3C-5A, design 3C-5 §1; design 3B v1.1 §9: an export filtered by `visibility`).
 *
 * `src/data/store/` is the App layer: the rules below know the official view scopes and which verbatim V2 values the
 * official view reads. The selection itself is Core's (`selectReadModel`), so every kept row's references resolve.
 *
 * What stays:
 * - entities whose `visibility` is `public`;
 * - anchors whose own visibility, or else their entity's, is `public`;
 * - entries, relations, sequences and view rows as long as what they refer to stays: an entry follows its entity, a
 *   relation needs both ends, a sequence keeps the entries that remain, a view item or setting needs its target;
 * - definitions, evidence and assets only while a kept row that is not view state refers to them (so an asset only a
 *   hidden list names goes, and an unreferenced source such as the V2 file headers goes);
 * - view settings without a reference only in the display scope (the overview target and the region matchers); every
 *   other value setting goes, the list elements that never resolved to a row (`unresolved:`) included. The overview
 *   target is published on purpose: it is the coordinate of the map's default camera, which a public map needs (review
 *   of 3C-5A);
 * - `extensions`: only the verbatim V2 values the official view reads (PUBLIC_EXTENSION_KEYS); anything else, such as
 *   old name-derived keys or values of unknown meaning, goes, and so does every other table's extensions.
 * Asset attributes and evidence attributes are row data, not extensions, and stay as they are, except an asset's
 * `originalFileName` (PUBLIC_ASSET_ATTRIBUTES_REMOVED): the name of the file it was imported from may carry names or
 * dates, so a public export never has it (review of 3C-5A).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewSetting } from '../../worldgraph/store/formal.ts'
import type { JsonObject, StoreAnchor, StoreEntity } from '../../worldgraph/store/types.ts'
import { selectReadModel } from '../../worldgraph/readModel/select.ts'
import { READ_MODEL_DEFINITION_TABLES, READ_MODEL_TABLES, type ReadModel, type ReadModelRow, type ReadModelTable } from '../../worldgraph/readModel/types.ts'
import { UNRESOLVED_KEY_PREFIX, VIEW_SCOPES } from './officialDefinitions.ts'

/** Verbatim V2 values (`extensions.v2.<key>`) the official view reads, per table; nothing else is published. */
export const PUBLIC_EXTENSION_KEYS: Readonly<Partial<Record<ReadModelTable, readonly string[]>>> = Object.freeze({
  // A place's names when the store title could not hold them, other external ids; a media item's title likewise.
  entities: Object.freeze(['names', 'originalLanguage', 'externalIds', 'title']),
  // Footprint and planned records: classification (region, type, travelCategory, status), the record's own
  // coordinates, and values that did not fit their formal field. Want-to-go items: a note or date that did not fit.
  entries: Object.freeze(['region', 'type', 'status', 'travelCategory', 'lat', 'lng', 'hiddenFromHome', 'journeyId', 'notes', 'trip_title', 'note', 'addedAt']),
})
/** Scopes whose value settings (no reference) are published. */
export const PUBLIC_VALUE_SCOPES: readonly string[] = Object.freeze([VIEW_SCOPES.display])
/** Asset attributes a public export never carries. */
export const PUBLIC_ASSET_ATTRIBUTES_REMOVED: readonly string[] = Object.freeze(['originalFileName'])
/** Tables that keep only what a kept fact refers to. */
export const PUBLIC_PRUNED_TABLES: readonly ReadModelTable[] = Object.freeze([...READ_MODEL_DEFINITION_TABLES, 'evidence', 'assets'])

const plain = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A row with only the published extensions (a new object), or the row itself when it has none. */
function publishedExtensions(table: ReadModelTable, row: ReadModelRow): ReadModelRow {
  const extensions = (row as { readonly extensions?: JsonObject }).extensions
  if (extensions === undefined) return row
  const allowed = PUBLIC_EXTENSION_KEYS[table] ?? []
  const v2 = plain(extensions.v2) ? Object.fromEntries(Object.entries(extensions.v2).filter(([key]) => allowed.includes(key))) : {}
  const next: Record<string, unknown> = { ...row }
  if (Object.keys(v2).length) next.extensions = { v2 }; else delete next.extensions
  return next as unknown as ReadModelRow
}

/** An asset without the attributes a public export never carries (a new object), or the row itself. */
function publishedAttributes(table: ReadModelTable, row: ReadModelRow): ReadModelRow {
  const attributes = (row as { readonly attributes?: JsonObject }).attributes
  if (table !== 'assets' || attributes === undefined || !PUBLIC_ASSET_ATTRIBUTES_REMOVED.some((key) => Object.hasOwn(attributes, key))) return row
  const kept = Object.fromEntries(Object.entries(attributes).filter(([key]) => !PUBLIC_ASSET_ATTRIBUTES_REMOVED.includes(key)))
  return { ...row, attributes: kept } as unknown as ReadModelRow
}

/** The public part of `model` (see the file header). The header is kept. */
export function publicReadModelOf(model: ReadModel): ReadModel {
  const visibilityOf = new Map(model.entities.map((entity) => [entity.id, entity.visibility] as const))
  const keep = (table: ReadModelTable, row: ReadModelRow): boolean => {
    if (table === 'entities') return (row as StoreEntity).visibility === 'public'
    if (table === 'anchors') {
      const anchor = row as StoreAnchor
      return (anchor.visibility ?? visibilityOf.get(anchor.entityId)) === 'public'
    }
    if (table === 'viewSettings') {
      const setting = row as ViewSetting
      return setting.ref !== undefined || (PUBLIC_VALUE_SCOPES.includes(setting.scope) && !setting.key.startsWith(UNRESOLVED_KEY_PREFIX))
    }
    return true
  }
  const selected = selectReadModel(model, keep, { prune: PUBLIC_PRUNED_TABLES })
  const result: Record<string, unknown> = { ...selected }
  for (const table of READ_MODEL_TABLES) {
    result[table] = (selected[table] as readonly ReadModelRow[]).map((row) => publishedAttributes(table, publishedExtensions(table, row)))
  }
  return result as unknown as ReadModel
}
