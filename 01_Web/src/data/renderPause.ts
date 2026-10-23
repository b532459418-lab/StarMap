/**
 * The map pauses while a save is in flight (3C-5 D, A′; spec §8, the author's decision of 2026-10-23).
 *
 * The globe renders continuously (the sky moves), which takes most of the page's main thread; a save's answer, the
 * applying of its changes and React's render then wait between frames. So a save pauses the globe's render loop from
 * the click until the first of:
 * - its changes are applied to the page's data (the write's `onApplied`, ./localEditorApi.ts),
 * - it fails, is refused or its outcome is unknown (the first failed try),
 * - `RENDER_PAUSE_LIMIT_MS` (the watchdog: whatever the save does),
 * - the page is hidden, another page is shown, or the globe unmounts (`resumeRendering`).
 * The loop starts again before the page waits for its next frame (it never waits for a paused loop).
 *
 * - `pauseRendering()`: one save's pause; returns its release (idempotent). Pauses overlap (two saves): the loop starts
 *   again when the last one is released, or when the episode is ended by force (then the older releases do nothing).
 * - `bindRenderLoop(target)`: a renderer (the Cesium viewer) follows the pauses: paused, its `useDefaultRenderLoop` is
 *   false; resumed, it is what it was before (a loop Cesium stopped itself after a rendering error stays stopped).
 *   Turning the default loop off stops the automatic rendering, the canvas size updates and the clock: all start again
 *   with the loop. Unbinding (a viewer replaced or destroyed) gives the target back its loop.
 * - `renderPauseState()`: whether paused, and the last episodes (how long, what ended them), for the tests and the
 *   save-to-usable measurement.
 *
 * Constraint: Node 24 loads it directly (no DOM, no Cesium import); the timers can be replaced in tests.
 */

export const RENDER_PAUSE_LIMIT_MS = 1500

/** What ended a pause. */
export type RenderPauseEnd = 'applied' | 'failed' | 'released' | 'limit' | 'hidden' | 'page' | 'unmount'

export interface RenderPauseEpisode {
  readonly pausedMs: number
  readonly endedBy: RenderPauseEnd
}

export interface RenderLoopTarget {
  useDefaultRenderLoop: boolean
  isDestroyed(): boolean
}

interface Clock {
  now(): number
  setTimeout(work: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (work, ms) => {
    const handle = setTimeout(work, ms)
    // Node (tests of the write path): a pending watchdog does not keep the process alive.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const EPISODES_KEPT = 50

let clock = realClock
let count = 0
/** The current episode's number: a release of an earlier episode (ended by force) does nothing. */
let episode = 0
let pausedSince: number | undefined
let watchdog: unknown
const listeners = new Set<(paused: boolean) => void>()
const episodes: RenderPauseEpisode[] = []

function end(endedBy: RenderPauseEnd) {
  if (pausedSince === undefined) return
  clock.clearTimeout(watchdog)
  watchdog = undefined
  episodes.push({ pausedMs: Math.round((clock.now() - pausedSince) * 10) / 10, endedBy })
  if (episodes.length > EPISODES_KEPT) episodes.splice(0, episodes.length - EPISODES_KEPT)
  pausedSince = undefined
  count = 0
  episode++
  for (const listener of [...listeners]) listener(false)
}

/** One save's pause of the globe's render loop; the returned release (idempotent) ends it. */
export function pauseRendering(): (endedBy?: RenderPauseEnd) => void {
  if (count === 0) {
    pausedSince = clock.now()
    watchdog = clock.setTimeout(() => end('limit'), RENDER_PAUSE_LIMIT_MS)
    for (const listener of [...listeners]) listener(true)
  }
  count++
  const mine = episode
  let released = false
  return (endedBy = 'released') => {
    if (released) return
    released = true
    if (mine !== episode) return
    count--
    if (count === 0) end(endedBy)
  }
}

/** End the current pause now (the page is hidden, another page is shown, the globe unmounts). */
export function resumeRendering(endedBy: RenderPauseEnd): void {
  end(endedBy)
}

/** Listen to the pauses; the listener hears the current state at once. */
export function subscribeRenderPause(listener: (paused: boolean) => void): () => void {
  listeners.add(listener)
  listener(pausedSince !== undefined)
  return () => { listeners.delete(listener) }
}

/** A renderer follows the pauses (see the module comment); the returned unbind gives it back its loop. */
export function bindRenderLoop(target: RenderLoopTarget): () => void {
  let before: boolean | undefined
  const follow = (paused: boolean) => {
    if (target.isDestroyed()) return
    if (paused) {
      if (before !== undefined) return
      before = target.useDefaultRenderLoop
      target.useDefaultRenderLoop = false
    } else if (before !== undefined) {
      target.useDefaultRenderLoop = before
      before = undefined
    }
  }
  const unsubscribe = subscribeRenderPause(follow)
  return () => {
    unsubscribe()
    follow(false)
  }
}

export function renderPauseState(): { readonly paused: boolean; readonly count: number; readonly episodes: readonly RenderPauseEpisode[] } {
  return { paused: pausedSince !== undefined, count, episodes: [...episodes] }
}

/** Tests: another clock (fake timers), and a clean state. */
export function resetRenderPauseForTests(testClock: Clock = realClock): void {
  end('released')
  clock = testClock
  episodes.length = 0
  listeners.clear()
}
