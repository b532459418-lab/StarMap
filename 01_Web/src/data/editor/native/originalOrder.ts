/**
 * Appending to an original-order scope (the registry order of places, the order of want-to-go items), as diffV2's
 * orderScope does for a record added at the end of a V2 file (3C-5 C1):
 * - every key already has a row: the new rows get `positionBetween(last position, undefined)`, one after the other;
 * - a key without a row, or no position left (E_POSITION): the scope is renumbered with listPositions in the official
 *   order (positioned rows first by position and row id, then the keys without a row by their projection order), rows
 *   whose position changes are updated, missing rows created.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewItemTable } from '../../../worldgraph/store/formal.ts'
import { positionBetween } from '../../../worldgraph/store/position.ts'
import { StoreError } from '../../../worldgraph/store/primitives.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import { listPositions, viewItemRow } from '../../store/v2RecordRows.ts'
import { viewRowId, type CommandBatch } from './batch.ts'

/** A key of the scope: the row id it targets, and its order when it has no row (the projection's `after`). */
export interface OrderKey { readonly id: string; readonly after: readonly [string, string] }

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function appendToOriginalOrder(reader: OfficialReader, batch: CommandBatch, newId: () => string, options: {
  readonly scope: string
  readonly table: ViewItemTable
  /** Every key the scope orders now (the projection's rows); asked once. */
  readonly keys: () => readonly OrderKey[]
  readonly added: readonly string[]
  readonly layerId?: string
}): void {
  const { scope, table, added, layerId } = options
  const rows = reader.scope(scope).items.filter((row) => row.itemTable === table)
  // The first row of a key in position order is the one the projection uses.
  const rowOf = new Map<string, ViewItem>()
  for (const row of rows) if (!rowOf.has(row.itemId)) rowOf.set(row.itemId, row)
  const keys = options.keys()
  const target = (id: string) => ({ table, id })
  if (keys.every((key) => rowOf.has(key.id))) {
    // The last key's row is the last positioned one (the projection sorts by position).
    let previous = keys.length ? keys.map((key) => rowOf.get(key.id)!).reduce((a, b) => (compare(a.position, b.position) || compare(a.id, b.id)) >= 0 ? a : b).position : undefined
    try {
      const positions = added.map((id) => ({ id, position: (previous = positionBetween(previous, undefined)) }))
      for (const { id, position } of positions) batch.create('viewItems', viewItemRow(scope, viewRowId(scope, newId), target(id), position, false, layerId))
      return
    } catch (error) {
      if (!(error instanceof StoreError && error.code === 'E_POSITION')) throw error
    }
  }
  // Renumber: the official order, then the new keys.
  const ordered = [...keys].sort((x, y) => {
    const a = rowOf.get(x.id), b = rowOf.get(y.id)
    if (a && b) return compare(a.position, b.position) || compare(a.id, b.id)
    if (a || b) return a ? -1 : 1
    return compare(x.after[0], y.after[0]) || compare(x.after[1], y.after[1])
  }).map((key) => key.id)
  const all = [...ordered, ...added]
  const numbers = listPositions(all.length)
  const seen = new Set<string>()
  all.forEach((id, i) => {
    const row = rowOf.get(id)
    if (row) { seen.add(row.id); batch.update('viewItems', row, viewItemRow(scope, row.id, target(id), numbers[i], row.hidden, layerId ?? row.layerId)) }
    else batch.create('viewItems', viewItemRow(scope, viewRowId(scope, newId), target(id), numbers[i], false, layerId))
  })
  for (const row of rows) if (!seen.has(row.id) && !batch.removes('viewItems', row.id)) batch.remove('viewItems', row)
}
