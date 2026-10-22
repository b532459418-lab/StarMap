/**
 * Keeping the page's data current without reloading it (3C-5 sub-batch D, design §3): the client side of the change log
 * of the dev server (scripts/store-change-log.mjs).
 *
 * - `applySaved(result)`: after one of this page's writes, its answer's `delta` (the commit's changed rows) is applied
 *   to the data store (./appStoreCore.ts); when it does not follow the page's revision (the push of the same commit
 *   came first, or a commit of another page came between), the changes are fetched by revision instead.
 * - `pull()`: GET …/read-model/changes?since=<revision>&libraryId=…&restoreMark=…; the entries are applied in order. A
 *   410 (the dev server restarted, the library was replaced or restored, the page is too far behind) or changes that do
 *   not apply read the whole read model again (`loadWhole`). The page is never reloaded.
 * - `revisionPushed(data)`: the plugin's `starmap:revision` { libraryId, restoreMark, revision }. A revision the page
 *   already has is ignored; anything else is fetched (and a push of another library ends in a 410, i.e. a whole read).
 *   Pushes can arrive late, twice or out of order: every fetch starts from the revision the page actually has.
 * - Everything that changes the data runs one at a time (one queue), so applying is never interleaved.
 * - `waitForServer()`: resolves once the dev server answers again (polled), or after `timeoutMs`; the write path waits
 *   on it before its last try of a request whose outcome is unknown.
 *
 * Loaded only behind the local editor's gate (./localEditorClient.ts, `import.meta.env.DEV && localEditorAvailable`), so
 * no build contains it. Constraint: Node 24 loads it directly (tests).
 */
import type { AppStore, ReadModelChanges, StoreIdentity } from './appStoreCore.ts'
import type { ReadModel } from '../worldgraph/readModel/types.ts'

export const READ_MODEL_CHANGES_PATH = '/__travelatlas/editor/read-model/changes'

export interface StoreSyncDeps {
  readonly store: AppStore
  /** The whole read model again (the dev server's endpoint), or undefined when it cannot be read now. */
  readonly loadWhole: () => Promise<{ readonly model: ReadModel; readonly identity?: StoreIdentity } | undefined>
  readonly fetch?: typeof fetch
  /** How long `waitForServer` waits at most, and how often it asks. */
  readonly timeoutMs?: number
  readonly pollMs?: number
}

export interface StoreSync {
  applySaved(result: unknown): Promise<void>
  pull(): Promise<void>
  revisionPushed(data: unknown): Promise<void>
  waitForServer(): Promise<void>
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createStoreSync({ store, loadWhole, fetch: fetchImpl = (...args) => fetch(...args), timeoutMs = 30_000, pollMs = 1000 }: StoreSyncDeps): StoreSync {
  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  const readWhole = async () => {
    const loaded = await loadWhole()
    if (loaded) store.replace(loaded.model, loaded.identity)
  }

  const changesUrl = () => {
    const snapshot = store.getSnapshot()
    const query = new URLSearchParams({ since: String(snapshot.revision) })
    if (snapshot.identity) {
      query.set('libraryId', snapshot.identity.libraryId)
      query.set('restoreMark', snapshot.identity.restoreMark ?? '')
    }
    return `${READ_MODEL_CHANGES_PATH}?${query}`
  }

  const pullNow = async () => {
    if (store.getSnapshot().status !== 'ready') return
    const response = await fetchImpl(changesUrl(), { cache: 'no-store' })
    if (response.status === 410) return readWhole()
    if (!response.ok) throw new Error(`The changes of the library could not be read (HTTP ${response.status}).`)
    const body: unknown = await response.json()
    const deltas = plain(body) && Array.isArray(body.deltas) ? body.deltas as ReadModelChanges[] : undefined
    if (!deltas) return readWhole()
    for (const delta of deltas) {
      let applied: boolean
      try { applied = store.apply(delta) } catch { applied = false }
      if (!applied) return readWhole()
    }
  }

  return {
    applySaved: (result) => serially(async () => {
      if (!plain(result)) return
      const delta = plain(result.delta) ? result.delta as unknown as ReadModelChanges : undefined
      if (delta) {
        try { if (store.apply(delta)) return } catch { /* Not this page's next changes: fetched below. */ }
      }
      if (typeof result.revision === 'number' && result.revision !== store.getSnapshot().revision) await pullNow()
    }),
    pull: () => serially(pullNow),
    revisionPushed: (data) => serially(async () => {
      if (!plain(data) || typeof data.revision !== 'number') return
      const snapshot = store.getSnapshot()
      const sameLibrary = !snapshot.identity
        || (snapshot.identity.libraryId === data.libraryId && snapshot.identity.restoreMark === (data.restoreMark ?? null))
      if (sameLibrary && data.revision <= snapshot.revision) return
      await pullNow()
    }),
    async waitForServer() {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const response = await fetchImpl(changesUrl(), { cache: 'no-store' })
          if (response.status < 500) return
        } catch { /* Not answering yet. */ }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    },
  }
}

/** The part of Vite's `import.meta.hot` the page listens with. */
export interface DevServerEvents {
  on(event: string, listener: (data: unknown) => void): void
}

/**
 * Listen to the dev server (Vite's HMR connection) and the window: a pushed revision, a reconnected server, the window
 * shown or focused again — each one fetches what changed (missed or late pushes are caught up the same way).
 */
export function listenToDevServer(sync: StoreSync, hot: DevServerEvents | undefined, target: { addEventListener: typeof window.addEventListener; document?: Document } = window) {
  const pull = () => { void sync.pull().catch(() => undefined) }
  hot?.on('starmap:revision', (data) => { void sync.revisionPushed(data).catch(() => undefined) })
  hot?.on('vite:ws:connect', pull)
  const doc = target.document ?? (typeof document === 'undefined' ? undefined : document)
  doc?.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') pull() })
  target.addEventListener('focus', pull)
}
