/// <reference types="node" />
/**
 * Keeping the page's data current without reloading (3C-5 D, design §3): an answer's changed rows applied, pushes late,
 * twice or out of order caught up by revision, a 410 or changes that do not apply read the whole read model again; and
 * the editor writes with the sync: E_STALE fetches the changes and retries on the new revision with a new request id,
 * an outcome still unknown after the retry waits for the server and tries the same request id once more.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readModelOf } from '../worldgraph/readModel/build.ts'
import { liveReadModelIndex } from '../worldgraph/readModel/liveIndex.ts'
import { applyChangeSet, planCommands, type ChangeSet } from '../worldgraph/store/planner.ts'
import { memoryReader } from '../worldgraph/store/reader.ts'
import type { FormalState } from '../worldgraph/store/formal.ts'
import { computeSnapshot, createAppStore, type ReadModelChanges } from './appStoreCore.ts'
import { doubleRunStore, random, randomStep, stepContext } from './editor/doubleRun.fixture.ts'
import { NATIVE_WRITES } from './editor/native/routes.ts'
import { setLocalEditorStoreSync, updateLocalWantToGo } from './localEditorApi.ts'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER } from './storeWriteProtocol.ts'
import { createStoreSync, READ_MODEL_CHANGES_PATH } from './storeSync.ts'
import { viewOf } from './store/diffV2.fixture.ts'
import { OFFICIAL_POLICY } from './store/officialDefinitions.ts'
import { officialReader } from './store/officialReader.ts'
import { migratedFiles } from './v2write/v2write.fixture.ts'

const OPTIONS = { source: 'local', now: '2026-10-22T00:00:00.000Z' } as const
const LIBRARY = { libraryId: '01990000-0000-7000-8000-00000000d001', restoreMark: null }
const modelOf = (state: FormalState) => readModelOf(state, { origin: 'local' })

/** A library and its commits, as the dev server's change log answers them. */
function library() {
  let state = doubleRunStore(migratedFiles()).state
  const log: ReadModelChanges[] = []
  const rng = random(42)
  let n = 0
  const commit = () => {
    for (;;) {
      n++
      const step = randomStep(rng, viewOf(state))
      const ctx = stepContext(n)
      let plan
      try { plan = NATIVE_WRITES[step.route].plan(officialReader(liveReadModelIndex(modelOf(state))), structuredClone(step.input), ctx) } catch { continue }
      if (plan.commands.length === 0) continue
      const changeSet: ChangeSet = planCommands(memoryReader(state), plan.commands, { baseRevision: state.revision, now: ctx.now.toISOString(), policy: OFFICIAL_POLICY })
      state = applyChangeSet(state, changeSet)
      const delta = { ...LIBRARY, from: changeSet.baseRevision, to: changeSet.nextRevision, upserts: changeSet.upserts, deletes: changeSet.deletes }
      log.push(delta)
      return delta
    }
  }
  return { get state() { return state }, log, commit }
}

function pageOf(lib: ReturnType<typeof library>, options: { gone?: () => boolean } = {}) {
  const store = createAppStore(computeSnapshot(modelOf(lib.state), { ...OPTIONS, identity: LIBRARY }), OPTIONS)
  const requests: string[] = []
  let wholeReads = 0
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    requests.push(url.pathname + url.search)
    assert.equal(url.pathname, READ_MODEL_CHANGES_PATH)
    if (options.gone?.()) return new Response(JSON.stringify({ ok: false, code: 'E_CHANGES_GONE', reason: 'restart' }), { status: 410 })
    const since = Number(url.searchParams.get('since'))
    return new Response(JSON.stringify({ ok: true, ...LIBRARY, revision: lib.state.revision, deltas: lib.log.filter((delta) => delta.from >= since) }), { status: 200 })
  }) as typeof globalThis.fetch
  const sync = createStoreSync({
    store, fetch, pollMs: 1, timeoutMs: 50,
    loadWhole: async () => { wholeReads++; return { model: modelOf(lib.state), identity: LIBRARY } },
  })
  return { store, sync, requests, get wholeReads() { return wholeReads } }
}

test('an answer\'s changed rows are applied; the same rows again, or rows of a revision the page has passed, change nothing', async () => {
  const lib = library()
  const page = pageOf(lib)
  const delta = lib.commit()
  await page.sync.applySaved({ ok: true, revision: delta.to, delta })
  assert.equal(page.store.getSnapshot().revision, delta.to)
  assert.deepEqual(page.store.getSnapshot().model, modelOf(lib.state))
  await page.sync.applySaved({ ok: true, revision: delta.to, delta })
  assert.deepEqual(page.requests, [], 'nothing fetched')
})

test('pushes late, twice or out of order: every fetch starts from the revision the page has; an old push is ignored', async () => {
  const lib = library()
  const page = pageOf(lib)
  const first = lib.commit()
  const second = lib.commit()
  await page.sync.revisionPushed({ ...LIBRARY, revision: second.to })
  assert.equal(page.store.getSnapshot().revision, second.to)
  await page.sync.revisionPushed({ ...LIBRARY, revision: first.to })
  await page.sync.revisionPushed({ ...LIBRARY, revision: second.to })
  assert.equal(page.requests.length, 1, 'pushes the page has passed fetch nothing')
  assert.match(page.requests[0], new RegExp(`since=${first.from}&libraryId=${LIBRARY.libraryId}&restoreMark=$`))
  // This page's own answer arriving after the push of its commit: already applied.
  await page.sync.applySaved({ ok: true, revision: second.to, delta: second })
  assert.equal(page.requests.length, 1)
  // A push of another library (or a restore) is never taken for "already there": it is fetched, and the server decides
  // (a real one answers 410 then, and the page reads everything again; this fake one answers the changes).
  const third = lib.commit()
  await page.sync.revisionPushed({ ...LIBRARY, restoreMark: '2026-10-22T00:00:00.000Z', revision: third.to })
  assert.equal(page.store.getSnapshot().revision, third.to)
  assert.deepEqual(page.store.getSnapshot().model, modelOf(lib.state))
})

test('a 410, or changes that do not apply, read the whole read model again; the page is not reloaded', async () => {
  const lib = library()
  let gone = true
  const page = pageOf(lib, { gone: () => gone })
  lib.commit(); lib.commit()
  await page.sync.pull()
  assert.equal(page.wholeReads, 1)
  assert.deepEqual(page.store.getSnapshot().model, modelOf(lib.state))
  gone = false
  // An answer whose delta does not follow (a commit in between that this page has not seen): fetched by revision.
  const between = lib.commit()
  const own = lib.commit()
  await page.sync.applySaved({ ok: true, revision: own.to, delta: own })
  assert.equal(page.store.getSnapshot().revision, own.to)
  assert.ok(between.to < own.to)
  assert.deepEqual(page.store.getSnapshot().model, modelOf(lib.state))
})

test('the editor writes with the sync: E_STALE fetches the changes and retries on the new revision with a new request id', async () => {
  let released = 0
  const sent: { base: string; id: string }[] = []
  let pulls = 0
  let revision = 5
  setLocalEditorStoreSync({ baseRevision: () => revision, applySaved: async () => {}, writeStarted: () => () => { released++ }, pull: async () => { pulls++; revision = 7 }, waitForServer: async () => {} })
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>
    sent.push({ base: headers[STORE_BASE_REVISION_HEADER], id: headers[STORE_REQUEST_ID_HEADER] })
    if (sent.length === 1) return new Response(JSON.stringify({ ok: false, code: 'E_STALE', error: 'stale' }), { status: 409 })
    return new Response(JSON.stringify({ ok: true, item: { id: 'wish-1' }, revision: 8 }), { status: 200 })
  }) as typeof globalThis.fetch
  try {
    await updateLocalWantToGo('wish-1', { note: 'Synthetic' }, { baseRevision: 5 })
  } finally { globalThis.fetch = original; setLocalEditorStoreSync(undefined) }
  assert.deepEqual(sent.map((request) => request.base), ['5', '7'])
  assert.notEqual(sent[0].id, sent[1].id)
  assert.equal(pulls, 1)
  assert.equal(released, 1, 'the pushes no longer wait for the write')
})

test('the editor writes with the sync: after an E_STALE, a draft whose record changed meanwhile is not sent again (E_DRAFT_CONFLICT)', async () => {
  let released = 0
  let sent = 0
  let pulls = 0
  setLocalEditorStoreSync({ baseRevision: () => 9, applySaved: async () => {}, writeStarted: () => () => { released++ }, pull: async () => { pulls++ }, waitForServer: async () => {} })
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    sent++
    return new Response(JSON.stringify({ ok: false, code: 'E_STALE', error: 'stale' }), { status: 409 })
  }) as typeof globalThis.fetch
  try {
    await assert.rejects(updateLocalWantToGo('wish-1', { note: 'Synthetic' }, { baseRevision: 5, changedMeanwhile: () => true }), { code: 'E_DRAFT_CONFLICT' })
  } finally { globalThis.fetch = original; setLocalEditorStoreSync(undefined) }
  assert.deepEqual([sent, pulls], [1, 1], 'the changes fetched, the request not sent again')
  assert.equal(released, 1, 'released when the write is refused')
})

test('the editor writes with the sync: an outcome unknown twice waits for the server and tries the same request id once more', async () => {
  let released = 0
  const ids: string[] = []
  let waited = 0
  setLocalEditorStoreSync({ baseRevision: () => 3, applySaved: async () => {}, writeStarted: () => () => { released++ }, pull: async () => {}, waitForServer: async () => { waited++ } })
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    ids.push((init!.headers as Record<string, string>)[STORE_REQUEST_ID_HEADER])
    if (ids.length < 3) throw new TypeError('connection lost')
    return new Response(JSON.stringify({ ok: true, item: { id: 'wish-1' }, revision: 4 }), { status: 200 })
  }) as typeof globalThis.fetch
  try {
    await updateLocalWantToGo('wish-1', { note: 'Synthetic' })
  } finally { globalThis.fetch = original; setLocalEditorStoreSync(undefined) }
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 1, 'the same request id')
  assert.equal(waited, 1)
  assert.equal(released, 1)
})

test('waitForServer: resolves when the server answers again, or after its time', async () => {
  const lib = library()
  let answers = 0
  const fetch = (async () => {
    answers++
    if (answers < 3) throw new TypeError('down')
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch
  const store = createAppStore(computeSnapshot(modelOf(lib.state), OPTIONS), OPTIONS)
  await createStoreSync({ store, fetch, loadWhole: async () => undefined, pollMs: 1, timeoutMs: 1000 }).waitForServer()
  assert.equal(answers, 3)
  const started = Date.now()
  await createStoreSync({ store, fetch: (async () => { throw new TypeError('down') }) as typeof globalThis.fetch, loadWhole: async () => undefined, pollMs: 5, timeoutMs: 40 }).waitForServer()
  assert.ok(Date.now() - started < 1000)
})

/** A page whose sync records its batches and whether a callback ran inside one. */
function batchedPageOf(lib: ReturnType<typeof library>, pushHoldMs = 10_000) {
  const store = createAppStore(computeSnapshot(modelOf(lib.state), { ...OPTIONS, identity: LIBRARY }), OPTIONS)
  const requests: string[] = []
  let inBatch = false
  let batches = 0
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    requests.push(url.pathname + url.search)
    const since = Number(url.searchParams.get('since'))
    return new Response(JSON.stringify({ ok: true, ...LIBRARY, revision: lib.state.revision, deltas: lib.log.filter((delta) => delta.from >= since) }), { status: 200 })
  }) as typeof globalThis.fetch
  const sync = createStoreSync({
    store, fetch, pollMs: 1, timeoutMs: 50, pushHoldMs,
    loadWhole: async () => ({ model: modelOf(lib.state), identity: LIBRARY }),
    batch: (work) => { batches++; inBatch = true; try { work() } finally { inBatch = false } },
  })
  /** The end of a save: records the revision it saw and whether it ran in the same batch as the data. */
  const ends: { revision: number; inBatch: boolean }[] = []
  const onApplied = () => { ends.push({ revision: store.getSnapshot().revision, inBatch }) }
  return { store, sync, requests, ends, onApplied, get batches() { return batches } }
}

test('the end of a save runs once, in the same batch as its data: its own changed rows, or the changes fetched when they do not follow', async () => {
  const lib = library()
  const page = batchedPageOf(lib)
  const own = lib.commit()
  await page.sync.applySaved({ ok: true, revision: own.to, delta: own }, page.onApplied)
  assert.deepEqual(page.ends, [{ revision: own.to, inBatch: true }])
  assert.equal(page.batches, 1, 'one batch: the data and the end together')
  // Rows that do not follow (a commit of another page between): the end runs with the fetched changes.
  const between = lib.commit()
  const next = lib.commit()
  await page.sync.applySaved({ ok: true, revision: next.to, delta: next }, page.onApplied)
  assert.deepEqual(page.ends.slice(1), [{ revision: next.to, inBatch: true }])
  assert.ok(between.to < next.to)
  assert.equal(page.requests.length, 1)
  // The data already there (nothing to apply): the save still ends, once.
  await page.sync.applySaved({ ok: true, revision: next.to, delta: next }, page.onApplied)
  assert.deepEqual(page.ends.slice(2), [{ revision: next.to, inBatch: true }])
})

test('revision pushes wait while this page writes; the last write to end fetches what they announced, and the hold is bounded', async () => {
  const lib = library()
  const page = batchedPageOf(lib, 20)
  const release = page.sync.writeStarted()
  const second = page.sync.writeStarted()
  // The push of this page's own commit arrives before its answer: nothing is fetched.
  const own = lib.commit()
  await page.sync.revisionPushed({ ...LIBRARY, revision: own.to })
  assert.deepEqual(page.requests, [])
  await page.sync.applySaved({ ok: true, revision: own.to, delta: own }, page.onApplied)
  assert.deepEqual(page.ends, [{ revision: own.to, inBatch: true }])
  // Another tab's commit announced meanwhile: fetched when the last write ends (a release twice counts once).
  const other = lib.commit()
  await page.sync.revisionPushed({ ...LIBRARY, revision: other.to })
  release()
  release()
  assert.deepEqual(page.requests, [], 'one write still in flight')
  second()
  await page.sync.pull()
  assert.equal(page.store.getSnapshot().revision, other.to)
  assert.equal(page.requests.length, 2, 'the held push and the pull above')
  // A write that never ends does not hold the pushes for longer than the bound.
  page.sync.writeStarted()
  const late = lib.commit()
  await page.sync.revisionPushed({ ...LIBRARY, revision: late.to })
  for (let waited = 0; page.store.getSnapshot().revision !== late.to && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(page.store.getSnapshot().revision, late.to, 'fetched after the bound, the write still in flight')
})
