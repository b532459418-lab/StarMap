/** A part of a read model whose references all resolve (3C-5A): the base of every filtered export (the public export,
 * and later the personal build's filter).
 *
 * `selectReadModel(model, keep, { prune })`:
 * 1. `keep(table, row)` chooses rows; a row it refuses is gone.
 * 2. Pruning: a row of a table listed in `prune` (definitions, evidence, assets, …) stays only while a kept row that is
 *    not view state refers to it, directly or through other pruned rows. View rows never keep a row alive: hiding or
 *    ordering something does not publish it.
 * 3. Closure: a kept row that refers to a row that is gone goes too (an entry whose entity is gone, a relation missing
 *    an end, a view item or setting whose target is gone, …), with two exceptions that are lists rather than single
 *    references: a sequence keeps the entries that remain (and goes when none does), and a `source.evidenceIds` list
 *    keeps the evidence that remains. References to review receipts are not checked: receipts are never in a read model.
 * Steps 2 and 3 repeat until nothing changes. A rewritten row (sequence, evidence list) is a new object with the same
 * id and revision; every other row is the input's own. The header is kept. Core does not know which view settings
 * hold raw ids (such as an App's unresolved list elements): the caller's `keep` decides about those.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalRow } from '../store/formal.ts'
import { referencesOf } from '../store/reader.ts'
import type { EntrySequence, SourceRef } from '../store/types.ts'
import { READ_MODEL_TABLES, READ_MODEL_VIEW_TABLES, type ReadModel, type ReadModelRow, type ReadModelTable } from './types.ts'

export type ReadModelKeep = (table: ReadModelTable, row: ReadModelRow) => boolean
export interface SelectOptions {
  /** Tables whose rows stay only while a kept row that is not view state refers to them. */
  readonly prune?: readonly ReadModelTable[]
}

const key = (table: string, id: string) => `${table}\u0000${id}`

/** The selected, closed part of `model` (see the file header). */
export function selectReadModel(model: ReadModel, keep: ReadModelKeep, options: SelectOptions = {}): ReadModel {
  const prune = new Set(options.prune ?? [])
  const original = new Map<string, ReadModelRow>()
  for (const table of READ_MODEL_TABLES) for (const row of model[table] as readonly ReadModelRow[]) original.set(key(table, row.id), row)
  // Field definitions come from the original model: which fields are references never depends on the selection.
  const lookup = { get: (table: string, id: string) => original.get(key(table, id)) as FormalRow | undefined }
  const chosen = new Map<ReadModelTable, Map<string, ReadModelRow>>()
  for (const table of READ_MODEL_TABLES) {
    chosen.set(table, new Map((model[table] as readonly ReadModelRow[]).filter((row) => keep(table, row)).map((row) => [row.id, row] as const)))
  }
  const has = (table: string, id: string) => table !== 'reviews' && (chosen.get(table as ReadModelTable)?.has(id) ?? false)
  const isView = (table: ReadModelTable) => READ_MODEL_VIEW_TABLES.includes(table)

  for (let changed = true; changed;) {
    changed = false
    // Pruning: what kept rows outside view state reach, starting from the tables that are not pruned.
    const reached = new Set<string>()
    const queue: [ReadModelTable, ReadModelRow][] = []
    for (const [table, rows] of chosen) if (!prune.has(table) && !isView(table)) for (const row of rows.values()) queue.push([table, row])
    while (queue.length) {
      const [table, row] = queue.pop()!
      for (const ref of referencesOf(table, row as FormalRow, lookup)) {
        const target = ref.toTable as ReadModelTable
        if (!prune.has(target) || reached.has(key(target, ref.toId))) continue
        const found = chosen.get(target)?.get(ref.toId)
        if (!found) continue
        reached.add(key(target, ref.toId))
        queue.push([target, found])
      }
    }
    for (const table of prune) {
      for (const id of [...chosen.get(table)!.keys()]) if (!reached.has(key(table, id))) { chosen.get(table)!.delete(id); changed = true }
    }
    // Closure: drop or rewrite rows that refer to a row that is gone.
    for (const [table, rows] of chosen) {
      for (const [id, row] of [...rows]) {
        let next: ReadModelRow | undefined = row
        if (table === 'sequences') {
          const sequence = row as EntrySequence
          const entryIds = sequence.entryIds.filter((entryId) => has('entries', entryId))
          if (entryIds.length !== sequence.entryIds.length) next = entryIds.length ? { ...sequence, entryIds } as ReadModelRow : undefined
        }
        const source = (next as { readonly source?: SourceRef } | undefined)?.source
        if (next && source && source.evidenceIds.some((evidenceId) => !has('evidence', evidenceId))) {
          next = { ...next, source: { ...source, evidenceIds: source.evidenceIds.filter((evidenceId) => has('evidence', evidenceId)) } } as ReadModelRow
        }
        if (next && referencesOf(table, next as FormalRow, lookup).some((ref) => ref.toTable !== 'reviews' && !has(ref.toTable, ref.toId))) next = undefined
        if (next === row) continue
        if (next) rows.set(id, next); else rows.delete(id)
        changed = true
      }
    }
  }
  const result: Record<string, unknown> = {
    format: model.format, formatVersion: model.formatVersion, revision: model.revision, origin: model.origin,
  }
  for (const table of READ_MODEL_TABLES) {
    const rows = chosen.get(table)!
    result[table] = (model[table] as readonly ReadModelRow[]).filter((row) => rows.has(row.id)).map((row) => rows.get(row.id)!)
  }
  return result as unknown as ReadModel
}
