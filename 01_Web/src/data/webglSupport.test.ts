/// <reference types="node" />
/**
 * The map's WebGL probe (robustness batch; ./webglSupport.ts): Cesium's rule, the context given back, the first
 * answer of a mount of the globe kept, and forgotten when it unmounts.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { CESIUM_CONTEXT_ATTRIBUTES, firstWebGLProbe, forgetFirstWebGLProbe, probeWebGL } from './webglSupport.ts'

/** A browser whose canvases answer `contexts[type]` (a context that can be given back, null, or a throw). */
function browser({ hasWebGL = true, hasWebGL2 = true, contexts = {} as Record<string, 'ok' | 'null' | 'throw'> } = {}) {
  const requests: { type: string; attributes?: Record<string, unknown> }[] = []
  let lost = 0
  const environment = {
    hasWebGL,
    hasWebGL2,
    createCanvas: () => ({
      getContext(type: string, attributes?: Record<string, unknown>) {
        requests.push({ type, attributes })
        const answer = contexts[type] ?? 'null'
        if (answer === 'throw') throw new Error('blocked')
        return answer === 'ok' ? { getExtension: (name: string) => name === 'WEBGL_lose_context' ? { loseContext: () => { lost++ } } : null } : null
      },
    }),
  }
  return { environment, requests, lost: () => lost }
}

afterEach(() => forgetFirstWebGLProbe())

test('no WebGLRenderingContext: no WebGL, nothing is asked', () => {
  const { environment, requests } = browser({ hasWebGL: false, hasWebGL2: false, contexts: { webgl: 'ok', webgl2: 'ok' } })
  assert.equal(probeWebGL(environment), false)
  assert.deepEqual(requests, [])
})

test('with WebGL 2 constructors only webgl2 counts, as for Cesium: a webgl1-only browser has no map', () => {
  const blocked = browser({ contexts: { webgl: 'ok', webgl2: 'null' } })
  assert.equal(probeWebGL(blocked.environment), false)
  assert.deepEqual(blocked.requests.map((request) => request.type), ['webgl2'])
  const thrown = browser({ contexts: { webgl2: 'throw' } })
  assert.equal(probeWebGL(thrown.environment), false)
})

test('a webgl2 context: WebGL is there, asked with Cesium\'s attributes, and given back at once', () => {
  const ok = browser({ contexts: { webgl2: 'ok' } })
  assert.equal(probeWebGL(ok.environment), true)
  assert.deepEqual(ok.requests, [{ type: 'webgl2', attributes: { ...CESIUM_CONTEXT_ATTRIBUTES } }])
  assert.equal(ok.lost(), 1)
})

test('only WebGL 1 constructors: webgl is asked, and counts', () => {
  const one = browser({ hasWebGL2: false, contexts: { webgl: 'ok' } })
  assert.equal(probeWebGL(one.environment), true)
  assert.deepEqual(one.requests.map((request) => request.type), ['webgl'])
  assert.equal(probeWebGL(browser({ hasWebGL2: false, contexts: { webgl: 'null' } }).environment), false)
})

test('a context without the lose-context extension still counts', () => {
  const environment = { hasWebGL: true, hasWebGL2: true, createCanvas: () => ({ getContext: () => ({ getExtension: () => null }) }) }
  assert.equal(probeWebGL(environment), true)
})

test('the first probe of a page is kept: StrictMode\'s second initializer call does not probe again', () => {
  let probes = 0
  const probe = () => { probes++; return false }
  assert.equal(firstWebGLProbe(probe), false)
  assert.equal(firstWebGLProbe(probe), false)
  assert.equal(probes, 1)
})

test('a later mount probes again: once the first probe is forgotten (the globe unmounted), WebGL may be gone', () => {
  let probes = 0
  let answer = true
  const probe = () => { probes++; return answer }
  assert.equal(firstWebGLProbe(probe), true)
  // The map:globe error boundary unmounts the globe; WebGL goes away (a GPU reset, say) before its Reload map.
  forgetFirstWebGLProbe()
  answer = false
  assert.equal(firstWebGLProbe(probe), false)
  assert.equal(firstWebGLProbe(probe), false)
  assert.equal(probes, 2)
})
