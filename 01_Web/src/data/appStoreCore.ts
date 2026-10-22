/**
 * The App's data store (3C-5 sub-batch D, design §1): the read model the page shows, its official view and the derived
 * data of the six data modules, as one immutable snapshot that components read through hooks (./appStore.ts,
 * useSyncExternalStore). Saves no longer reload the page: the changed rows of a commit are applied to the read model
 * (applyReadModelDelta) and the official view and the derived data are computed again.
 *
 * - `computeSnapshot(model, options)`: everything from a read model (a full load, or a fresh one after a 410).
 * - `snapshotAfter(snapshot, changes, options)`: the snapshot of the next revision, or undefined when the changes are
 *   not the ones that follow this snapshot (another library or restore mark, or `from` is not this revision): the
 *   caller then fetches the changes by revision. Only the changed rows are checked (the shape every row shares), not
 *   the whole model.
 * - `createAppStore(initial)`: the mutable cell around the snapshots: getSnapshot / subscribe for React, `replace`,
 *   `apply` and `fail`. Listeners run after each new snapshot.
 *
 * The time query context is computed the first time it is asked for (only time filters read it).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types),
 * so it has no Vite import: ./appStore.ts wires it to the page's data source.
 */
import { deriveAppDataFromCanonical, type AppData } from './canonical/derive.ts'
import type { CanonicalData } from './canonical/types.ts'
import { deriveTimeQueryContext } from './derive/timeQueryContext.ts'
import { officialViewOf } from './store/projectCanonical.ts'
import { applyReadModelDelta } from '../worldgraph/readModel/delta.ts'
import { READ_MODEL_TABLES, type ReadModel, type ReadModelTable } from '../worldgraph/readModel/types.ts'
import { validateRowBase } from '../worldgraph/store/rows.ts'
import type { TimeQueryContext } from '../worldgraph/timeQuery.ts'

/**
 * The App's data did not load: which address (the dev server's endpoint, the personal build's data file, or the
 * sample), why; when the dev server's endpoint refused, its error code and problems too.
 */
export interface AppDataLoadError {
  readonly file: string
  readonly reason: string
  readonly code?: string
  readonly problems?: readonly string[]
}

/** Which library a read model was read from: its library id and restore mark (a restore from a backup changes it). */
export interface StoreIdentity {
  readonly libraryId: string
  readonly restoreMark: string | null
}

/** The changed rows of one or more commits, from revision `from` to `to` (the host's change set, read-model tables only). */
export interface ReadModelChanges {
  readonly libraryId?: string
  readonly restoreMark?: string | null
  readonly from: number
  readonly to: number
  readonly upserts: readonly { readonly table: string; readonly row: unknown }[]
  readonly deletes: readonly { readonly table: string; readonly id: string }[]
}

export interface AppSnapshot {
  /** `loading` until the read model arrives, `error` when it could not be loaded (the data are then an empty model). */
  readonly status: 'loading' | 'ready' | 'error'
  readonly error?: AppDataLoadError
  /** The library the read model comes from (undefined for the sample and before a library answered). */
  readonly identity?: StoreIdentity
  readonly revision: number
  readonly model: ReadModel
  readonly canonical: CanonicalData
  readonly appData: AppData
  /** The time query context of the same official view, computed when first asked for. */
  readonly timeQueryContext: () => TimeQueryContext
}

export interface SnapshotOptions {
  /** The official view's source ('sample' for the public sample, 'local' for private data). */
  readonly source: 'local' | 'sample'
  /** The session time the derivations use (fixed for a page). */
  readonly now: string
}

const isReadModelTable = (table: string): table is ReadModelTable => (READ_MODEL_TABLES as readonly string[]).includes(table)

function lazy<T>(compute: () => T): () => T {
  let done = false
  let value: T
  return () => {
    if (!done) { value = compute(); done = true }
    return value
  }
}

/** Everything the App reads, from a read model. */
export function computeSnapshot(
  model: ReadModel,
  options: SnapshotOptions & { readonly identity?: StoreIdentity; readonly status?: AppSnapshot['status']; readonly error?: AppDataLoadError },
): AppSnapshot {
  const canonical = officialViewOf(model, options.source)
  const appData = deriveAppDataFromCanonical(canonical, { now: options.now })
  return Object.freeze({
    status: options.status ?? 'ready',
    ...(options.error ? { error: options.error } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    revision: model.revision,
    model,
    canonical,
    appData,
    timeQueryContext: lazy(() => deriveTimeQueryContext(canonical)),
  })
}

/** Whether `changes` come from the library this snapshot was read from (both known and equal, or either unknown). */
export function sameLibrary(identity: StoreIdentity | undefined, changes: Pick<ReadModelChanges, 'libraryId' | 'restoreMark'>): boolean {
  if (!identity || changes.libraryId === undefined) return true
  return identity.libraryId === changes.libraryId && (changes.restoreMark === undefined || identity.restoreMark === changes.restoreMark)
}

/**
 * The snapshot after `changes`, or undefined when they do not follow this snapshot (see the file header). Changes that
 * end at this revision (already applied) also give undefined. Throws when a changed row does not have the shape every
 * row shares, or when the changes do not fit the model (applyReadModelDelta's E_NOT_FOUND).
 */
export function snapshotAfter(snapshot: AppSnapshot, changes: ReadModelChanges, options: SnapshotOptions): AppSnapshot | undefined {
  if (snapshot.status !== 'ready' || !sameLibrary(snapshot.identity, changes)) return undefined
  if (changes.from !== snapshot.revision || changes.to < changes.from) return undefined
  // Nothing committed (a write without changes answers with the same revision).
  if (changes.to === changes.from && changes.upserts.length === 0 && changes.deletes.length === 0) return snapshot
  for (const { table, row } of changes.upserts) if (isReadModelTable(table)) validateRowBase(table, row)
  const model = applyReadModelDelta(snapshot.model, {
    baseRevision: changes.from,
    // applyReadModelDelta moves one revision at a time; changes over several commits (an external writer) jump.
    nextRevision: changes.to === changes.from ? changes.from : changes.from + 1,
    upserts: changes.upserts as never,
    deletes: changes.deletes as never,
  })
  const next = changes.to === model.revision ? model : { ...model, revision: changes.to }
  return computeSnapshot(next, { ...options, ...(snapshot.identity ? { identity: snapshot.identity } : {}) })
}

export interface AppStore {
  getSnapshot(): AppSnapshot
  subscribe(listener: () => void): () => void
  /** A whole read model (the first load, or after a 410). */
  replace(model: ReadModel, identity?: StoreIdentity): AppSnapshot
  /** Apply `changes` when they follow the current snapshot; false when they do not (fetch by revision instead). */
  apply(changes: ReadModelChanges): boolean
  /** The read model could not be loaded: an empty model with the reason. */
  fail(model: ReadModel, error: AppDataLoadError): AppSnapshot
}

export function createAppStore(initial: AppSnapshot, options: SnapshotOptions): AppStore {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const publish = (next: AppSnapshot) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
    return next
  }
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    replace: (model: ReadModel, identity?: StoreIdentity) => publish(computeSnapshot(model, { ...options, ...(identity ? { identity } : {}) })),
    apply(changes: ReadModelChanges) {
      const next = snapshotAfter(snapshot, changes, options)
      if (!next) return false
      if (next !== snapshot) publish(next)
      return true
    },
    fail: (model: ReadModel, error: AppDataLoadError) => publish(computeSnapshot(model, { ...options, status: 'error', error })),
  })
}
