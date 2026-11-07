/**
 * Whether the map can have a viewer: WebGL, decided before the viewer is created (robustness batch, design §4.1).
 *
 * Without WebGL, Cesium throws while the viewer is constructed, inside resium's asynchronous creation, where no error
 * boundary can catch it: the page keeps an empty canvas and nothing says why (design §1.4). So the map probes first,
 * with Cesium's own rule (`getWebGLContext`, @cesium/engine/Source/Renderer/Context.js): no WebGLRenderingContext → no;
 * with a WebGL2RenderingContext constructor only a `webgl2` context counts (Cesium does not fall back to WebGL 1, so a
 * browser that blocks WebGL 2 alone fails there too), otherwise `webgl`; Cesium's context attributes. The context it
 * gets is given back at once (WEBGL_lose_context), so it does not count against the browser's live contexts.
 *
 * - `probeWebGL(environment)`: one probe.
 * - `firstWebGLProbe(probe)`: the first viewer's answer, probed once per mount of the globe (StrictMode calls a state
 *   initializer twice; the review's decision). `forgetFirstWebGLProbe()`: the globe forgets it when it unmounts, so a
 *   later mount (after the map:globe error boundary's Reload map) probes again: WebGL may be gone by then (test
 *   stability follow-ups G6). A rebuilt viewer and the notice's 「再试一次」 probe again (`probeWebGL`).
 *
 * Constraint: Node 24 loads it directly (no DOM, no `import.meta`); the browser is passed in.
 */

/** What the probe needs from the browser. */
export interface WebGLEnvironment {
  readonly hasWebGL: boolean
  readonly hasWebGL2: boolean
  createCanvas(): { getContext(type: string, attributes?: Record<string, unknown>): unknown }
}

/** Cesium's defaults for the attributes it changes (Context.js: alpha false, stencil true, high-performance). */
export const CESIUM_CONTEXT_ATTRIBUTES = Object.freeze({ alpha: false, stencil: true, powerPreference: 'high-performance' })

type LosableContext = { getExtension?: (name: string) => { loseContext?: () => void } | null }

/** Whether Cesium would get a WebGL context in this browser. */
export function probeWebGL(environment: WebGLEnvironment): boolean {
  if (!environment.hasWebGL) return false
  let context: unknown
  try {
    context = environment.createCanvas().getContext(environment.hasWebGL2 ? 'webgl2' : 'webgl', { ...CESIUM_CONTEXT_ATTRIBUTES })
  } catch {
    return false
  }
  if (!context) return false
  try { (context as LosableContext).getExtension?.('WEBGL_lose_context')?.loseContext?.() } catch { /* given back or not, WebGL is there */ }
  return true
}

/** The browser's environment (a fresh, detached canvas for each probe). */
export function browserWebGLEnvironment(): WebGLEnvironment {
  return {
    hasWebGL: typeof WebGLRenderingContext !== 'undefined',
    hasWebGL2: typeof WebGL2RenderingContext !== 'undefined',
    createCanvas: () => document.createElement('canvas'),
  }
}

let first: boolean | undefined

/** The first probe of this mount of the globe, kept (later calls return it without probing). */
export function firstWebGLProbe(probe: () => boolean = () => probeWebGL(browserWebGLEnvironment())): boolean {
  first ??= probe()
  return first
}

/** Forget the first probe: the next `firstWebGLProbe` probes again (the globe unmounted; tests). */
export function forgetFirstWebGLProbe(): void {
  first = undefined
}
