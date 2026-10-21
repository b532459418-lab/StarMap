/**
 * The commands of one store-native write (3C-5 C1), in the order the planner checks them against each other:
 *   1. view rows that go away (nothing refers to a view row, and removing them first frees their unique keys);
 *   2. creations and updates, in the order the planner calls them (the caller calls them in dependency order: place
 *      entities, anchors and relations, entries, view rows);
 *   3. every other removal, in the order the planner calls them (the caller: entries, then anchors and relations, then
 *      place entities).
 * An update that changes nothing (revision aside) is no command; a row is removed once.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalRow, FormalTable, ViewItem, ViewSetting } from '../../../worldgraph/store/formal.ts'
import { jsonKey } from '../../../worldgraph/store/primitives.ts'
import type { ViewListRows, ViewListSink } from '../../store/viewListRows.ts'
import type { OfficialReader } from '../../store/officialReader.ts'

const withoutRevision = (row: object): string => jsonKey({ ...row, revision: 0 })
const isViewTable = (table: FormalTable) => table === 'viewItems' || table === 'viewSettings'

export interface CommandBatch {
  create(table: FormalTable, row: FormalRow): void
  /** Update `current` to `desired` (its revision is set) when they differ, revision aside. */
  update(table: FormalTable, current: FormalRow, desired: FormalRow): void
  remove(table: FormalTable, row: FormalRow): void
  removes(table: FormalTable, id: string): boolean
  commands(): readonly FormalCommand[]
}

export function commandBatch(): CommandBatch {
  const viewRemovals: FormalCommand[] = [], upserts: FormalCommand[] = [], removals: FormalCommand[] = []
  const removed = new Set<string>()
  const key = (table: FormalTable, id: string) => JSON.stringify([table, id])
  return {
    create(table, row) { upserts.push({ op: 'create', table, value: row }) },
    update(table, current, desired) {
      if (withoutRevision(current) === withoutRevision(desired)) return
      upserts.push({ op: 'update', table, id: current.id, expectedRevision: current.revision, value: { ...desired, id: current.id, revision: current.revision + 1 } as FormalRow })
    },
    remove(table, row) {
      if (removed.has(key(table, row.id))) return
      removed.add(key(table, row.id))
      const command: FormalCommand = { op: 'remove', table, id: row.id, expectedRevision: row.revision }
      if (isViewTable(table)) viewRemovals.push(command); else removals.push(command)
    },
    removes: (table, id) => removed.has(key(table, id)),
    commands: () => Object.freeze([...viewRemovals, ...upserts, ...removals]),
  }
}

/** A view row's id: `<scope>#<UUIDv7>` (as diffV2 names the view rows it creates). */
export const viewRowId = (scope: string, newId: () => string): string => `${scope}#${newId()}`

/** The view rows of the official reader, and a sink into `batch`, for ../../store/viewListRows.ts. */
export function viewListAccess(reader: OfficialReader, batch: CommandBatch, newId: () => string): { rows: ViewListRows; sink: ViewListSink } {
  return {
    rows: { viewScope: (scope) => reader.scope(scope), setting: (scope, key) => reader.viewSetting(scope, key) },
    sink: {
      create: (table, row) => batch.create(table, row),
      update: (table, current, desired) => batch.update(table, current, desired),
      remove: (table, row: ViewItem | ViewSetting) => batch.remove(table, row),
      removes: (table, id) => batch.removes(table, id),
      newRowId: (scope) => viewRowId(scope, newId),
      // New key settings get fresh ids too (diffV2 reuses `<scope>#<key>` unless a tombstone holds it; the live index has no tombstones).
      settingId: (scope) => viewRowId(scope, newId),
      renumbered: () => {},
    },
  }
}
