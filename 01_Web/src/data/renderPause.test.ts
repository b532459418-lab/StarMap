/// <reference types="node" />
/**
 * The map's pause during a save (3C-5 D, A′; ./renderPause.ts): a renderer's loop is off from the click until the
 * changes are applied, a failure, the watchdog or a forced end, and it then renders again (its frames go on); a loop
 * Cesium had stopped stays stopped; overlapping saves, a replaced or destroyed renderer. And the write path
 * (./localEditorApi.ts) ends the pause in every outcome.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { bindRenderLoop, pauseRendering, RENDER_PAUSE_LIMIT_MS, renderPauseState, resetRenderPauseForTests, resumeRendering } from './renderPause.ts'
import { setLocalEditorStoreSync, updateLocalWantToGo, type LocalEditorStoreSync } from './localEditorApi.ts'

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
function renderer(loop = true) {
  let destroyed = false
  const target = {
    useDefaultRenderLoop: loop,
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
