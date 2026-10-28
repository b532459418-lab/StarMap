/// <reference types="node" />
/**
 * The globe after a failure (./mapRecovery.ts): a lost context or a render error shows the notice, the context coming
 * back rebuilds the viewer once per window, a second loss within the window waits for the button, and a failed
 * viewer's loop stays off even when a save's pause (./renderPause.ts) ends.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_REBUILD_WINDOW_MS, createMapRecovery, guardRenderLoop } from './mapRecovery.ts'
import { bindRenderLoop, pauseRendering, resetRenderPauseForTests } from './renderPause.ts'

function fakeClock() {
  let now = 0
  return { now: () => now, advance(ms: number) { now += ms } }
}

test('a lost context shows the notice; the context coming back rebuilds the viewer once', () => {
  const clock = fakeClock()
  const recovery = createMapRecovery(clock)
  assert.deepEqual(recovery.state(), { failure: undefined, rebuildWhenRestored: false })
  assert.deepEqual(recovery.contextLost(), { failure: 'context-lost', rebuildWhenRestored: true })
  // A frame that found the context lost before its event: the same loss.
  clock.advance(5)
  assert.deepEqual(recovery.contextLost(), { failure: 'context-lost', rebuildWhenRestored: true })
  assert.equal(recovery.contextRestored(), true)
  assert.deepEqual(recovery.state(), { failure: undefined, rebuildWhenRestored: false })
  assert.equal(recovery.contextRestored(), false, 'once')
})

test('a second loss within the window shows the notice only; the button rebuilds the viewer', () => {
  const clock = fakeClock()
  const recovery = createMapRecovery(clock)
  recovery.contextLost()
  assert.equal(recovery.contextRestored(), true)
  clock.advance(AUTO_REBUILD_WINDOW_MS - 1)
  assert.deepEqual(recovery.contextLost(), { failure: 'context-lost', rebuildWhenRestored: false })
  assert.equal(recovery.contextRestored(), false)
  assert.equal(recovery.state().failure, 'context-lost', 'the notice stays')
  assert.deepEqual(recovery.reload(), { failure: undefined, rebuildWhenRestored: false })
})

test('after the window the count starts again: a loss is rebuilt by itself', () => {
  const clock = fakeClock()
  const recovery = createMapRecovery(clock)
  recovery.contextLost()
  recovery.contextRestored()
  clock.advance(60_000)
  recovery.contextLost()
  recovery.reload()
  // The window runs from the loss that was rebuilt by itself (at 0), not from the second one.
  clock.advance(AUTO_REBUILD_WINDOW_MS - 60_000)
  assert.equal(recovery.contextLost().rebuildWhenRestored, true)
  assert.equal(recovery.contextRestored(), true)
  // A new window from that loss.
  clock.advance(1000)
  assert.equal(recovery.contextLost().rebuildWhenRestored, false)
})

test('a render error shows the notice; it is not rebuilt by itself, the button rebuilds it', () => {
  const recovery = createMapRecovery(fakeClock())
  assert.deepEqual(recovery.renderError(), { failure: 'render-error', rebuildWhenRestored: false })
  assert.equal(recovery.contextRestored(), false)
  assert.equal(recovery.state().failure, 'render-error')
  assert.equal(recovery.reload().failure, undefined)
})

test('a render error and a lost context: the loss decides (a frame on the lost context before its event)', () => {
  const recovery = createMapRecovery(fakeClock())
  recovery.renderError()
  assert.deepEqual(recovery.contextLost(), { failure: 'context-lost', rebuildWhenRestored: true })
  assert.equal(recovery.renderError().failure, 'context-lost')
  assert.equal(recovery.contextRestored(), true)
})

test('the button before the context comes back: the restored context of the replaced viewer rebuilds nothing', () => {
  const recovery = createMapRecovery(fakeClock())
  recovery.contextLost()
  recovery.reload()
  assert.equal(recovery.contextRestored(), false)
})

test('the default clock is the page clock', () => {
  const recovery = createMapRecovery()
  assert.equal(recovery.contextLost().rebuildWhenRestored, true)
})

/** A renderer with a default loop, like Cesium's widget. */
function renderer() {
  let destroyed = false
  return { useDefaultRenderLoop: true, isDestroyed: () => destroyed, destroy() { destroyed = true } }
}

beforeEach(() => resetRenderPauseForTests({ now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined }))
afterEach(() => resetRenderPauseForTests())

test('a failed viewer stays off when a save\'s pause ends (A′ gives back the loop it had before the pause)', () => {
  const map = renderer()
  let failed = false
  const unbind = bindRenderLoop(guardRenderLoop(map, () => !failed))
  const release = pauseRendering()
  assert.equal(map.useDefaultRenderLoop, false)
  // Lost during the pause: the app stops the loop (it is off already).
  failed = true
  map.useDefaultRenderLoop = false
  release('applied')
  assert.equal(map.useDefaultRenderLoop, false, 'the release does not turn it back on')
  unbind()
  assert.equal(map.useDefaultRenderLoop, false, 'nor does the unbinding')
})

test('a viewer that renders follows the pauses through the guard as before', () => {
  const map = renderer()
  const unbind = bindRenderLoop(guardRenderLoop(map, () => true))
  const release = pauseRendering()
  assert.equal(map.useDefaultRenderLoop, false)
  release('applied')
  assert.equal(map.useDefaultRenderLoop, true)
  map.destroy()
  const guarded = guardRenderLoop(map, () => true)
  assert.equal(guarded.isDestroyed(), true)
  unbind()
})
