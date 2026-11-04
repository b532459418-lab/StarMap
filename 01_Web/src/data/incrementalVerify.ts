/**
 * ③ (scope-incremental; the author's decision of 2026-11-04): in the browser tests only, every snapshot the data store moved
 * on by a commit's changed rows is compared with the snapshot computed again from its whole read model.
 *
 * - Where: the browser tests' dev server sets `VITE_STARMAP_INCREMENTAL_VERIFY=1` (playwright.config.mjs); ./appStore.ts
 *   loads this module only behind `import.meta.env.DEV` and that variable, so no build contains it, and the daily
 *   `dev:personal` and the save-latency measurement do not run it.
 * - When: after the save, in an idle callback (at most a second later), once the page has rendered the new data and the
 *   map's loop runs again: never on the save's path, so it adds nothing to the time from the click to the result.
 * - What: the official view's sections, the six sections of the derived data and the time query context, as text in
 *   insertion order (`orderedText`: keys in their order, Maps and Sets by their entries, functions as a marker).
 * - A difference is thrown as an uncaught error of the page that names the parts; the browser tests' page fixture
 *   (tests/browser/helpers.mjs) fails a case on any page error.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import { computeSnapshot, type AppSnapshot, type SnapshotOptions, type SnapshotSource } from './appStoreCore.ts'

/** The value as text in insertion order (see the file header): equal texts are equal values byte for byte. */
export function orderedText(value: unknown): string {
  const path = new Set<object>()
  const walk = (v: unknown): string => {
    if (v === undefined) return 'undefined'
    if (v === null || typeof v === 'boolean') return String(v)
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'function') return '[function]'
    if (typeof v !== 'object') return `[${typeof v}]`
    if (path.has(v)) throw new Error('orderedText: a cycle')
    path.add(v)
    try {
      if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`
      if (v instanceof Map) return `Map{${[...v].map(([key, member]) => `${walk(key)}=>${walk(member)}`).join(',')}}`
      if (v instanceof Set) return `Set{${[...v].map(walk).join(',')}}`
      const proto = Object.getPrototypeOf(v)
      const kind = proto === Object.prototype || proto === null ? '' : `${proto.constructor?.name ?? '?'}`
      return `${kind}{${Object.keys(v).map((key) => `${JSON.stringify(key)}:${walk((v as Record<string, unknown>)[key])}`).join(',')}}`
    } finally {
      path.delete(v)
    }
  }
  return walk(value)
}

/** The parts of `snapshot` whose values differ from `full`, the same read model computed alone. */
export function differingParts(snapshot: AppSnapshot, full: AppSnapshot): string[] {
  const parts: string[] = []
  for (const key of Object.keys(full.canonical) as (keyof AppSnapshot['canonical'])[]) {
    if (orderedText(snapshot.canonical[key]) !== orderedText(full.canonical[key])) parts.push(`official view ${key}`)
  }
  for (const key of Object.keys(full.appData) as (keyof AppSnapshot['appData'])[]) {
    if (orderedText(snapshot.appData[key]) !== orderedText(full.appData[key])) parts.push(`derived data ${key}`)
  }
  if (orderedText(snapshot.timeQueryContext()) !== orderedText(full.timeQueryContext())) parts.push('time query context')
  return parts
}

/** Runs `work` when the page is idle (at most a second later). */
const whenIdle = (work: () => void) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 1000 })
  else setTimeout(work, 0)
}

/**
 * Compare every snapshot of `store` moved on by changed rows (it has `timings.deltaMs`) with the whole computation of its
 * read model, `schedule`d after the save (see the file header); a difference throws there. Returns the unsubscribe.
 */
export function verifyIncrementalSnapshots(store: SnapshotSource, options: Pick<SnapshotOptions, 'source' | 'now'>, schedule: (work: () => void) => void = whenIdle): () => void {
  let last = store.getSnapshot()
  return store.subscribe(() => {
    const snapshot = store.getSnapshot()
    if (snapshot === last) return
    last = snapshot
    if (snapshot.status !== 'ready' || snapshot.timings.deltaMs === undefined) return
    schedule(() => {
      const parts = differingParts(snapshot, computeSnapshot(snapshot.model, { source: options.source, now: options.now }))
      if (parts.length) {
        throw new Error(`③ incremental refresh: revision ${snapshot.revision} (sections ${snapshot.timings.officialSections ?? '?'}) differs from the whole computation in ${parts.join(', ')}`)
      }
    })
  })
}
