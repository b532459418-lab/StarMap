import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { createBrowserFixture, enterDamagedStoreMode, enterStoreMode, fixtureFileNames } from './browser-fixture.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { checkStoreFile, openStore } from './store-host.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { createStoreSession } from './store-session.mjs'
import { tempPrivateRoot, treeDigest } from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

test('the browser fixture is in V2 mode by default and in the new-library mode on request', async (t) => {
  const { root, paths, directory } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  await createBrowserFixture(root)
  assert.equal(privateDataSource(paths), 'v2')
  const storeRoot = path.join(directory, 'store-root')
  const files = await createBrowserFixture(storeRoot, { mode: 'store' })
  const storePaths = { root: storeRoot }
  assert.equal(privateDataSource(storePaths), 'store')
  const handle = openStore(storeFileOf(storePaths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(projectToV2Files(handle.readRowsUnchecked()).projection.canonical, readV2(files)) } finally { await handle.close() }
  await assert.rejects(createBrowserFixture(path.join(directory, 'other'), { mode: 'legacy' }), /Unknown browser fixture mode/)
})

test('a case switches the shared fixture into the new-library mode and back, leaving the V2 files exactly as they were', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  const pristine = await createBrowserFixture(root)
  // An earlier case edited a V2 file.
  const travelFile = path.join(root, 'data', 'v2', fixtureFileNames.travel)
  const edited = (await readFile(travelFile, 'utf8')).replace('"records": [', '"records": [ ')
  await writeFile(travelFile, edited)
  const leave = await enterStoreMode(root)
  assert.equal(privateDataSource(paths), 'store')
  // The store holds the fixture's own content.
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(projectToV2Files(handle.readRowsUnchecked()).projection.canonical, readV2(pristine)) } finally { await handle.close() }
  // Entering again while the store is still there keeps it.
  const again = await enterStoreMode(root)
  assert.equal(privateDataSource(paths), 'store')
  await leave()
  assert.equal(privateDataSource(paths), 'v2')
  assert.equal(existsSync(path.join(root, 'data', 'store')), false)
  assert.equal(await readFile(travelFile, 'utf8'), edited)
  await again()
})

test('a case switches the shared fixture into the new-library mode with a damaged store: the session shows it read-only (3C-4b)', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-browser-fixture-')
  const pristine = await createBrowserFixture(root)
  const v2Before = await treeDigest(path.join(root, 'data', 'v2'))
  const leave = await enterDamagedStoreMode(root)
  assert.equal(privateDataSource(paths), 'store')
  assert.equal(existsSync(path.join(root, 'operations', 'store-staging')), false, 'the staging root is gone')
  assert.deepEqual(await treeDigest(path.join(root, 'data', 'v2')), v2Before, 'the V2 files are not touched')
  assert.equal((await checkStoreFile(storeFileOf(paths), { policy: OFFICIAL_POLICY })).ok, false)
  const session = createStoreSession(paths, { log: () => {} })
  try {
    const read = await session.moduleExports()
    assert.equal(read.readOnly, true)
    assert.deepEqual(readV2(read.files), readV2(pristine))
  } finally { await session.close() }
  await leave()
  assert.equal(privateDataSource(paths), 'v2')
})
