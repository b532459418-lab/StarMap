import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { STORE_FILE_SEGMENTS, privateDataSource, privateDataState, storeFileOf, storeResidueOf } from './private-data-source.mjs'
import { STORE_RELATIVE_PATH, storePathFor } from './store-host.mjs'
import { libraryMode } from './store-recover.mjs'
import { tempPrivateRoot, writeV2Files, sampleV2Files } from './store-mode.fixture.mjs'

test('the store file is the store host\'s planned location', () => {
  assert.deepEqual(STORE_FILE_SEGMENTS, STORE_RELATIVE_PATH)
  const root = path.resolve('synthetic-private-root')
  assert.equal(storeFileOf({ root }), storePathFor(root))
})

test('a private root is in new-library mode exactly when data/store/world.sqlite exists', async (t) => {
  const { paths } = await tempPrivateRoot(t)
  assert.equal(privateDataSource(paths), 'v2')
  // V2 files, an empty data/store directory or another file there change nothing.
  await writeV2Files(paths, sampleV2Files())
  await mkdir(path.join(paths.dataRoot, 'store'))
  await writeFile(path.join(paths.dataRoot, 'store', 'world.sqlite-journal'), '')
  assert.equal(privateDataSource(paths), 'v2')
  // The file's presence decides, never its content: a store that cannot be opened is still the store.
  await writeFile(storeFileOf(paths), 'not a store')
  assert.equal(privateDataSource(paths), 'store')
})

test('3C-4d: the state of a private root: store, migration-required (V2 or legacy), needs-recovery, empty; the store file decides first', async (t) => {
  const { directory } = await tempPrivateRoot(t)
  const { getPrivatePaths } = await import('./private-profile.mjs')
  let count = 0
  const fresh = async () => {
    const root = path.join(directory, `root-${++count}`)
    await mkdir(root)
    return getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  }
  const journal = (paths) => writeFile(path.join(paths.dataRoot, 'store', 'world.sqlite-journal'), 'synthetic')
  const storeDirectory = (paths) => mkdir(path.join(paths.dataRoot, 'store'), { recursive: true })
  const legacy = async (paths) => { await mkdir(paths.dataRoot, { recursive: true }); await writeFile(paths.localTravelMapPath, '{}') }

  let paths = await fresh()
  assert.deepEqual({ ...privateDataState(paths) }, { state: 'empty', residue: [] })
  await storeDirectory(paths)
  assert.equal(privateDataState(paths).state, 'empty', 'an empty data/store/ is no leftover')
  await journal(paths)
  assert.deepEqual({ ...privateDataState(paths) }, { state: 'needs-recovery', residue: ['world.sqlite-journal'] })

  paths = await fresh()
  await writeV2Files(paths, { places: sampleV2Files().places })
  await legacy(paths)
  assert.deepEqual({ ...privateDataState(paths) }, { state: 'migration-required', reason: 'v2', residue: [] }, 'V2 files present: the legacy file is a leftover')
  await storeDirectory(paths)
  await journal(paths)
  assert.deepEqual({ ...privateDataState(paths) }, { state: 'migration-required', reason: 'v2', residue: ['world.sqlite-journal'] })
  assert.equal(privateDataSource(paths), 'v2')

  paths = await fresh()
  await legacy(paths)
  assert.deepEqual({ ...privateDataState(paths) }, { state: 'migration-required', reason: 'legacy', residue: [] })

  // The store file decides first, whatever else is there (its content is never read).
  await writeV2Files(paths, sampleV2Files())
  await storeDirectory(paths)
  await journal(paths)
  await writeFile(storeFileOf(paths), 'not a store')
  assert.deepEqual({ ...privateDataState(paths) }, { state: 'store', residue: [] })
  assert.deepEqual(storeResidueOf(paths), ['world.sqlite', 'world.sqlite-journal'])
  assert.equal(privateDataSource(paths), 'store')
})

test('library:recover decides the mode with the same function', () => {
  assert.equal(libraryMode, privateDataSource)
})
