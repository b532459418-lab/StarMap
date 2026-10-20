/** The read model `starmap.read-model` (3C-5A, design 3C-5 §1): a read-only copy of the formal store's rows, the one
 * shape the App, the public sample and every export read. It is generic: any layer, entity type or view scope a store
 * holds is in it, official or not.
 *
 * - Header: `format`, `formatVersion` (1), `revision` (the store revision the rows were read at) and `origin` ('local'
 *   for a library, 'sample' for the public sample).
 * - Rows: Core's formal row types (../store/formal.ts) unchanged, in three groups: definitions (sources, entity types,
 *   layers, relation types), facts (evidence, entities, entries, relations, anchors, assets, sequences) and view state
 *   (view items and settings). Each table is ordered by id in code-point order, the order the SQLite host reads them in.
 * - Never in it: tombstones and review receipts (host bookkeeping), proposals (not facts), and every table that only a
 *   host keeps (receipts, op_log, id_map, pending file operations, the media registry with its local paths).
 *
 * `formatVersion` follows Core's formal row dialect, not the host's file format: a reader refuses a higher version.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import { FORMAL_TABLES, type FormalTable, type FormalTables } from '../store/formal.ts'

export const READ_MODEL_FORMAT = 'starmap.read-model'
export const READ_MODEL_FORMAT_VERSION = 1
export type ReadModelOrigin = 'local' | 'sample'
export const READ_MODEL_ORIGINS: readonly ReadModelOrigin[] = Object.freeze(['local', 'sample'])

export type ReadModelTable = Exclude<FormalTable, 'reviews'>
/** The tables of a read model, in FORMAL_TABLES order (dependency order). */
export const READ_MODEL_TABLES: readonly ReadModelTable[] = Object.freeze(FORMAL_TABLES.filter((table): table is ReadModelTable => table !== 'reviews'))
export const READ_MODEL_DEFINITION_TABLES: readonly ReadModelTable[] = Object.freeze(['sources', 'entityTypes', 'layers', 'relationTypes'])
export const READ_MODEL_FACT_TABLES: readonly ReadModelTable[] = Object.freeze(['evidence', 'entities', 'entries', 'relations', 'anchors', 'assets', 'sequences'])
export const READ_MODEL_VIEW_TABLES: readonly ReadModelTable[] = Object.freeze(['viewItems', 'viewSettings'])

export type ReadModelTables = Omit<FormalTables, 'reviews'>
export type ReadModelRow<T extends ReadModelTable = ReadModelTable> = ReadModelTables[T][number]

export interface ReadModelHeader {
  readonly format: typeof READ_MODEL_FORMAT
  readonly formatVersion: typeof READ_MODEL_FORMAT_VERSION
  readonly revision: number
  readonly origin: ReadModelOrigin
}
export interface ReadModel extends ReadModelHeader, ReadModelTables {}

export const READ_MODEL_HEADER_KEYS: readonly (keyof ReadModelHeader)[] = Object.freeze(['format', 'formatVersion', 'revision', 'origin'])

/** Code-point order of two ids: SQLite's BINARY collation on UTF-8 text, so a read model built anywhere lists its rows
 * as the host reads them. It differs from `<` on UTF-16 code units only between surrogates and U+E000–U+FFFF. */
export function compareIds(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const x = a.charCodeAt(index), y = b.charCodeAt(index)
    if (x === y) continue
    const rank = (unit: number) => (unit >= 0xd800 && unit <= 0xdfff ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit)
    return rank(x) - rank(y)
  }
  return a.length - b.length
}
