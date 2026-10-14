import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { OPEN_RETRIES, StoreSessionError, createStoreSession, openStoreWithRetry } from './store-session.mjs'
import { quietly, sampleV2Files, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { readEditorStateV1 } from '../src/data/v2write/index.ts'

const NOW = '2026-10-14T00:00:00.000Z'

async function migratedRoot(t, files = sampleV2Files()) {
  const context = await tempPrivateRoot(t, 'starmap-store-session-')
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: NOW })
  return { ...context, files, file: storeFileOf(context.paths) }
}

/** Another connection holding SQLite's write lock (as another process writing would). */
function writeLockHolder(file) {
  const db = new DatabaseSync(file)
  db.exec('BEGIN IMMEDIATE')
  return { release: () => { db.exec('ROLLBACK'); db.close() } }
}

test('opening retries while another connection writes, then succeeds; it never waits longer than the retries', async (t) => {
  const { file, paths } = await migratedRoot(t)
  const holder = writeLockHolder(file)
  let sleeps = 0
  const handle = await openStoreWithRetry(file, { privatePaths: paths, policy: OFFICIAL_POLICY }, {
    sleep: async () => { if (++sleeps === 2) holder.release() },
  })
  try {
    assert.equal(sleeps, 2)
    assert.equal(handle.readOnly, false)
  } finally { await handle.close() }

  const blocked = writeLockHolder(file)
  try {
    let waits = 0
    const error = await openStoreWithRetry(file, { privatePaths: paths, policy: OFFICIAL_POLICY }, { sleep: async () => { waits++ } })
      .then(() => undefined, (failure) => failure)
    assert.ok(error instanceof StoreSessionError)
    assert.equal(error.code, 'E_STORE_BUSY')
    assert.equal(waits, OPEN_RETRIES)
    assert.match(error.message, /不会回落到 data\/v2\/ 的文件/)
  } finally { blocked.release() }
})

test('a store that fails its open checks is an error with the check code, never a read-only fallback', async (t) => {
  const { file, paths } = await migratedRoot(t)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA user_version = 99')
  db.close()
  const error = await openStoreWithRetry(file, { privatePaths: paths, policy: OFFICIAL_POLICY }, { sleep: async () => {} })
    .then(() => undefined, (failure) => failure)
  assert.equal(error?.code, 'E_STORE_TOO_NEW')
  // The diagnostic handle was closed: the file is free for another writer.
  const handle = openStore(file, { readOnly: true })
  try { assert.equal(handle.diagnostic.code, 'E_STORE_TOO_NEW') } finally { await handle.close() }

  await writeFile(file, 'not a store')
  const garbage = await openStoreWithRetry(file, { privatePaths: paths }, { sleep: async () => {} }).then(() => undefined, (failure) => failure)
  assert.equal(garbage?.code, 'E_STORE_CORRUPT')
})

test('the read model is the store projected into the five V2 files, cached per revision, with timed steps', async (t) => {
  const { files, paths, file } = await migratedRoot(t)
  const output = quietly()
  const session = createStoreSession(paths, { log: output.log })
  try {
    const first = await session.moduleExports()
    assert.equal(first.revision, 1)
    assert.deepEqual(canonicalForInputs({ v2Files: first.files }), readV2(files))
    const snapshot = session.lastSnapshot
    for (const step of ['openMs', 'readMs', 'projectMs', 'serializeMs']) assert.equal(typeof snapshot.timings[step], 'number', step)
    assert.equal(output.lines.length, 1)
    assert.match(output.lines[0], /^\[StarMap store\] 读模型（修订号 1）：打开 [\d.]+ ms，readRowsUnchecked [\d.]+ ms，投影 [\d.]+ ms，serializeV2 [\d.]+ ms$/)
    // Same revision: the cached model, no new log line.
    const again = await session.moduleExports()
    assert.equal(again.files, first.files)
    assert.equal(output.lines.length, 1)
    // GET /editor/state reads the same model.
    const state = await session.readEditorState(new Date(NOW))
    assert.deepEqual(state, { status: 200, body: { ok: true, state: readEditorStateV1(files, new Date(NOW)) } })
    assert.equal(session.isOpen, true)
  } finally { await session.close() }
  // close() ended the writer session cleanly: the next writable open runs no quick_check.
  const handle = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY })
  try { assert.equal(handle.openTimings.quickCheckMs, undefined) } finally { await handle.close() }
})

test('rows the projection cannot express are counted in the log, not an error', async (t) => {
  const { paths } = await migratedRoot(t)
  const writer = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    await writer.commit({
      requestId: '01960000-0000-7000-8000-00000000b001', baseRevision: 1, kind: 'test.custom-layer', actor: 'test',
      commands: [
        { op: 'create', table: 'sources', value: { id: 'synthetic:source', revision: 0, title: { names: { en: 'Synthetic' } }, origin: 'user' } },
        { op: 'create', table: 'entityTypes', value: { id: 'synthetic:type', revision: 0, title: { names: { en: 'Synthetic' } }, schemaVersion: 1, fields: [] } },
      ],
    })
  } finally { await writer.close() }
  const output = quietly()
  const session = createStoreSession(paths, { log: output.log })
  try {
    assert.equal((await session.moduleExports()).revision, 2)
    assert.match(output.lines[0], /；投影跳过 2 行（sources 1，entityTypes 1）$/)
  } finally { await session.close() }
})

test('an open failure is reported again on every use, and the session opens once the store is free', async (t) => {
  const { file, paths } = await migratedRoot(t)
  const holder = writeLockHolder(file)
  const session = createStoreSession(paths, { log: () => {}, retry: { sleep: async () => {} } })
  try {
    await assert.rejects(session.moduleExports(), { code: 'E_STORE_BUSY' })
    // A busy store is the busy notice the client knows; other open failures are E_STORE_FAILED with the code.
    const state = await session.readEditorState()
    assert.equal(state.status, 409)
    assert.equal(state.body.code, 'E_STORE_BUSY')
    holder.release()
    assert.equal((await session.moduleExports()).revision, 1)
  } finally { await session.close() }
})
