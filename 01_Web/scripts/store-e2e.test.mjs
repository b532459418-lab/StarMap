/**
 * The new-library mode end to end (3C-3 spec §2.6), on temporary private roots with the public sample and the 3C-1b
 * edge cases, through the plugin itself (its virtual module and its middleware, without a server):
 *
 *   1. dry run, then --apply;            2. read the plugin way = readV2;     3. edit a note, then the hidden state;
 *   4. close normally and reopen;        5. the edits and the revision are there;
 *   6. the same request id again: the original receipt, no second write;     7. a stale revision: E_STALE;
 *   8. media (3C-4c): the task list reads the store; an import of an empty Inbox writes nothing;
 *   9. backup and restore to a new root: the same reading;                   10. export-v2 read back = step 5;
 *   11. ten restores in a row, each from a backup of the previous one: neither the file nor store_meta grows.
 */
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { getPrivatePaths } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { backupStore, restoreStore } from './store-backup.mjs'
import { exportStoreV2 } from './compat/store-export-v2.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration, previewMigration } from './compat/store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER } from './store-session.mjs'
import { servedCanonical } from './private-read-model.fixture.mjs'
import {
  authorizedHeaders, captureMiddleware, edgeV2Files, editorPrefix, moduleOf, requestTo, sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files,
} from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/compat/v2/v2Reader.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/compat/v2/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const NOW = '2026-10-14T00:00:00.000Z'
const requestIdOf = (n) => `01960000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`

const INPUTS = [
  ['public sample', sampleV2Files, (files) => files.wantToGo.items[0].id],
  // The edge cases' want-to-go item that shares its raw id with a planned footprint record.
  ['3C-1b edge cases', edgeV2Files, () => 'shared-id'],
]

for (const [name, filesOf, pickWish] of INPUTS) {
  test(`new-library mode end to end: ${name}`, async (t) => {
    const { root, paths, directory, closeAfter } = await tempPrivateRoot(t, 'starmap-store-e2e-')
    const files = filesOf()
    const wishId = pickWish(files)
    await writeV2Files(paths, files)
    const v2Digest = async (target = root) => Object.fromEntries(Object.entries(await treeDigest(target)).filter(([file]) => file.startsWith('data/v2/')))
    const v2Before = await v2Digest()
    // The plugin resolves paths and proxies from the environment when it is first imported: only this root, no real values.
    const originalEnvironment = process.env
    process.env = { STARMAP_PRIVATE_ROOT: root }
    let travelAtlasLocalEditor
    try { ({ travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')) } finally { process.env = originalEnvironment }
    let plugin
    // Closed before the temporary root is removed (Windows cannot delete an open store).
    closeAfter({ close: async () => { await plugin?.buildEnd() } })
    const start = (privateRoot) => {
      plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot })
      return captureMiddleware(plugin).handlers[1]
    }
    const update = (handler, input, { id, base }) => requestTo(handler, {
      url: `${editorPrefix}wanttogo/update`, content: Buffer.from(JSON.stringify(input)),
      headers: { ...authorizedHeaders, [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) },
    })
    const reading = async () => {
      const module = await moduleOf(plugin)
      return { revision: module.privateStoreRevision, canonical: servedCanonical(module) }
    }

    await t.test('1. dry run, then --apply', async () => {
      const preview = await previewMigration(paths, { now: NOW })
      assert.equal(preview.ok, true)
      assert.equal(privateDataSource(paths), 'v2')
      const applied = await applyMigration(paths, { now: NOW })
      assert.equal(applied.revision, 1)
      assert.equal(privateDataSource(paths), 'store')
    })

    let handler = start(root)
    await t.test('2. the plugin reads the store as readV2 reads the V2 files', async () => {
      const read = await reading()
      assert.equal(read.revision, 1)
      assert.deepEqual(read.canonical, readV2(files))
    })

    const noteRequest = { id: requestIdOf(1), base: 1 }
    let noteReceipt
    await t.test('3. a note, then the hidden state, through the handler', async () => {
      const note = await update(handler, { id: wishId, note: 'Synthetic end-to-end note' }, noteRequest)
      assert.equal(note.status, 200, JSON.stringify(note.body))
      assert.equal(note.body.revision, 2)
      noteReceipt = note.body.receipt
      const hidden = await update(handler, { id: wishId, hidden: true }, { id: requestIdOf(2), base: 2 })
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body))
      assert.equal(hidden.body.revision, 3)
    })

    await t.test('4. close normally and reopen', async () => {
      await plugin.buildEnd()
      // The writer session ended cleanly: a writable open runs no quick_check.
      const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
      try { assert.equal(handle.openTimings.quickCheckMs, undefined) } finally { await handle.close() }
      handler = start(root)
    })

    let afterEdits
    await t.test('5. the edits are there and the revision is 3', async () => {
      const read = await reading()
      assert.equal(read.revision, 3)
      const item = read.canonical.wantToGo.items.find((candidate) => candidate.id === wishId)
      assert.equal(item.note, 'Synthetic end-to-end note')
      assert.equal(item.hidden, true)
      // Nothing else moved.
      const original = readV2(files)
      assert.deepEqual({ ...read.canonical, wantToGo: original.wantToGo }, original)
      assert.deepEqual(read.canonical.wantToGo.items.filter((candidate) => candidate.id !== wishId), original.wantToGo.items.filter((candidate) => candidate.id !== wishId))
      afterEdits = read.canonical
    })

    await t.test('6. the same request id again: the original receipt, nothing written', async () => {
      const before = await treeDigest(root)
      const replay = await update(handler, { id: wishId, note: 'Synthetic end-to-end note' }, noteRequest)
      assert.equal(replay.status, 200)
      assert.equal(replay.body.duplicate, true)
      assert.deepEqual(replay.body.receipt, noteReceipt)
      assert.equal((await reading()).revision, 3)
      assert.deepEqual(await treeDigest(root), before)
    })

    await t.test('7. a stale base revision: E_STALE', async () => {
      const stale = await update(handler, { id: wishId, note: 'Synthetic stale' }, { id: requestIdOf(3), base: 2 })
      assert.equal(stale.status, 409)
      assert.equal(stale.body.code, 'E_STALE')
      assert.equal((await reading()).revision, 3)
    })

    // The eight editor writes are in store-session-editor.test.mjs, media in store-media-endpoints.test.mjs and
    // store-media-jobs.test.mjs.
    await t.test('8. media: the task list reads the store; an import of an empty Inbox writes nothing', async () => {
      await mkdir(paths.inboxRoot, { recursive: true })
      const before = await treeDigest(root)
      const tasks = await requestTo(handler, { url: `${editorPrefix}media/jobs`, method: 'GET' })
      assert.equal(tasks.status, 200, JSON.stringify(tasks.body))
      assert.deepEqual(tasks.body.jobs, [])
      const imported = await requestTo(handler, {
        url: `${editorPrefix}import`, content: Buffer.from('{}'),
        headers: { ...authorizedHeaders, [STORE_REQUEST_ID_HEADER]: requestIdOf(4), [STORE_BASE_REVISION_HEADER]: '3' },
      })
      assert.equal(imported.status, 200, JSON.stringify(imported.body))
      assert.equal(imported.body.revision, 3)
      assert.deepEqual(imported.body.restoredMediaIds, [])
      assert.equal((await reading()).revision, 3)
      // Only the library lease's generation counter moved (operations/): the import took the lease.
      const outsideOperations = (digest) => Object.fromEntries(Object.entries(digest).filter(([file]) => !file.startsWith('operations/')))
      assert.deepEqual(outsideOperations(await treeDigest(root)), outsideOperations(before))
      assert.deepEqual(await v2Digest(), v2Before)
    })

    const restored = path.join(directory, 'restored')
    await t.test('9. backup, restore to a new root, the same reading', async () => {
      await backupStore(paths, { out: path.join(directory, 'backup'), now: NOW })
      await plugin.buildEnd()
      await restoreStore({ from: path.join(directory, 'backup'), to: restored })
      handler = start(restored)
      const read = await reading()
      assert.equal(read.revision, 3)
      assert.deepEqual(read.canonical, afterEdits)
      await plugin.buildEnd()
      plugin = undefined
    })

    await t.test('10. export-v2 read back equals the reading of step 5', async () => {
      const out = path.join(directory, 'export')
      await exportStoreV2(getPrivatePaths({ STARMAP_PRIVATE_ROOT: restored }), { out })
      const exported = Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [key, JSON.parse(await readFile(path.join(out, V2_FILE_NAMES[key]), 'utf8'))])))
      assert.deepEqual(readV2(exported), afterEdits)
    })

    await t.test('11. ten restores in a row: the file and store_meta keep their size', async () => {
      let from = restored
      const sizes = [], metas = []
      for (let round = 1; round <= 10; round++) {
        const backup = path.join(directory, `chain-backup-${round}`), next = path.join(directory, `chain-root-${round}`)
        await backupStore(getPrivatePaths({ STARMAP_PRIVATE_ROOT: from }), { out: backup, now: NOW })
        await restoreStore({ from: backup, to: next, now: NOW })
        const nextPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: next })
        sizes.push(statSync(storeFileOf(nextPaths)).size)
        const handle = openStore(storeFileOf(nextPaths), { readOnly: true, policy: OFFICIAL_POLICY })
        try {
          const meta = handle.meta()
          metas.push(meta)
          assert.equal(meta.revision, 3)
          assert.equal(meta.restoredFrom.backupId !== undefined, true)
          assert.deepEqual(Object.keys(meta.restoredFrom).sort(), ['backupCreatedAt', 'backupId', 'libraryId', 'restoredAt', 'revision', 'sha256'])
        } finally { await handle.close() }
        from = next
      }
      assert.deepEqual(new Set(sizes).size, 1, `sizes ${sizes.join(', ')}`)
      assert.equal(new Set(metas.map((meta) => JSON.stringify(meta).length)).size, 1)
      assert.equal(new Set(metas.map((meta) => meta.libraryId)).size, 1)
    })
  })
}
