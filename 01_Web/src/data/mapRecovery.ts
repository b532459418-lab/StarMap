/**
 * The globe after a failure (D follow-up, the author's decision of 2026-10-29).
 *
 * The globe fails when the browser loses its WebGL context (`webglcontextlost`) or when Cesium stops rendering with an
 * error (`scene.renderError`). That viewer cannot render again: its loop stays off (`guardRenderLoop`, also against
 * the release of a save's pause, ./renderPause.ts) and the map shows a notice whose button rebuilds only the viewer.
 * When the browser gives the context back (`webglcontextrestored`), the viewer is rebuilt by itself, at most once per
 * `AUTO_REBUILD_WINDOW_MS`: a loss within that time of the loss that was rebuilt by itself keeps the notice only, until
 * the button. After the window, a loss is rebuilt by itself again.
 *
 * - `createMapRecovery(clock)`: one per globe (it outlives the viewers it rebuilds). Its methods return the new state.
 * - `guardRenderLoop(target, renders)`: the render loop target of one viewer whose loop can only be turned on while
 *   `renders()`.
 *
 * Constraint: Node 24 loads it directly (no DOM, no Cesium import); the clock can be replaced in tests.
 */
import type { RenderLoopTarget } from './renderPause.ts'

export const AUTO_REBUILD_WINDOW_MS = 2 * 60 * 1000

/** Why the viewer on the page cannot render. */
export type MapFailure = 'context-lost' | 'render-error'

export interface MapRecoveryState {
  /** Undefined while the viewer renders; the notice shows while it is set. */
  readonly failure: MapFailure | undefined
  /** The lost context is rebuilt by itself when it comes back (the first loss of its window). */
  readonly rebuildWhenRestored: boolean
}

export interface MapRecovery {
  state(): MapRecoveryState
  /** The context is lost: the event, or a frame that finds it lost before the event (the same loss counts once). */
  contextLost(): MapRecoveryState
  /** Cesium stopped rendering with an error (whatever the cause). */
  renderError(): MapRecoveryState
  /** The context is back: whether to rebuild the viewer now (at most once for a loss). */
  contextRestored(): boolean
  /** The notice's button: the viewer is rebuilt. */
  reload(): MapRecoveryState
}

export function createMapRecovery(clock: { now(): number } = { now: () => performance.now() }): MapRecovery {
  let failure: MapFailure | undefined
  let rebuildWhenRestored = false
  /** When the last loss that was to be rebuilt by itself happened. */
  let windowStart: number | undefined
  const state = (): MapRecoveryState => ({ failure, rebuildWhenRestored })
  return {
    state,
    contextLost() {
      if (failure === 'context-lost') return state()
      failure = 'context-lost'
      const now = clock.now()
      rebuildWhenRestored = windowStart === undefined || now - windowStart >= AUTO_REBUILD_WINDOW_MS
      if (rebuildWhenRestored) windowStart = now
      return state()
    },
    renderError() {
      failure ??= 'render-error'
      return state()
    },
    contextRestored() {
      if (failure !== 'context-lost' || !rebuildWhenRestored) return false
      failure = undefined
      rebuildWhenRestored = false
      return true
    },
    reload() {
      failure = undefined
      rebuildWhenRestored = false
      return state()
    },
  }
}

/** One viewer's render loop target: a pause's release (or anything else) turns its loop on only while it `renders()`. */
export function guardRenderLoop(target: RenderLoopTarget, renders: () => boolean): RenderLoopTarget {
  return {
    get useDefaultRenderLoop() { return target.useDefaultRenderLoop },
    set useDefaultRenderLoop(on: boolean) { target.useDefaultRenderLoop = on && renders() },
    isDestroyed: () => target.isDestroyed(),
  }
}
