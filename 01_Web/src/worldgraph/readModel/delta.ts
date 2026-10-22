/** Incremental update of a read model (3C-5A): the planner's change set (../store/planner.ts ChangeSet) applied to the
 * read model of the revision it was planned on gives the read model of the next revision, without reading the store
 * again. The change set's upserts are whole rows and its deletes every row that is gone after the batch (including the
 * view rows a removal took along), so nothing else is needed.
 *
 * - The model's revision must be the change set's base revision (E_STALE) and the next revision the same or one more
 *   (E_REVISION), as in applyChangeSet.
 * - A deleted row must exist (E_NOT_FOUND). Review receipts and tombstones are not in a read model: their changes are
 *   ignored.
 * - Each touched table stays ordered by id; untouched tables are shared with the input, which is never modified.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ChangeSet } from '../store/planner.ts'
import { reject } from '../store/primitives.ts'
import { READ_MODEL_TABLES, compareIds, type ReadModel, type ReadModelRow, type ReadModelTable } from './types.ts'

const isReadModelTable = (table: string): table is ReadModelTable => (READ_MODEL_TABLES as readonly string[]).includes(table)

/** `model` after `changeSet` (see the file header). */
export function applyReadModelDelta(model: ReadModel, changeSet: Pick<ChangeSet, 'baseRevision' | 'nextRevision' | 'upserts' | 'deletes'>): ReadModel {
  if (changeSet.baseRevision !== model.revision) reject('E_STALE', 'changeSet.baseRevision')
  if (changeSet.nextRevision !== model.revision && changeSet.nextRevision !== model.revision + 1) reject('E_REVISION', 'changeSet.nextRevision')
  if (!Array.isArray(changeSet.upserts) || !Array.isArray(changeSet.deletes)) reject('E_SHAPE', 'changeSet')
  const touched = new Map<ReadModelTable, { removed: Set<string>; written: Map<string, ReadModelRow> }>()
  const changesOf = (table: ReadModelTable) => {
    let changes = touched.get(table)
    if (!changes) touched.set(table, changes = { removed: new Set(), written: new Map() })
    return changes
  }
  for (const { table, id } of changeSet.deletes) if (isReadModelTable(table)) changesOf(table).removed.add(id)
  for (const { table, row } of changeSet.upserts) {
    if (!isReadModelTable(table)) continue
    const changes = changesOf(table)
    changes.removed.delete(row.id)
    changes.written.set(row.id, row as ReadModelRow)
  }
  const next: Record<string, unknown> = { ...model, revision: changeSet.nextRevision }
  for (const [table, { removed, written }] of touched) {
    const before = model[table] as readonly ReadModelRow[]
    const present = new Set(before.map((row) => row.id))
    for (const id of removed) if (!present.has(id)) reject('E_NOT_FOUND', table)
    const kept: ReadModelRow[] = []
    for (const row of before) {
      if (removed.has(row.id)) continue
      const replacement = written.get(row.id)
      if (replacement) { kept.push(replacement); written.delete(row.id) } else kept.push(row)
    }
    // Rows new to the table, merged into the id order.
    const added = [...written.values()].sort((a, b) => compareIds(a.id, b.id))
    const merged: ReadModelRow[] = []
    let i = 0, j = 0
    while (i < kept.length || j < added.length) {
      if (j >= added.length || (i < kept.length && compareIds(kept[i].id, added[j].id) < 0)) merged.push(kept[i++])
      else merged.push(added[j++])
    }
    next[table] = merged
  }
  return next as unknown as ReadModel
}

/**
 * The changed rows between two read models of one library (3C-5 D: a commit by another process, which the host learns
 * about by reading the store again): every row of `after` that `before` lacks or holds at another row revision, and every
 * row of `before` that `after` lacks. Rows are compared by id and row revision only: the planner raises a row's revision
 * with every change and never gives a deleted id back (tombstones), so within one library an unchanged (id, revision) is
 * an unchanged row. Never use it across libraries or across a restore.
 */
export function readModelChangesBetween(before: ReadModel, after: ReadModel): {
  readonly upserts: readonly { readonly table: ReadModelTable; readonly row: ReadModelRow }[]
  readonly deletes: readonly { readonly table: ReadModelTable; readonly id: string }[]
} {
  const upserts: { table: ReadModelTable; row: ReadModelRow }[] = []
  const deletes: { table: ReadModelTable; id: string }[] = []
  for (const table of READ_MODEL_TABLES) {
    const old = before[table] as readonly ReadModelRow[], now = after[table] as readonly ReadModelRow[]
    if (old === now) continue
    const revisions = new Map(old.map((row) => [row.id, row.revision]))
    for (const row of now) {
      if (revisions.get(row.id) !== row.revision) upserts.push({ table, row })
      revisions.delete(row.id)
    }
    for (const id of revisions.keys()) deletes.push({ table, id })
  }
  return { upserts, deletes }
}
