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
import { useSyncExternalStore } from 'react'
import { computeSnapshot, createAppStore, type AppSnapshot } from './appStoreCore.ts'
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
  void loadAppReadModel().then(({ model, error }) => {
    if (error) appStore.fail(model, error)
    else appStore.replace(model)
  })
}

/** The whole snapshot (status, revision, read model, official view, derived data). */
export function useAppSnapshot(): AppSnapshot {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot)
}

/** The derived data of the six data modules. */
export const useAppData = () => useAppSnapshot().appData

/** The time query context of the data on the page (computed the first time it is asked for). */
export const useTimeQueryContext = () => useAppSnapshot().timeQueryContext()

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
