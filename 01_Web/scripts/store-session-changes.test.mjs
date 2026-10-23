/**
 * The store session's changes for the page (3C-5 D, design §3): its own commits are logged and announced; a commit of
 * another process is found when the session looks again (checkExternal), logged as the rows that differ and announced;
 * a restore, or a new session, makes the page read the whole read model again (410).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, createStoreSession } from './store-session.mjs'
import { quietly, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { TEST_CATALOG, WRITE_EPOCH_MS, migratedFiles } from '../src/data/editor/editor.fixture.ts'
import { applyReadModelDelta } from '../src/worldgraph/readModel/delta.ts'

const MIGRATED_AT = '2026-09-26T00:00:00.000Z'
const ROUTE = 'POST /__travelatlas/editor/wanttogo/update'
let counter = 0
const requestId = () => `01960000-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`
const contextOf = (n) => ({ newId: sequentialUuids(WRITE_EPOCH_MS + n * 1000), now: new Date(Date.UTC(2026, 8, 27, 8, n)), countryCatalog: TEST_CATALOG })

async function changesSession(t) {
  const context = await tempPrivateRoot(t, 'starmap-store-changes-')
  const files = migratedFiles()
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: MIGRATED_AT })
  const output = quietly()
  const open = () => context.closeAfter(createStoreSession(context.paths, { log: output.log, countryCatalog: TEST_CATALOG, newId: sequentialUuids(Date.UTC(2032, 0, 1)) }))
  const session = open()
  const pushes = []
  session.onRevision((revision) => pushes.push(revision))
  const write = (input, base, n) => session.writeRoute(...ROUTE.split(' '))({
    headers: { [STORE_REQUEST_ID_HEADER]: requestId(), [STORE_BASE_REVISION_HEADER]: String(base) }, input, ctx: contextOf(n),
  })
  const storeNow = async () => {
    const handle = openStore(storeFileOf(context.paths), { privatePaths: context.paths, readOnly: true, policy: OFFICIAL_POLICY })
    try { return handle.readModel() } finally { await handle.close() }
  }
  /** Another writer: a commit on the store that bypasses the session (as a command-line import does from another process). */
  const otherWriter = async (wishId, note) => {
    const handle = await session.open()
    const { revision } = handle.meta()
    const entry = handle.readModel().entries.find((row) => row.source?.sourceId === 'v2:want-to-go' && row.source.recordId === wishId)
    await handle.commit({
      requestId: requestId(), baseRevision: revision, kind: 'test.other-writer', actor: 'test',
      commands: [{ op: 'update', table: 'entries', id: entry.id, expectedRevision: entry.revision, value: { ...entry, revision: entry.revision + 1, fields: { ...entry.fields, note } } }],
    })
  }
  return { ...context, files, session, open, pushes, output, write, storeNow, otherWriter }
}

test('own commits: logged and announced; the changes since a revision are the answers\' deltas', async (t) => {
  const { session, files, pushes, write, storeNow } = await changesSession(t)
  const first = await session.moduleExports()
  assert.equal(first.revision, 1)
  assert.match(first.identity.libraryId, /^[0-9a-f-]{36}$/)
  const before = await storeNow()
  const wish = files.wantToGo.items[0]
  const one = await write({ id: wish.id, note: 'Synthetic one' }, 1, 1)
  const two = await write({ id: wish.id, note: 'Synthetic two' }, 2, 2)
  assert.deepEqual(pushes.map((push) => push.revision), [2, 3])
  assert.ok(pushes.every((push) => push.libraryId === first.identity.libraryId && push.restoreMark === null))
  const answer = await session.changesSince(1, { libraryId: first.identity.libraryId, restoreMark: null })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.deltas, [one.body.delta, two.body.delta])
  let model = before
  for (const delta of answer.body.deltas) model = applyReadModelDelta(model, { baseRevision: delta.from, nextRevision: delta.to, ...delta })
  assert.deepEqual(model, await storeNow())
  assert.deepEqual((await session.changesSince(3)).body.deltas, [])
})

test('another writer: found when the session looks again, logged as the changed rows over the revisions it skipped, announced once', async (t) => {
  const { session, files, pushes, storeNow, otherWriter, output } = await changesSession(t)
  await session.moduleExports()
  const before = await storeNow()
  await otherWriter(files.wantToGo.items[0].id, 'Synthetic import A')
  await otherWriter(files.wantToGo.items[1].id, 'Synthetic import B')
  assert.deepEqual(pushes, [], 'nothing is announced before the session looks')
  assert.equal(await session.checkExternal(), 3)
  assert.deepEqual(pushes.map((push) => push.revision), [3])
  assert.equal(await session.checkExternal(), 3)
  assert.equal(pushes.length, 1, 'looking again finds nothing new')
  const answer = await session.changesSince(1)
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.deltas.map((delta) => [delta.from, delta.to, delta.upserts.length, delta.deletes.length]), [[1, 3, 2, 0]])
  const [delta] = answer.body.deltas
  const applied = applyReadModelDelta(before, { baseRevision: 1, nextRevision: 2, upserts: delta.upserts, deletes: delta.deletes })
  assert.deepEqual({ ...applied, revision: 3 }, await storeNow())
  assert.deepEqual(officialViewOf(await storeNow(), 'local').wantToGo.items.slice(0, 2).map((item) => item.note), ['Synthetic import A', 'Synthetic import B'])
  assert.ok(output.lines.some((line) => /库被别的进程改过（修订号 1 → 3）：2 行改动/.test(line)))
})

test('a restore (the restore mark moves) and a new session: the page reads the whole read model again (410)', async (t) => {
  const { session, files, pushes, write, open } = await changesSession(t)
  const { identity } = await session.moduleExports()
  await write({ id: files.wantToGo.items[0].id, note: 'Synthetic before restore' }, 1, 1)
  const handle = await session.open()
  await handle.setRestoredFrom({ restoredAt: '2026-10-22T00:00:00.000Z', backup: 'synthetic' })
  assert.equal(await session.checkExternal(), 2)
  assert.deepEqual(pushes.at(-1), { libraryId: identity.libraryId, restoreMark: '2026-10-22T00:00:00.000Z', revision: 2 })
  const restored = await session.changesSince(1, { libraryId: identity.libraryId, restoreMark: null })
  assert.deepEqual([restored.status, restored.body.code, restored.body.reason], [410, 'E_CHANGES_GONE', 'restored'])
  // A page of the restored library at the current revision needs nothing; behind it, the log no longer explains it.
  assert.equal((await session.changesSince(2, { libraryId: identity.libraryId, restoreMark: '2026-10-22T00:00:00.000Z' })).status, 200)
  assert.equal((await session.changesSince(1, { libraryId: identity.libraryId, restoreMark: '2026-10-22T00:00:00.000Z' })).body.reason, 'restart')
  // A new session (a dev server restarted) keeps nothing.
  await session.close()
  const restarted = open()
  assert.equal((await restarted.changesSince(2)).status, 200)
  assert.equal((await restarted.changesSince(1)).body.reason, 'restart')
  assert.equal((await restarted.changesSince(5)).body.reason, 'ahead')
})
