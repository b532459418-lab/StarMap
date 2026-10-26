/**
 * Record pruning in the new-library mode (3C-4b; design 3B §4.6 with v1.1 §16.2-5 and -6): the dev server's session
 * runs the host's pruneLogs in small steps when it opens and after every PRUNE_EVERY_COMMITS commits, after the
 * response of the write that triggered it; the store file shrinks (incremental_vacuum); receipts inside the replay
 * window stay, so a replay still answers with the original receipt.
 */
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { RETENTION } from './store-host.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import {
  PRUNE_EVERY_COMMITS, PRUNE_STEP, STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, createStoreSession,
} from './store-session.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { sampleV2Files, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'

const NOW = '2026-10-14T00:00:00.000Z'
const ROUTE = 'POST /__travelatlas/editor/wanttogo/update'
let counter = 0
const requestId = () => `01960000-0000-7000-8000-${(0xc4b000 + ++counter).toString(16).padStart(12, '0')}`
const headers = (id, base) => ({ [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) })

async function migrated(t) {
  const context = await tempPrivateRoot(t, 'starmap-store-prune-')
  const files = sampleV2Files()
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: NOW })
  return { ...context, files, file: storeFileOf(context.paths), wish: files.wantToGo.items[0] }
}

function openSession(context, options = {}) {
  const lines = []
  const session = context.closeAfter(createStoreSession(context.paths, { log: (line) => lines.push(line), now: () => NOW, ...options }))
  return { session, lines, update: session.writeRoute(...ROUTE.split(' ')) }
}

/** Row count of a table, from a separate read-only connection (through the adapter). */
function countRows(file, table) {
  const db = rawConnection(file, { readOnly: true })
  try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n } finally { db.close() }
}
function hasReceipt(file, id) {
  const db = rawConnection(file, { readOnly: true })
  try { return db.prepare('SELECT 1 AS found FROM receipts WHERE request_id = ?').get(id) !== undefined } finally { db.close() }
}

/** Test-only history written straight into the file: `count` old receipts and op_log rows of about 1 KB each. */
function oldHistory(file, count) {
  const pad = "replace(hex(zeroblob(500)), '0', 'x')"
  const db = rawConnection(file)
  try {
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO receipts (request_id, request_digest, status, revision_after, response, at)
        SELECT printf('old-%05d', i), 'digest', 'committed', 1, ${pad}, '2020-01-01T00:00:00.000Z' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO op_log (request_id, at, actor, kind, summary) SELECT printf('old-%05d', i), '2020-01-01T00:00:00.000Z', 'test', 'old', ${pad} FROM n`)
  } finally { db.close() }
}

test('the schedule: one small run when the session opens and every N commits, after the response; replays do not count', async (t) => {
  assert.equal(PRUNE_EVERY_COMMITS, 200)
  assert.deepEqual(PRUNE_STEP, { batchSize: 200, vacuumPages: 256 })
  const context = await migrated(t)
  const { session, update } = openSession(context, { prune: { every: 3 } })
  assert.equal((await session.moduleExports()).revision, 1)
  await session.idle()
  assert.deepEqual(session.pruneState.runs, 1)
  assert.equal(session.pruneState.last.reason, 'open')
  assert.equal(session.pruneState.last.done, true)
  assert.equal(session.pruneState.last.steps, 1, 'one pruning transaction')

  let revision = 1
  const write = async (id = requestId(), base = revision) => {
    const saved = await update({ headers: headers(id, base), input: { id: context.wish.id, note: `Synthetic ${id.slice(-4)}` } })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    if (!saved.body.duplicate) revision = saved.body.revision
    return { id, saved }
  }
  await write()
  await write()
  await session.idle()
  assert.equal(session.pruneState.runs, 1, 'two commits: no run yet')
  assert.equal(session.pruneState.commits, 2)
  // A replay is not a commit.
  const { id: repeated } = await write()
  const runsAtResponse = session.pruneState.runs
  await write(repeated, revision - 1)
  // The third commit triggered a run; it starts only after that write answered.
  assert.equal(runsAtResponse, 1, 'the run had not started when the write answered')
  await session.idle()
  assert.equal(session.pruneState.runs, 2)
  assert.equal(session.pruneState.last.reason, 'commits')
  assert.equal(session.pruneState.commits, 0)
  for (let i = 0; i < 2; i++) await write()
  await session.idle()
  assert.equal(session.pruneState.runs, 2)
  // Off: no run at all.
  await session.close()
  const quiet = openSession(context, { prune: false })
  await quiet.session.moduleExports()
  await quiet.session.idle()
  assert.equal(quiet.session.pruneState.runs, 0)
})

test('a large history is pruned in small steps over the following commits, the file shrinks, and replays still answer with the original receipt', { timeout: 120_000 }, async (t) => {
  const context = await migrated(t)
  const { file } = context
  oldHistory(file, 20_000)
  const before = statSync(file).size
  // Larger steps than the default only to keep the test short; every commit runs the next step while work is left.
  const { session, update, lines } = openSession(context, { prune: { every: 50, batchSize: 2_000, vacuumPages: 1_024 } })
  assert.equal((await session.moduleExports()).revision, 1)
  await session.idle()
  assert.equal(session.pruneState.last.reason, 'open')
  assert.deepEqual([session.pruneState.last.receipts, session.pruneState.last.opLog, session.pruneState.last.done], [2_000, 2_000, false])
  assert.ok(session.pruneState.last.freedPages > 0)
  assert.equal(session.pruneState.backlog, true)

  let revision = 1
  const committed = []
  const runMs = [session.pruneState.last.ms]
  for (let i = 0; i < 40 && session.pruneState.backlog; i++) {
    const id = requestId()
    const input = { id: context.wish.id, note: `Synthetic note ${i}` }
    const saved = await update({ headers: headers(id, revision), input })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    committed.push({ id, input, base: revision, receipt: saved.body.receipt })
    revision = saved.body.revision
    await session.idle()
    assert.equal(session.pruneState.last.reason, 'commits')
    runMs.push(session.pruneState.last.ms)
  }
  assert.equal(session.pruneState.backlog, false, 'the history is pruned within 40 commits')
  assert.equal(session.pruneState.last.done, true)
  const runs = session.pruneState.runs
  t.diagnostic(`${committed.length} commits, ${runs} runs (longest ${Math.max(...runMs)} ms); ${lines.filter((line) => line.includes('清理记录')).length} log lines`)
  assert.equal(runs, committed.length + 1)
  assert.match(lines.find((line) => line.includes('清理记录（open）')), /^\[StarMap store\] 清理记录（open）：回执 2000 条，op_log 2000 条，归还 \d+ 页，[\d.]+ ms；还有剩余/)

  // Retention: receipts keep the newest RETENTION.receipts.count (all old ones beyond them are older than 30 days);
  // op_log keeps nothing older than a year.
  assert.equal(countRows(file, 'receipts'), RETENTION.receipts.count)
  assert.equal(countRows(file, 'op_log'), 1 + committed.length, 'the migration and the session\'s commits')
  assert.equal(hasReceipt(file, 'old-20000'), true, 'the newest old receipt is inside the newest 10,000')
  assert.equal(hasReceipt(file, 'old-00001'), false)
  for (const { id } of committed) assert.equal(hasReceipt(file, id), true)
  const after = statSync(file).size
  t.diagnostic(`${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`)
  assert.ok(after < before - 20 * 1048576, `the file shrank by more than 20 MB: ${before} → ${after}`)

  // Replays after a restart come from the receipts table: the original receipt, nothing written.
  await session.close()
  const restarted = openSession(context, { prune: false })
  assert.equal((await restarted.session.moduleExports()).revision, revision)
  for (const { id, input, base, receipt } of committed) {
    const replay = await restarted.update({ headers: headers(id, base), input })
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.duplicate, true)
    assert.deepEqual(replay.body.receipt, receipt)
  }
  assert.equal((await restarted.session.moduleExports()).revision, revision)
  assert.equal(countRows(file, 'receipts'), RETENTION.receipts.count)
})

test('a run that cannot write (another connection holds the write lock) is logged and tried again at the next commit', async (t) => {
  const context = await migrated(t)
  oldHistory(context.file, 50)
  const retention = { receipts: { days: 30, count: 10 }, opLog: { days: 365, count: 10 } }
  const { session, update, lines } = openSession(context, { prune: { every: 100, retention } })
  await session.open()
  const holder = rawConnection(context.file)
  holder.exec('BEGIN IMMEDIATE')
  try {
    await session.idle()
    assert.deepEqual([session.pruneState.last.reason, session.pruneState.last.code], ['open', 'E_STORE_BUSY'])
    assert.equal(session.pruneState.backlog, true)
    assert.match(lines.at(-1), /^\[StarMap store\] 清理记录（open）没有完成（E_STORE_BUSY），下一次提交后再试。$/)
  } finally { holder.exec('ROLLBACK'); holder.close() }
  assert.equal(countRows(context.file, 'receipts'), 51)
  const saved = await update({ headers: headers(requestId(), 1), input: { id: context.wish.id, note: 'Synthetic retry' } })
  assert.equal(saved.status, 200)
  await session.idle()
  assert.deepEqual([session.pruneState.last.reason, session.pruneState.last.done], ['commits', true])
  assert.equal(countRows(context.file, 'receipts'), 10)
})
