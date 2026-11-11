/// <reference types="node" />
/**
 * The map's pause during a save (3C-5 D, A′; ./renderPause.ts): a renderer's loop is off from the click until the
 * changes are applied, a failure, the watchdog or a forced end, and it then renders again (its frames go on); a loop
 * Cesium had stopped stays stopped; overlapping saves, a replaced or destroyed renderer. And the write path
 * (./localEditorApi.ts) ends the pause in every outcome. The second reason, a map covered by another page (地球被盖住时,
 * B2): the frame cap, in every order with a save's pause, on a renderer bound before or during it, and on a failed
 * viewer's guarded target (./mapRecovery.ts).
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { bindRenderLoop, COVERED_FRAME_RATE, coverRendering, pauseRendering, RENDER_PAUSE_LIMIT_MS, renderPauseState, resetRenderPauseForTests, resumeRendering, subscribeRenderPause } from './renderPause.ts'
import { setLocalEditorStoreSync, updateLocalWantToGo, type LocalEditorStoreSync } from './localEditorApi.ts'
import { guardRenderLoop } from './mapRecovery.ts'

/** A clock whose time and timers the test moves. */
function fakeClock() {
  let now = 0
  let timers: { at: number; work: () => void; id: number }[] = []
  let ids = 0
  return {
    now: () => now,
    setTimeout: (work: () => void, ms: number) => { const id = ++ids; timers.push({ at: now + ms, work, id }); return id },
    clearTimeout: (id: unknown) => { timers = timers.filter((timer) => timer.id !== id) },
    advance(ms: number) {
      now += ms
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers = timers.filter((candidate) => candidate !== timer)
        timer.work()
      }
    },
  }
}

/** A renderer with a default loop: each tick renders a frame while the loop is on (like Cesium's widget). */
function renderer(loop = true, targetFrameRate: number | undefined = undefined) {
  let destroyed = false
  const target = {
    useDefaultRenderLoop: loop,
    targetFrameRate,
    frames: 0,
    isDestroyed: () => destroyed,
    destroy() { destroyed = true },
    tick(count = 3) { for (let n = 0; n < count; n++) if (target.useDefaultRenderLoop && !destroyed) target.frames++ },
  }
  return target
}

let clock: ReturnType<typeof fakeClock>
beforeEach(() => { clock = fakeClock(); resetRenderPauseForTests(clock) })
afterEach(() => resetRenderPauseForTests())

const lastEpisode = () => renderPauseState().episodes.at(-1)

test('no renderer bound (no WebGL, the globe replaced by its notice): a save\'s pause ends at once, nobody is told', () => {
  const heard: boolean[] = []
  subscribeRenderPause((paused) => { heard.push(paused) })
  heard.length = 0
  const release = pauseRendering()
  assert.equal(renderPauseState().paused, false)
  assert.deepEqual(lastEpisode(), { pausedMs: 0, endedBy: 'no-renderer' })
  assert.deepEqual(heard, [], 'no listener hears a pause')
  clock.advance(RENDER_PAUSE_LIMIT_MS + 1)
  release('applied')
  assert.equal(renderPauseState().episodes.length, 1, 'neither the watchdog nor the release adds an episode')
})

test('a renderer bound, then unbound: pauses work while it is bound and end at once after', () => {
  const map = renderer()
  const unbind = bindRenderLoop(map)
  const release = pauseRendering()
  assert.equal(map.useDefaultRenderLoop, false)
  release('applied')
  assert.equal(lastEpisode()?.endedBy, 'applied')
  unbind()
  unbind()
  pauseRendering()
  assert.deepEqual(lastEpisode(), { pausedMs: 0, endedBy: 'no-renderer' })
  // Bound again (a rebuilt viewer): paused again.
  const next = renderer()
  bindRenderLoop(next)
  const again = pauseRendering()
  assert.equal(next.useDefaultRenderLoop, false)
  again()
  assert.equal(next.useDefaultRenderLoop, true)
})

test('a save pauses the loop until its changes are applied; then the frames go on (the release is idempotent)', () => {
  const map = renderer()
  bindRenderLoop(map)
  map.tick()
  const release = pauseRendering()
  assert.equal(map.useDefaultRenderLoop, false)
  const paused = map.frames
  map.tick()
  assert.equal(map.frames, paused, 'no frame while paused')
  clock.advance(120)
  release('applied')
  release('failed')
  assert.equal(map.useDefaultRenderLoop, true)
  map.tick()
  assert.ok(map.frames > paused, 'frames again after the resume')
  assert.deepEqual(lastEpisode(), { pausedMs: 120, endedBy: 'applied' })
  assert.equal(renderPauseState().episodes.length, 1)
})

test('overlapping saves: the loop starts again with the last release; the watchdog ends a pause that lasts too long', () => {
  const map = renderer()
  bindRenderLoop(map)
  const first = pauseRendering()
  const second = pauseRendering()
  first('applied')
  assert.equal(map.useDefaultRenderLoop, false, 'the second save is still in flight')
  second('applied')
  assert.equal(map.useDefaultRenderLoop, true)
  // A save that never ends: resumed at the limit, its late release does nothing, the next save pauses again.
  const stuck = pauseRendering()
  clock.advance(RENDER_PAUSE_LIMIT_MS - 1)
  assert.equal(map.useDefaultRenderLoop, false)
  clock.advance(1)
  assert.equal(map.useDefaultRenderLoop, true)
  assert.deepEqual(lastEpisode(), { pausedMs: RENDER_PAUSE_LIMIT_MS, endedBy: 'limit' })
  const before = map.frames
  map.tick()
  assert.ok(map.frames > before)
  const next = pauseRendering()
  stuck('applied')
  assert.equal(map.useDefaultRenderLoop, false, 'an earlier pause\'s release does not end the next one')
  next('failed')
  assert.equal(map.useDefaultRenderLoop, true)
  assert.equal(lastEpisode()?.endedBy, 'failed')
})

test('the page hidden, another page or the globe unmounted ends a pause at once', () => {
  const map = renderer()
  bindRenderLoop(map)
  for (const reason of ['hidden', 'page', 'unmount'] as const) {
    const release = pauseRendering()
    clock.advance(10)
    resumeRendering(reason)
    assert.equal(map.useDefaultRenderLoop, true, reason)
    assert.equal(lastEpisode()?.endedBy, reason)
    const before = map.frames
    map.tick()
    assert.ok(map.frames > before, reason)
    release('applied')
    assert.equal(lastEpisode()?.endedBy, reason, 'the late release changes nothing')
  }
  resumeRendering('page')
  assert.equal(renderPauseState().episodes.length, 3, 'no pause, nothing to end')
})

test('a loop Cesium had stopped (a rendering error) stays stopped after the pause', () => {
  const map = renderer(false)
  bindRenderLoop(map)
  const release = pauseRendering()
  release('applied')
  assert.equal(map.useDefaultRenderLoop, false)
})

test('a renderer bound during a pause is paused at once; replaced or destroyed during a pause, the new one renders again', () => {
  const first = renderer()
  const unbindFirst = bindRenderLoop(first)
  const release = pauseRendering()
  // The viewer is replaced during the pause: the old one is destroyed (its unbind leaves it alone), the new one follows.
  first.destroy()
  unbindFirst()
  const second = renderer()
  const unbindSecond = bindRenderLoop(second)
  assert.equal(second.useDefaultRenderLoop, false)
  release('applied')
  assert.equal(second.useDefaultRenderLoop, true)
  second.tick()
  assert.ok(second.frames > 0)
  // Unbound during a pause (the globe unmounts): the renderer gets its loop back at once.
  const again = pauseRendering()
  unbindSecond()
  assert.equal(second.useDefaultRenderLoop, true)
  again('applied')
})

test('another page covers the map: at most COVERED_FRAME_RATE frames a second, the loop stays on; then the cap it had', () => {
  assert.equal(COVERED_FRAME_RATE, 10)
  const map = renderer()
  const capped = renderer(true, 30)
  bindRenderLoop(map)
  bindRenderLoop(capped)
  assert.equal(renderPauseState().covered, false)
  coverRendering(true)
  coverRendering(true)
  assert.equal(renderPauseState().covered, true)
  for (const target of [map, capped]) {
    assert.equal(target.targetFrameRate, COVERED_FRAME_RATE)
    assert.equal(target.useDefaultRenderLoop, true, 'the sky goes on moving')
  }
  coverRendering(false)
  assert.equal(renderPauseState().covered, false)
  assert.equal(map.targetFrameRate, undefined, 'no cap again')
  assert.equal(capped.targetFrameRate, 30, 'the cap it had')
  assert.equal(renderPauseState().episodes.length, 0, 'a cover is not a pause')
})

test('a renderer bound on a covered map is capped at once; unbound or destroyed, it is left as it was', () => {
  coverRendering(true)
  const map = renderer()
  const unbind = bindRenderLoop(map)
  assert.equal(map.targetFrameRate, COVERED_FRAME_RATE)
  unbind()
  assert.equal(map.targetFrameRate, undefined, 'unbound (a viewer replaced): its cap back')
  const next = renderer()
  const unbindNext = bindRenderLoop(next)
  next.destroy()
  unbindNext()
  coverRendering(false)
  assert.equal(next.targetFrameRate, COVERED_FRAME_RATE, 'a destroyed viewer is not touched')
})

test('a save on a covered map, in every order: the pause turns the loop off and back, the cover only caps; neither undoes the other', () => {
  type Step = 'cover' | 'uncover' | 'pause' | 'release' | 'page'
  const orders: Step[][] = [
    ['cover', 'pause', 'release', 'uncover'],
    ['cover', 'pause', 'uncover', 'release'],
    ['pause', 'cover', 'release', 'uncover'],
    ['pause', 'cover', 'uncover', 'release'],
    // A page switch: the page ends the pause and changes the cover in one commit, in either order.
    ['cover', 'pause', 'page', 'uncover'],
    ['cover', 'pause', 'uncover', 'page'],
    ['pause', 'page', 'cover', 'uncover'],
    ['pause', 'cover', 'page', 'uncover'],
  ]
  for (const order of orders) {
    resetRenderPauseForTests(clock)
    const map = renderer()
    bindRenderLoop(map)
    let release: ReturnType<typeof pauseRendering> | undefined
    let paused = false
    let isCovered = false
    for (const step of order) {
      if (step === 'cover') { coverRendering(true); isCovered = true }
      if (step === 'uncover') { coverRendering(false); isCovered = false }
      if (step === 'pause') { release = pauseRendering(); paused = true }
      if (step === 'release') { release?.('applied'); paused = false }
      if (step === 'page') { resumeRendering('page'); paused = false }
      const at = `${order.join(' → ')}, after ${step}`
      assert.equal(map.useDefaultRenderLoop, !paused, `the loop: ${at}`)
      assert.equal(map.targetFrameRate, isCovered ? COVERED_FRAME_RATE : undefined, `the cap: ${at}`)
      const before = map.frames
      map.tick()
      assert.equal(map.frames > before, !paused, `frames only when not paused: ${at}`)
    }
  }
})

test('a covered map with a loop Cesium had stopped, or a failed viewer (guarded): capped, and the loop stays off', () => {
  coverRendering(true)
  const stopped = renderer(false)
  bindRenderLoop(stopped)
  const failed = renderer()
  let renders = true
  bindRenderLoop(guardRenderLoop(failed, () => renders))
  assert.equal(failed.targetFrameRate, COVERED_FRAME_RATE, 'the cap passes through the guard')
  // The viewer fails (its context lost): its loop is turned off, as mapRecovery does.
  renders = false
  failed.useDefaultRenderLoop = false
  const release = pauseRendering()
  release('applied')
  coverRendering(false)
  assert.equal(stopped.useDefaultRenderLoop, false)
  assert.equal(failed.useDefaultRenderLoop, false, 'neither the end of the pause nor the cover turns a failed loop on')
  assert.equal(failed.targetFrameRate, undefined)
})

function stubSync(applySaved: LocalEditorStoreSync['applySaved']): LocalEditorStoreSync {
  return { baseRevision: () => 3, applySaved, writeStarted: () => () => {}, pull: async () => {}, waitForServer: async () => {} }
}

async function withFetch(fake: typeof globalThis.fetch, work: () => Promise<unknown>) {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try { await work() } finally { globalThis.fetch = original; setLocalEditorStoreSync(undefined) }
}
const ok = () => new Response(JSON.stringify({ ok: true, item: { id: 'wish-1' }, revision: 4 }), { status: 200 })

test('the write path: paused from the call; resumed when applied, refused, unknown, or when applying throws', async () => {
  const map = renderer()
  bindRenderLoop(map)
  // Applied: the pause ends with the applying (before the editor's own end of the save).
  let pausedWhileSending: boolean | undefined
  let loopAtEnd: boolean | undefined
  setLocalEditorStoreSync(stubSync(async (_result, onApplied) => { onApplied?.() }))
  await withFetch((async () => { pausedWhileSending = !map.useDefaultRenderLoop; return ok() }) as typeof globalThis.fetch, () =>
    updateLocalWantToGo('wish-1', { note: 'Synthetic' }, { onApplied: () => { loopAtEnd = map.useDefaultRenderLoop } }))
  assert.equal(pausedWhileSending, true)
  assert.equal(loopAtEnd, true, 'the loop runs again before the editor ends the save')
  assert.equal(lastEpisode()?.endedBy, 'applied')
  // Refused: resumed with the failure.
  setLocalEditorStoreSync(stubSync(async () => {}))
  await withFetch((async () => new Response(JSON.stringify({ ok: false, code: 'E_INVALID_INPUT', error: 'refused' }), { status: 400 })) as typeof globalThis.fetch,
    () => assert.rejects(updateLocalWantToGo('wish-1', { note: 'Synthetic' })))
  assert.equal(map.useDefaultRenderLoop, true)
  assert.equal(lastEpisode()?.endedBy, 'failed')
  // Outcome unknown: resumed at the first failed try, before the retries end.
  let loopOnRetry: boolean | undefined
  let tries = 0
  setLocalEditorStoreSync(stubSync(async (_result, onApplied) => { onApplied?.() }))
  await withFetch((async () => {
    tries++
    if (tries > 1) loopOnRetry = map.useDefaultRenderLoop
    if (tries < 3) throw new TypeError('connection lost')
    return ok()
  }) as typeof globalThis.fetch, () => updateLocalWantToGo('wish-1', { note: 'Synthetic' }))
  assert.equal(loopOnRetry, true)
  assert.equal(renderPauseState().episodes.at(-1)?.endedBy, 'failed')
  // Applying throws: `finally` ends the pause.
  setLocalEditorStoreSync(stubSync(async () => { throw new Error('the changes could not be read') }))
  await withFetch((async () => ok()) as typeof globalThis.fetch, () => assert.rejects(updateLocalWantToGo('wish-1', { note: 'Synthetic' })))
  assert.equal(map.useDefaultRenderLoop, true)
  assert.equal(lastEpisode()?.endedBy, 'released')
  assert.equal(renderPauseState().paused, false)
  const before = map.frames
  map.tick()
  assert.ok(map.frames > before)
})
