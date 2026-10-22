/**
 * The App's data store on the page (3C-5 sub-batch D, design §1 and §4): the one place components read data from.
 *
 * - The snapshot (./appStoreCore.ts): read model, official view, the derived data of the six data modules, the time
 *   query context. Components read it only through hooks (`useAppSnapshot`, `useAppData` and the hooks of the six data
 *   modules, e.g. ../data/travelAtlas.ts `useTravelAtlas`), never as module constants, so `react-hooks/exhaustive-deps`
 *   sees every dependency on data and a component cannot keep a stale copy. Components never import this module's
 *   `appStore` itself (eslint: no-restricted-imports in src/components and App.tsx).
 * - Loading (no top-level await since D): the public sample (and forced sample) is in the bundle, so the snapshot is
 *   ready at once. Private data is fetched when this module loads (./rawInputs.ts `loadAppReadModel`); until then the
 *   snapshot is `loading` and ../main.tsx shows a loading page; a failure is `error` with an empty read model and the
 *   reason (../components/DataLoadError.tsx).
 * - `storeBaseRevision()`: the revision of the data the page shows, for the editor's writes (undefined when the page
 *   does not write to a library).
 */
import { createContext, createElement, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { computeSnapshot, createAppStore, createHeldSource, type AppSnapshot, type SnapshotSource } from './appStoreCore.ts'
export type { AppSnapshot } from './appStoreCore.ts'
import { appDataSource, loadAppReadModel, sampleReadModel, sessionNow, storeModuleRevision, usesSampleData } from './rawInputs.ts'
import { readModelOf } from '../worldgraph/readModel/build.ts'
import { emptyFormalState } from '../worldgraph/store/formal.ts'

const options = { source: appDataSource, now: sessionNow } as const

export const appStore = createAppStore(
  usesSampleData
    ? computeSnapshot(sampleReadModel(), options)
    : computeSnapshot(readModelOf(emptyFormalState(), { origin: 'local' }), { ...options, status: 'loading' }),
  options,
)

if (!usesSampleData) {
  void loadAppReadModel().then(({ model, identity, error }) => {
    if (error) appStore.fail(model, error)
    else appStore.replace(model, identity)
  })
}

/** Where the hooks read the snapshots: the store, or a part of the page that is not shown (`HoldDataWhileHidden`). */
const SnapshotSourceContext = createContext<SnapshotSource>(appStore)

/**
 * 3C-5 D: a part of the page that is not shown (a page behind another one, the map's panels behind a page) reads, through
 * the hooks, the data it had when it was hidden: it does not render again after every save. When it is shown again, it
 * takes the latest data (before the browser paints). It stays mounted, so its own state (scroll position, filters,
 * open drafts) is kept. Its parent holds the values it passes down (../components/PausedWhileHidden.tsx skips the
 * renders, ../components/useHeldWhileHidden.ts holds one value).
 */
export function HoldDataWhileHidden({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [source] = useState(() => createHeldSource(appStore))
  useLayoutEffect(() => source.hold(!visible), [source, visible])
  return createElement(SnapshotSourceContext, { value: source }, children)
}

/** The whole snapshot (status, revision, read model, official view, derived data). */
export function useAppSnapshot(): AppSnapshot {
  const source = useContext(SnapshotSourceContext)
  return useSyncExternalStore(source.subscribe, source.getSnapshot)
}

/**
 * A part of the snapshot: the component renders again only when `selector` gives another value (Object.is). The data
 * store keeps the identity of what a save did not change (./appStoreCore.ts: shared sections of the official view, the
 * derivation steps it did not have to run again), so a selector of an unchanged part keeps its value. `selector` must
 * give the same value for the same snapshot (a part of it, or a primitive), never a new object each time.
 */
export function useAppSelector<T>(selector: (snapshot: AppSnapshot) => T): T {
  const source = useContext(SnapshotSourceContext)
  return useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
}

/** The derived data of the six data modules (all of them: renders again after every change; prefer a section). */
export const useAppData = () => useAppSnapshot().appData

const selectSection = <K extends keyof AppSnapshot['appData']>(key: K) => (snapshot: AppSnapshot) => snapshot.appData[key]
const selectors = {
  travelAtlas: selectSection('travelAtlas'),
  editorState: selectSection('editorState'),
  mediaCatalog: selectSection('mediaCatalog'),
  droneMedia: selectSection('droneMedia'),
  wantToGo: selectSection('wantToGo'),
  worldGraph: selectSection('worldGraph'),
}
/** One section of the derived data (the six data modules' hooks): renders again only when that section changed. */
export const useAppSection = <K extends keyof typeof selectors>(key: K): AppSnapshot['appData'][K] => useAppSelector(selectors[key] as (snapshot: AppSnapshot) => AppSnapshot['appData'][K])

const selectTimeQueryContext = (snapshot: AppSnapshot) => snapshot.timeQueryContext()
/** The time query context of the data on the page (computed the first time it is asked for; kept while its inputs are). */
export const useTimeQueryContext = () => useAppSelector(selectTimeQueryContext)

/**
 * The store revision of the data the page shows, for the editor's writes (`x-starmap-base-revision`): undefined when the
 * page does not write to a library (the sample, a private root that is not a library yet). When the read model could
 * not be loaded, the module's revision (as before D).
 */
export function storeBaseRevision(): number | undefined {
  if (storeModuleRevision === undefined) return undefined
  const snapshot = appStore.getSnapshot()
  return snapshot.status === 'ready' ? snapshot.revision : storeModuleRevision
}
