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
 * With no renderer bound (no WebGL, so no viewer; the globe replaced by its error notice; between two viewers) there is
 * nothing to pause: a save's pause ends at once (`'no-renderer'`, 0 ms; robustness batch).
 *
 * - `pauseRendering()`: one save's pause; returns its release (idempotent). Pauses overlap (two saves): the loop starts
 *   again when the last one is released, or when the episode is ended by force (then the older releases do nothing).
 * - `bindRenderLoop(target)`: a renderer (the Cesium viewer) follows the pauses: paused, its `useDefaultRenderLoop` is
 *   false; resumed, it is what it was before (a loop Cesium stopped itself after a rendering error stays stopped).
 *   Turning the default loop off stops the automatic rendering, the canvas size updates and the clock: all start again
 *   with the loop. Unbinding (a viewer replaced or destroyed) gives the target back its loop.
 * - `renderPauseState()`: whether paused, and the last episodes (how long, what ended them), for the tests and the
 *   save-to-usable measurement; and whether the map is covered.
 *
 * A second reason, 地球被盖住时 (B2; the author's decision of 2026-11-11, spec §7): while another page covers the map
 * (Journey, Collection, the update page: the map's content hidden), the globe still draws the sky behind the page's
 * glass, but at most `COVERED_FRAME_RATE` frames a second (Cesium's `targetFrameRate`; the sky keeps moving, in real
 * time, so nothing jumps when the map comes back). At 60 frames a second the covered globe took most of the main thread
 * and about half of the GPU for a blurred sky.
 * - `coverRendering(covered)`: the globe's page says whether another page covers the map.
 * - A bound renderer follows both reasons, each on its own property: a save's pause turns `useDefaultRenderLoop` off
 *   and back, the cover sets `targetFrameRate` and puts back what was there. Neither touches what the other one
 *   changed, so they never undo each other in any order (a pause on a covered map, a cover during a pause, a page switch
 *   that ends a pause and changes the cover at once).
 *
 * Constraint: Node 24 loads it directly (no DOM, no Cesium import); the timers can be replaced in tests.
 */

export const RENDER_PAUSE_LIMIT_MS = 1500
/** The globe's frames a second while another page covers the map. */
export const COVERED_FRAME_RATE = 10

/** What ended a pause. */
export type RenderPauseEnd = 'applied' | 'failed' | 'released' | 'limit' | 'hidden' | 'page' | 'unmount' | 'no-renderer'

export interface RenderPauseEpisode {
  readonly pausedMs: number
  readonly endedBy: RenderPauseEnd
}

export interface RenderLoopTarget {
  useDefaultRenderLoop: boolean
  /** Cesium's cap of frames a second (`Viewer.targetFrameRate`); undefined is no cap. */
  targetFrameRate?: number | undefined
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
/** Renderers bound now (`bindRenderLoop`). */
let renderers = 0
let covered = false
const coverListeners = new Set<(covered: boolean) => void>()

function record(episodeRecord: RenderPauseEpisode) {
  episodes.push(episodeRecord)
  if (episodes.length > EPISODES_KEPT) episodes.splice(0, episodes.length - EPISODES_KEPT)
}

function end(endedBy: RenderPauseEnd) {
  if (pausedSince === undefined) return
  clock.clearTimeout(watchdog)
  watchdog = undefined
  record({ pausedMs: Math.round((clock.now() - pausedSince) * 10) / 10, endedBy })
  pausedSince = undefined
  count = 0
  episode++
  for (const listener of [...listeners]) listener(false)
}

/** One save's pause of the globe's render loop; the returned release (idempotent) ends it. */
export function pauseRendering(): (endedBy?: RenderPauseEnd) => void {
  // Nothing renders: there is nothing to pause, and the pause ends at once.
  if (renderers === 0) {
    record({ pausedMs: 0, endedBy: 'no-renderer' })
    return () => undefined
  }
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

/** Another page covers the map, or no longer does (地球被盖住时; see the module comment). */
export function coverRendering(isCovered: boolean): void {
  if (covered === isCovered) return
  covered = isCovered
  for (const listener of [...coverListeners]) listener(covered)
}

/**
 * A renderer follows the pauses and the cover (see the module comment); the returned unbind gives it back its loop and
 * its frame cap.
 */
export function bindRenderLoop(target: RenderLoopTarget): () => void {
  renderers++
  let bound = true
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
  // The cap there was before the cover (boxed: undefined, no cap, is a value too).
  let rateBefore: { readonly value: number | undefined } | undefined
  const followCover = (isCovered: boolean) => {
    if (target.isDestroyed()) return
    if (isCovered) {
      if (rateBefore !== undefined) return
      rateBefore = { value: target.targetFrameRate }
      target.targetFrameRate = COVERED_FRAME_RATE
    } else if (rateBefore !== undefined) {
      target.targetFrameRate = rateBefore.value
      rateBefore = undefined
    }
  }
  const unsubscribe = subscribeRenderPause(follow)
  coverListeners.add(followCover)
  followCover(covered)
  return () => {
    if (bound) { bound = false; renderers-- }
    unsubscribe()
    coverListeners.delete(followCover)
    follow(false)
    followCover(false)
  }
}

export function renderPauseState(): { readonly paused: boolean; readonly count: number; readonly episodes: readonly RenderPauseEpisode[]; readonly covered: boolean } {
  return { paused: pausedSince !== undefined, count, episodes: [...episodes], covered }
}

/** Tests: another clock (fake timers), and a clean state. */
export function resetRenderPauseForTests(testClock: Clock = realClock): void {
  end('released')
  clock = testClock
  episodes.length = 0
  listeners.clear()
  renderers = 0
  covered = false
  coverListeners.clear()
}
