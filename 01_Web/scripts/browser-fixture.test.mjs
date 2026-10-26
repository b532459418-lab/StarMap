/**
 * The browser tests' synthetic root (./browser-fixture.mjs; 3C-4d): a store by default, a root that needs migrating on
 * request; reads through the projection; resets and patches by commits that keep media items (review §7-1); media
 * imported through the media service; the damaged store of the 3C-4b case.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import {
  createBrowserFixture, enterDamagedStoreMode, fixtureFileNames, fixtureHashes, fixtureIds, importInboxMedia, patchFixture, readFixtureFiles,
  resetFixture, setStoreAside, storeRevisionOf,
} from './browser-fixture.mjs'
import { privateDataSource, privateDataState, storeFileOf } from './private-data-source.mjs'
import { checkStoreFile, openStore } from './store-host.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, createStoreSession } from './store-session.mjs'
import { tempPrivateRoot, treeDigest } from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/compat/v2/v2Reader.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'

test('the browser fixture is a store by default, V2 files that need migrating on request', async (t) => {
  const { root, paths, directory } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  const files = await createBrowserFixture(root)
  assert.equal(privateDataSource(paths), 'store')
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(projectToV2Files(handle.readRowsUnchecked()).projection.canonical, readV2(files)) } finally { await handle.close() }
  assert.equal(await storeRevisionOf(root), 1)
  const v2Root = path.join(directory, 'v2-root')
  await createBrowserFixture(v2Root, { mode: 'v2' })
  const v2Paths = { ...paths, root: v2Root }
  assert.equal(privateDataState(v2Paths).state, 'migration-required')
  assert.deepEqual(await readFixtureFiles(v2Root), JSON.parse(JSON.stringify(files)))
  assert.equal(await storeRevisionOf(v2Root), undefined)
  await assert.rejects(createBrowserFixture(path.join(directory, 'other'), { mode: 'legacy' }), /Unknown browser fixture mode/)
})

test('a case patches the store with one commit and the next case resets it to the fixture; no dev server needed', async (t) => {
  const { root } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  await createBrowserFixture(root)
  const pristine = await fixtureHashes(root)
  assert.equal(pristine.revision, 1)
  // Resetting a store that already holds the fixture commits nothing.
  await createBrowserFixture(root)
  assert.deepEqual(await fixtureHashes(root), pristine)

  const revision = await patchFixture(root, 'wantToGo', (file) => { file.items.find((item) => item.placeId === fixtureIds.nuuk).note = 'Synthetic patched note' })
  assert.equal(revision, 2)
  const patched = await readFixtureFiles(root)
  assert.equal(patched.wantToGo.items.find((item) => item.placeId === fixtureIds.nuuk).note, 'Synthetic patched note')
  // 3C-5 D: the V2 files are not rewritten (a change under data/v2/ would reload the open pages); the store is the data.
  const v2 = JSON.parse(await readFile(path.join(root, 'data', 'v2', fixtureFileNames.wantToGo), 'utf8'))
  assert.notEqual(v2.items.find((item) => item.placeId === fixtureIds.nuuk).note, 'Synthetic patched note')
  assert.notDeepEqual(await fixtureHashes(root), pristine)

  await createBrowserFixture(root)
  const reset = await fixtureHashes(root)
  assert.equal(reset.revision, 3)
  assert.deepEqual({ ...reset, revision: 1 }, pristine)
})

test('3C-5 E: a reset brings back what a case deleted, under fresh ids where a tombstone holds the old ones', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  await createBrowserFixture(root)
  const pristine = await fixtureHashes(root)
  // Akureyri's want-to-go item: its city stays (footprint records use it). A deleted place cannot come back: its id is its
  // V2 id and a tombstone holds it (E_RECREATE_ID), as before 3C-5 E.
  const files = await readFixtureFiles(root)
  const akureyri = files.places.places.find((place) => place.names.en === 'Akureyri')
  const wish = files.wantToGo.items.find((item) => item.placeId === akureyri.id)
  assert.ok(wish, 'the fixture has a want-to-go item on Akureyri')
  // The case hides and deletes it through the editor endpoints (its entry and view rows are tombstoned).
  const session = createStoreSession(paths, { log: () => {} })
  try {
    const write = (route, revision, input, id) => session.writeRoute('POST', `/__travelatlas/editor/${route}`)({
      headers: { [STORE_REQUEST_ID_HEADER]: `01960000-0000-7000-8000-00000000f00${id}`, [STORE_BASE_REVISION_HEADER]: String(revision) }, input,
    })
    const hidden = await write('wanttogo/update', 1, { id: wish.id, hidden: true }, 1)
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body))
    const deleted = await write('wanttogo/delete', hidden.body.revision, { ids: [wish.id] }, 2)
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  } finally { await session.close() }
  assert.equal((await readFixtureFiles(root)).wantToGo.items.some((item) => item.id === wish.id), false)
  await createBrowserFixture(root)
  const reset = await fixtureHashes(root)
  assert.deepEqual({ ...reset, revision: 1 }, pristine)
  // The next reset keeps the rows the first one gave fresh ids (their keys are held): nothing to write.
  await createBrowserFixture(root)
  assert.deepEqual(await fixtureHashes(root), reset)
})

test('media imported through the media service stay through a reset; their hidden list and covers are reset (review §7-1)', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  await createBrowserFixture(root)
  const city = path.join(paths.inboxRoot, 'Iceland', 'Reykjavik')
  await mkdir(path.join(city, 'photos'), { recursive: true })
  await writeFile(path.join(paths.inboxRoot, 'Iceland', 'place.json'), JSON.stringify({ placeId: fixtureIds.iceland }))
  await writeFile(path.join(city, 'place.json'), JSON.stringify({ placeId: fixtureIds.reykjavik }))
  await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 60, g: 120, b: 180 } } }).jpeg().toFile(path.join(city, 'photos', 'cover-harbour.jpg'))
  assert.equal(await importInboxMedia(root), 2)
  let files = await readFixtureFiles(root)
  const [photo] = files.media.items
  assert.equal(files.media.items.length, 1)
  assert.equal(photo.placeId, fixtureIds.reykjavik)
  assert.equal(photo.isCover, true)
  await patchFixture(root, 'editorState', (state) => { state.hiddenMediaIds = [photo.id] })
  assert.deepEqual((await readFixtureFiles(root)).editorState.hiddenMediaIds, [photo.id])
  await createBrowserFixture(root)
  files = await readFixtureFiles(root)
  assert.deepEqual(files.media.items.map((item) => item.id), [photo.id], 'the media item stays')
  assert.deepEqual(files.editorState.hiddenMediaIds, [], 'its hidden state is reset')
})

test('resetFixture on a root without a store writes the V2 files', async (t) => {
  const { root } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  const files = await createBrowserFixture(root, { mode: 'v2' })
  files.wantToGo.items[0].note = 'Synthetic V2 note'
  assert.equal(await resetFixture(root, files), undefined)
  assert.equal((await readFixtureFiles(root)).wantToGo.items[0].note, 'Synthetic V2 note')
})

test('the damaged store of the 3C-4b case: the fixture\'s store set aside, a damaged one read-only in its place, then all put back', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  const pristine = await createBrowserFixture(root)
  const storeBefore = await treeDigest(path.join(root, 'data', 'store'))
  const v2Before = await treeDigest(path.join(root, 'data', 'v2'))
  const restore = await setStoreAside(root)
  assert.equal(typeof restore, 'function')
  assert.equal(privateDataState(paths).state, 'migration-required')
  const leave = await enterDamagedStoreMode(root)
  assert.equal(privateDataSource(paths), 'store')
  assert.equal(existsSync(path.join(root, 'operations', 'store-staging')), false, 'the staging root is gone')
  assert.deepEqual(await treeDigest(path.join(root, 'data', 'v2')), v2Before, 'the V2 files are not touched')
  assert.equal((await checkStoreFile(storeFileOf(paths), { policy: OFFICIAL_POLICY })).ok, false)
  const session = createStoreSession(paths, { log: () => {} })
  try {
    const read = await session.moduleExports()
    assert.equal(read.readOnly, true)
    assert.deepEqual(officialViewOf(read.model, 'local'), readV2(pristine))
  } finally { await session.close() }
  await leave()
  assert.equal(privateDataSource(paths), 'v2')
  await restore()
  assert.equal(privateDataSource(paths), 'store')
  assert.deepEqual(await treeDigest(path.join(root, 'data', 'store')), storeBefore)
  assert.equal(existsSync(path.join(root, 'operations', 'store-aside')), false)
})
