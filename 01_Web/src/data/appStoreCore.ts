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
 * The time query context is computed the first time it is asked for (only time filters read it). The page's queries
 * (`snapshot.queries`: the places and routes of the visible layers, the browse projection of the time filters, the
 * Collection) are computed the same way, once per snapshot and arguments, and kept while their inputs are.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types),
 * so it has no Vite import: ./appStore.ts wires it to the page's data source.
 */
import { createDeriveCache, deriveAppDataFromCanonical, type AppData, type DeriveCache } from './canonical/derive.ts'
import { reconcile } from './reconcile.ts'
import type { CanonicalData } from './canonical/types.ts'
import { deriveTimeQueryContext } from './derive/timeQueryContext.ts'
import { officialViewOf } from './store/projectCanonical.ts'
import { applyReadModelDelta } from '../worldgraph/readModel/delta.ts'
import { READ_MODEL_TABLES, type ReadModel, type ReadModelTable } from '../worldgraph/readModel/types.ts'
import { validateRowBase } from '../worldgraph/store/rows.ts'
import type { LayerTimeFilters, TimeQueryContext } from '../worldgraph/timeQuery.ts'
import { queryVisiblePlaces, type LayerQueryResult } from '../worldgraph/query.ts'
import { queryCollection, type CollectionEntry } from '../worldgraph/collection.ts'
import type { LanguageTag } from '../worldgraph/localizedText.ts'
import type { LayerId } from '../worldgraph/types.ts'
import { isTimeFilterActive } from '../worldgraph/timeFilter.ts'
import { WANT_TO_GO_LAYER_ID } from '../worldgraph/layers.ts'
import { buildBrowseTimeProjection, type BrowseTimeProjection } from './derive/browseTimeProjection.ts'

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
  /** The page's queries on this snapshot (see SnapshotQueries). */
  readonly queries: SnapshotQueries
  /** How long this snapshot took (ms): applying the changed rows (after a commit), the official view, the derived data, and
   * the time query context once it was asked for. For measurements (3C-5 D, design §1: the target is ≤400 ms in all). */
  readonly timings: SnapshotTimings
}

export interface SnapshotTimings {
  /** When the changes began to be applied (performance.now() of the page), for the save-to-usable measurement. */
  startedAt?: number
  deltaMs?: number
  officialMs: number
  /** Keeping the unchanged sections of the official view (structural sharing with the previous snapshot). */
  reconcileMs?: number
  deriveMs: number
  timeContextMs?: number
}

const elapsed = (started: number) => Math.round((performance.now() - started) * 10) / 10

export interface SnapshotOptions {
  /** The official view's source ('sample' for the public sample, 'local' for private data). */
  readonly source: 'local' | 'sample'
  /** The session time the derivations use (fixed for a page). */
  readonly now: string
  /**
   * The store's derivation cache (createAppStore keeps one): with the previous snapshot, the sections of the official
   * view that did not change keep their objects, the derivation steps whose inputs did not change are not run again, and
   * the App's data keep the identity of what did not change (the components that read only that do not render again).
   */
  readonly cache?: SnapshotCache
}

/**
 * 3C-5 D: the page's queries on a snapshot, computed once per snapshot and arguments, outside React (the App's
 * components read them through hooks, ./appStore.ts): the same arguments on the same data give the same object, and
 * a query whose inputs a save did not change is not run again (with the store's cache, across snapshots).
 */
export interface SnapshotQueries {
  /** The places and routes of the visible layers, within the time filters when given (without an active filter, the
   *  same result as without filters: the time query context is then not read). */
  visiblePlaces(layerIds: readonly LayerId[], filters?: LayerTimeFilters): LayerQueryResult
  /** The browse projection of the time filters (records, places and counts within them). */
  browseProjection(filters: LayerTimeFilters): BrowseTimeProjection
  /** The Collection: every entry of the want-to-go layer, sorted for the UI language. */
  collection(locale: LanguageTag): CollectionEntry[]
}

/** What the store keeps between snapshots: the derivation steps, the time query context and the queries, with their inputs. */
export interface SnapshotCache {
  readonly derive: DeriveCache
  timeContext?: { readonly inputs: readonly unknown[]; readonly value: TimeQueryContext }
  /** The last results of each query (a few: two consumers can ask with different arguments), most recent first. */
  readonly queries: Map<string, { readonly inputs: readonly unknown[]; readonly value: unknown }[]>
}
export const createSnapshotCache = (): SnapshotCache => ({ derive: createDeriveCache(), queries: new Map() })

const QUERY_RESULTS_KEPT = 4
/** The result of query `name` for `inputs` (compared with Object.is): the kept one, or `compute()` kept for next time. */
function cachedQuery<T>(queries: SnapshotCache['queries'], name: string, inputs: readonly unknown[], compute: () => T): T {
  const kept = queries.get(name) ?? []
  const hit = kept.find((entry) => entry.inputs.length === inputs.length && entry.inputs.every((input, index) => Object.is(input, inputs[index])))
  if (hit) return hit.value as T
  const value = compute()
  queries.set(name, [{ inputs, value }, ...kept].slice(0, QUERY_RESULTS_KEPT))
  return value
}
/** Time filters as a value (equal filters, equal key); undefined when none is active. */
const activeFiltersKey = (filters: LayerTimeFilters | undefined) => (filters && Object.values(filters).some((filter) => filter !== undefined && isTimeFilterActive(filter))
  ? JSON.stringify(filters) : undefined)

/** The official view with every section that equals the previous one's replaced by it (and the whole view when all do). */
function shareSections(previous: CanonicalData, next: CanonicalData): CanonicalData {
  const merged: Record<string, unknown> = {}
  let same = true
  for (const key of Object.keys(next) as (keyof CanonicalData)[]) {
    merged[key] = reconcile(previous[key], next[key])
    if (merged[key] !== previous[key]) same = false
  }
  return same ? previous : merged as unknown as CanonicalData
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
  options: SnapshotOptions & { readonly identity?: StoreIdentity; readonly status?: AppSnapshot['status']; readonly error?: AppDataLoadError; readonly deltaMs?: number; readonly startedAt?: number; readonly previous?: AppSnapshot },
): AppSnapshot {
  let started = performance.now()
  const fresh = officialViewOf(model, options.source)
  const officialMs = elapsed(started)
  started = performance.now()
  const previous = options.cache && options.previous?.status === 'ready' ? options.previous.canonical : undefined
  const canonical = previous ? shareSections(previous, fresh) : fresh
  const reconcileMs = previous ? elapsed(started) : undefined
  started = performance.now()
  const appData = deriveAppDataFromCanonical(canonical, { now: options.now }, options.cache?.derive)
  const timings: SnapshotTimings = {
    ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}), ...(options.deltaMs !== undefined ? { deltaMs: options.deltaMs } : {}), officialMs, ...(reconcileMs !== undefined ? { reconcileMs } : {}), deriveMs: elapsed(started),
  }
  const cache = options.cache
  // The queries' results: kept by the store across snapshots, or by this snapshot alone (one computed without the store,
  // e.g. the sample's, which no other replaces): the same arguments always give the same object (React needs that).
  const queries = cache?.queries ?? new Map()
  const timeQueryContext = lazy(() => {
    // It reads the editor state, the places, the travel records and the want-to-go items (not the media).
    const inputs = [canonical.editorState, canonical.places, canonical.travel, canonical.wantToGo]
    const last = cache?.timeContext
    if (last && last.inputs.every((input, index) => input === inputs[index])) return last.value
    const begun = performance.now()
    const context = deriveTimeQueryContext(canonical)
    timings.timeContextMs = elapsed(begun)
    if (cache) cache.timeContext = { inputs, value: context }
    return context
  })
  return Object.freeze({
    status: options.status ?? 'ready',
    ...(options.error ? { error: options.error } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    revision: model.revision,
    model,
    canonical,
    appData,
    timeQueryContext,
    queries: Object.freeze({
      visiblePlaces(layerIds: readonly LayerId[], filters?: LayerTimeFilters) {
        const graph = appData.worldGraph.worldGraphSnapshot
        const filtersKey = activeFiltersKey(filters)
        // Without an active filter the time query context is not an input (a save that changes only it keeps the result).
        const context = filtersKey === undefined ? undefined : timeQueryContext()
        return cachedQuery(queries, 'visiblePlaces', [graph, JSON.stringify(layerIds), filtersKey, context], () => (filtersKey === undefined || !filters || !context
          ? queryVisiblePlaces(graph, layerIds)
          : queryVisiblePlaces(graph, layerIds, { context, filters })))
      },
      browseProjection(filters: LayerTimeFilters) {
        const context = timeQueryContext()
        return cachedQuery(queries, 'browseProjection', [context, JSON.stringify(filters)], () => buildBrowseTimeProjection(context, filters))
      },
      collection(locale: LanguageTag) {
        const graph = appData.worldGraph.worldGraphSnapshot
        return cachedQuery(queries, 'collection', [graph, locale], () => queryCollection(graph, WANT_TO_GO_LAYER_ID, locale))
      },
    }),
    timings,
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
  const started = performance.now()
  for (const { table, row } of changes.upserts) if (isReadModelTable(table)) validateRowBase(table, row)
  const model = applyReadModelDelta(snapshot.model, {
    baseRevision: changes.from,
    // applyReadModelDelta moves one revision at a time; changes over several commits (an external writer) jump.
    nextRevision: changes.to === changes.from ? changes.from : changes.from + 1,
    upserts: changes.upserts as never,
    deletes: changes.deletes as never,
  })
  const next = changes.to === model.revision ? model : { ...model, revision: changes.to }
  return computeSnapshot(next, { ...options, ...(snapshot.identity ? { identity: snapshot.identity } : {}), deltaMs: elapsed(started), startedAt: Math.round(started), previous: snapshot })
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

/** Where components read the snapshots from (../data/appStore.ts): the store, or a held source. */
export type SnapshotSource = Pick<AppStore, 'subscribe' | 'getSnapshot'>

/**
 * 3C-5 D: `store` as seen by a part of the page that is not shown (../data/appStore.ts `HoldDataWhileHidden`). While
 * `hold(true)` is on, the snapshot of that moment and no notices (its components do not render again after a save);
 * `hold(false)` goes back to the store and, when the store moved on meanwhile, tells the listeners once.
 */
export function createHeldSource(store: SnapshotSource): SnapshotSource & { hold(on: boolean): void } {
  let held: AppSnapshot | undefined
  const listeners = new Set<() => void>()
  let detach: (() => void) | undefined
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      detach ??= store.subscribe(() => {
        if (!held) notify()
      })
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          detach?.()
          detach = undefined
        }
      }
    },
    getSnapshot: () => held ?? store.getSnapshot(),
    hold(on) {
      if (on) {
        held ??= store.getSnapshot()
        return
      }
      const was = held
      held = undefined
      if (was && was !== store.getSnapshot()) notify()
    },
  }
}

export function createAppStore(initial: AppSnapshot, storeOptions: SnapshotOptions): AppStore {
  // One derivation cache for the store (3C-5 D): see SnapshotOptions.cache.
  const options: SnapshotOptions = { ...storeOptions, cache: storeOptions.cache ?? createSnapshotCache() }
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
    replace: (model: ReadModel, identity?: StoreIdentity) => publish(computeSnapshot(model, { ...options, ...(identity ? { identity } : {}), previous: snapshot })),
    apply(changes: ReadModelChanges) {
      const next = snapshotAfter(snapshot, changes, options)
      if (!next) return false
      if (next !== snapshot) publish(next)
      return true
    },
    fail: (model: ReadModel, error: AppDataLoadError) => publish(computeSnapshot(model, { ...options, status: 'error', error })),
  })
}
