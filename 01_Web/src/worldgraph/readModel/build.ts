/** Building a read model from formal rows, and the formal state a read model stands for (3C-5A).
 *
 * - `readModelOf(rows, header)`: the read model of a store's rows (a FormalState, or the host's unvalidated read of
 *   it). Tombstones and review receipts are left out; every table is a new array ordered by id (compareIds). The rows
 *   themselves are shared, not copied: callers must not modify them.
 * - `formalStateOfReadModel(model)`: the FormalState with the same rows, no tombstones and no receipts, for the
 *   pure readers Core and the App already have (memoryReader, the official view's projection).
 *
 * Pure: no IO, clock or validation (./check.ts validates).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalState, FormalTables } from '../store/formal.ts'
import { reject, revision as checkRevision } from '../store/primitives.ts'
import {
  READ_MODEL_FORMAT, READ_MODEL_FORMAT_VERSION, READ_MODEL_ORIGINS, READ_MODEL_TABLES, compareIds,
  type ReadModel, type ReadModelOrigin, type ReadModelRow, type ReadModelTable,
} from './types.ts'

/** Rows of every read-model table (any object with them, such as a FormalState) and its revision. */
export type ReadModelSource = Pick<FormalTables, ReadModelTable> & { readonly revision?: number }

const byId = <T extends { readonly id: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => compareIds(a.id, b.id))

/** The read model of `rows`. `revision` defaults to `rows.revision`. */
export function readModelOf(rows: ReadModelSource, header: { readonly origin: ReadModelOrigin; readonly revision?: number }): ReadModel {
  const revision = header.revision ?? rows.revision
  checkRevision(revision, 'readModel.revision')
  if (!READ_MODEL_ORIGINS.includes(header.origin)) reject('E_READ_MODEL_ORIGIN', 'readModel.origin')
  const tables: Record<string, readonly ReadModelRow[]> = {}
  for (const table of READ_MODEL_TABLES) {
    const list = rows[table] as readonly ReadModelRow[] | undefined
    if (!Array.isArray(list)) reject('E_SHAPE', table)
    tables[table] = byId(list)
  }
  return { format: READ_MODEL_FORMAT, formatVersion: READ_MODEL_FORMAT_VERSION, revision, origin: header.origin, ...tables } as unknown as ReadModel
}

/** The formal state of a read model: its rows, no tombstones, no review receipts. */
export function formalStateOfReadModel(model: ReadModel): FormalState {
  const tables: Record<string, unknown> = { revision: model.revision, tombstones: [], reviews: [] }
  for (const table of READ_MODEL_TABLES) tables[table] = model[table]
  return tables as unknown as FormalState
}
