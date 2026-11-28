import { emptyFormalState, FORMAL_TABLES, readFormalState, type FormalRow, type FormalState, type FormalTable, type Tombstone } from './formal.ts'
import { jsonKey, reject } from './primitives.ts'
import { referencesOf, rowKey } from './reader.ts'
import type { StorePolicy } from './types.ts'

export const EXCHANGE_FORMAT = 'starmap.exchange'
export const EXCHANGE_VERSION = 1

export type ExchangeScope = { readonly kind: 'library' } | {
  readonly kind: 'selection'
  readonly layerIds: readonly string[]
  readonly entryIds: readonly string[]
}

function graphLookup(state: FormalState) {
  const tables = new Map(FORMAL_TABLES.map(table => [table, new Map<string, FormalRow>(
    state[table].map(row => [row.id, row]),
  )]))
  return { get: (table: FormalTable, id: string) => tables.get(table)?.get(id) }
}

/** Selected entries and their dependencies. Anchors of the included entities
 * are part of the selection so that the recipient can place them on the map. */
export function selectExchangeGraph(state: FormalState, scope: ExchangeScope): FormalState {
  if (scope.kind === 'library') return state
  const lookup = graphLookup(state)
  const layers = new Set(scope.layerIds)
  const entries = new Set(scope.entryIds)
  const selected = new Set<string>()
  const queue: { table: FormalTable; id: string }[] = []
  const anchors = new Map<string, string[]>()
  for (const anchor of state.anchors) {
    const ids = anchors.get(anchor.entityId)
    if (ids) ids.push(anchor.id)
    else anchors.set(anchor.entityId, [anchor.id])
  }
  const add = (table: FormalTable, id: string) => {
    const key = rowKey(table, id)
    if (selected.has(key)) return
    if (!lookup.get(table, id)) reject('E_EXCHANGE_SELECTION', table)
    selected.add(key)
    queue.push({ table, id })
  }
  for (const id of layers) add('layers', id)
  for (const id of entries) add('entries', id)
  for (const entry of state.entries) if (layers.has(entry.layerId)) add('entries', entry.id)
  if (queue.length === 0) reject('E_EXCHANGE_SELECTION', 'scope')
  for (let index = 0; index < queue.length; index++) {
    const { table, id } = queue[index]
    for (const ref of referencesOf(table, lookup.get(table, id)!, lookup)) add(ref.toTable, ref.toId)
    if (table === 'entities') for (const anchorId of anchors.get(id) ?? []) add('anchors', anchorId)
  }
  const tables = Object.fromEntries(FORMAL_TABLES.map(table => [table,
    state[table].filter(row => selected.has(rowKey(table, row.id))),
  ]))
  return { ...emptyFormalState(), ...tables }
}

const sameRow = (a: FormalRow, b: FormalRow) =>
  jsonKey({ ...a, revision: 0 }) === jsonKey({ ...b, revision: 0 })

/** Append-only transfer plan shared by storage hosts. Stable identities make an
 * unchanged re-import a no-op. A destination edit or deletion is a conflict. */
export function planExchange(destination: FormalState, incoming: FormalState, policy: StorePolicy = {}) {
  const target = graphLookup(destination)
  const buried = new Set(destination.tombstones.map(row => rowKey(row.table, row.id)))
  const proposedRevision = destination.revision + 1
  const upserts: { table: FormalTable; row: FormalRow }[] = []
  const tombstones: Tombstone[] = []
  let unchanged = 0
  for (const table of FORMAL_TABLES) {
    for (const row of incoming[table]) {
      const previous = target.get(table, row.id)
      if (previous) {
        if (!sameRow(previous, row)) reject('E_EXCHANGE_CONFLICT', `${table}.${row.id}`)
        unchanged++
      } else {
        if (buried.has(rowKey(table, row.id))) reject('E_EXCHANGE_DELETED', `${table}.${row.id}`)
        upserts.push({ table, row: { ...row, revision: 0 } })
      }
    }
  }
  for (const row of incoming.tombstones) {
    if (target.get(row.table, row.id)) reject('E_EXCHANGE_CONFLICT', `${row.table}.${row.id}`)
    if (!buried.has(rowKey(row.table, row.id))) tombstones.push(row)
  }
  const nextRevision = upserts.length || tombstones.length ? proposedRevision : destination.revision
  const rowsByTable = new Map<FormalTable, FormalRow[]>(FORMAL_TABLES.map(table => [table, [...destination[table]]]))
  for (const { table, row } of upserts) rowsByTable.get(table)!.push(row)
  const next = readFormalState({
    ...Object.fromEntries(rowsByTable),
    revision: nextRevision,
    tombstones: [...destination.tombstones, ...tombstones],
  }, policy)
  const nextLookup = graphLookup(next)
  return {
    baseRevision: destination.revision,
    nextRevision,
    upserts,
    tombstones,
    unchanged,
    deletes: [],
    refsRemoved: [],
    refsAdded: upserts.flatMap(({ table, row }) => referencesOf(table, row, nextLookup)),
  }
}
