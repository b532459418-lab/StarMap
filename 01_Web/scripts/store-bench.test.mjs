import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openStore, withoutLibraryLock } from './store-host.mjs'
import { SMOKE_SCALE, loadBenchStore, timedCommits } from './store-bench.mjs'

// The full benchmark runs separately (`npm run store:bench`, in segments); this is its small smoke scale.
test('store:bench smoke: a small synthetic store loads through the planner, commits, reopens and validates', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'starmap-store-bench-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('starmap-store-bench-'))
    await rm(directory, { recursive: true, force: true })
  })
  const file = path.join(directory, 'smoke.sqlite')
  const { handle, rows, commits } = await loadBenchStore(file, SMOKE_SCALE)
  let timings
  try {
    timings = await timedCommits(handle, SMOKE_SCALE, 8, 0)
    assert.deepEqual(handle.check(), { ok: true, problems: [] })
  } finally { await handle.close() }
  const reopened = openStore(file, { lock: withoutLibraryLock })
  try {
    const state = reopened.readFormalState()
    // 1,000 places and 200 media entities, plus a new place with three entries from each of the two 10-row edits.
    assert.deepEqual([state.entities.length, state.entries.length, state.assets.length, state.viewItems.length], [1_202, 1_006, 200, 1_006])
    assert.equal(state.revision, 1 + commits + 8)
    t.diagnostic(`${rows} rows in ${commits} commits; 8 edits p50 ${timings.all.p50} ms, p95 ${timings.all.p95} ms; reopen ${Math.round(reopened.openTimings.openMs)} ms`)
  } finally { await reopened.close() }
})
