import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { STORE_FILE_SEGMENTS, privateDataSource, storeFileOf } from './private-data-source.mjs'
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

test('library:recover decides the mode with the same function', () => {
  assert.equal(libraryMode, privateDataSource)
})
