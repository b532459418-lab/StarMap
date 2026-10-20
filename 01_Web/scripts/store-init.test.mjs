/**
 * The empty new library of a private root without any data (3C-4d, decision D-b A; review §8-1): ./store-init.mjs.
 *
 * - It is initialized in the formal model directly: one first request (kind store.create-empty) with the official
 *   definitions and the provenance sources of the editing rules; the projection is five empty V2 files, and no V2 file
 *   is written.
 * - Only the state 'empty' gets a library: V2 data, legacy data, a leftover under data/store/ and an existing store are
 *   refused (E_STORE_NOT_EMPTY) without writing anything; a held library lease is E_LIBRARY_BUSY.
 * - The caller's lease is joined (store:migrate's empty path).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { privateDataState, storeFileOf } from './private-data-source.mjs'
import { checkStoreFile, openStore } from './store-host.mjs'
import { EMPTY_LIBRARY_ACTOR, EMPTY_LIBRARY_KIND, createEmptyLibrary, emptyLibraryCommands } from './store-init.mjs'
import { sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files } from './store-mode.fixture.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { OFFICIAL_POLICY, V2_SOURCES } from '../src/data/store/officialDefinitions.ts'

const NOW = '2026-10-20T00:00:00.000Z'
const LIBRARY_ID = '01960000-0000-7000-8000-0000000c4d01'
const REQUEST_ID = '01960000-0000-7000-8000-0000000c4d02'

test('an empty root gets a library in the formal model: the official definitions and the editing rules\' sources, no V2 file', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-store-init-')
  assert.equal(privateDataState(paths).state, 'empty')
  const created = await createEmptyLibrary(paths, { now: NOW, libraryId: LIBRARY_ID, requestId: REQUEST_ID })
  assert.deepEqual(created, { libraryId: LIBRARY_ID, revision: 1 })
  assert.equal(privateDataState(paths).state, 'store')
  assert.equal(existsSync(paths.v2DataRoot), false, 'never through the V2 reader: no V2 file is made up')
  assert.equal(existsSync(path.join(root, 'operations', 'library-operation.lock')), false, 'the lease is released')
  assert.deepEqual((await checkStoreFile(storeFileOf(paths), { policy: OFFICIAL_POLICY })).problems, [])

  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    assert.equal(handle.openTimings.quickCheckMs, undefined, 'closed cleanly')
    assert.equal(handle.meta().libraryId, LIBRARY_ID)
    const receipt = handle.lookup(REQUEST_ID)
    assert.equal(receipt.found, true)
    assert.equal(receipt.receipt.kind, EMPTY_LIBRARY_KIND)
    assert.equal(receipt.receipt.revision, 1)
    for (const id of Object.values(V2_SOURCES)) assert.ok(handle.read((reader) => reader.get('sources', id)), id)
    const { files } = projectToV2Files(handle.readRowsUnchecked())
    assert.deepEqual(files.places.places, [])
    assert.deepEqual(files.travel.records, [])
    assert.deepEqual(files.wantToGo.items, [])
    assert.deepEqual(files.media.items, [])
    assert.deepEqual(handle.mediaRegistry().files, [])
  } finally { await handle.close() }
  assert.equal(EMPTY_LIBRARY_ACTOR, 'store:init')
  assert.ok(emptyLibraryCommands().length > Object.keys(V2_SOURCES).length)
})

test('only an empty root gets a library: V2 data, legacy data, a leftover under data/store/ and a store are refused, nothing written', async (t) => {
  const { directory } = await tempPrivateRoot(t, 'starmap-store-init-refused-')
  const cases = {
    v2: async (paths) => writeV2Files(paths, sampleV2Files()),
    legacy: async (paths) => { await mkdir(paths.dataRoot, { recursive: true }); await writeFile(paths.localTravelMapPath, '{"schema_version":1,"records":[]}') },
    residue: async (paths) => { await mkdir(path.dirname(storeFileOf(paths)), { recursive: true }); await writeFile(`${storeFileOf(paths)}-journal`, 'synthetic') },
    store: async (paths) => createEmptyLibrary(paths, { now: NOW }),
  }
  const { getPrivatePaths } = await import('./private-profile.mjs')
  for (const [name, arrange] of Object.entries(cases)) {
    const root = path.join(directory, name)
    await mkdir(root)
    const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
    await arrange(paths)
    const before = await treeDigest(root)
    const refused = await createEmptyLibrary(paths, { now: NOW }).then(() => undefined, (error) => error)
    assert.equal(refused?.code, 'E_STORE_NOT_EMPTY', name)
    const after = await treeDigest(root)
    const outside = (digest) => Object.fromEntries(Object.entries(digest).filter(([file]) => !file.startsWith('operations/')))
    assert.deepEqual(outside(after), outside(before), name)
  }
})

test('a held library lease refuses (E_LIBRARY_BUSY, nothing created); the caller\'s own lease is joined', async (t) => {
  const { paths } = await tempPrivateRoot(t, 'starmap-store-init-lease-')
  await withLibraryOperation(paths, async () => {
    const busy = await createEmptyLibrary(paths, { now: NOW }).then(() => undefined, (error) => error)
    assert.equal(busy?.code, 'E_LIBRARY_BUSY')
  })
  assert.equal(existsSync(path.dirname(storeFileOf(paths))), false)
  const created = await withLibraryOperation(paths, (leaseToken) => createEmptyLibrary(paths, { now: NOW, leaseToken }))
  assert.equal(created.revision, 1)
  assert.equal(privateDataState(paths).state, 'store')
})
