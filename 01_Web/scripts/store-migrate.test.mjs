import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { MIGRATION_KIND, StoreToolError, applyMigration, previewMigration, readV2Inputs, runMigrateCli } from './store-migrate.mjs'
import { compareWithV2, projectToV2Files } from './store-projection.mjs'
import { edgeV2Files, quietly, sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files } from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { OFFICIAL_POLICY, V2_SOURCES } from '../src/data/store/officialDefinitions.ts'

const NOW = '2026-10-14T00:00:00.000Z'
const migrateScript = fileURLToPath(new URL('./store-migrate.mjs', import.meta.url))

for (const [name, files] of [['public sample', sampleV2Files], ['3C-1b edge cases', edgeV2Files]]) {
  test(`the dry run of the ${name} plans in memory, matches readV2 and the derived baseline, and writes nothing`, async (t) => {
    const { root, paths } = await tempPrivateRoot(t)
    await writeV2Files(paths, files())
    const before = await treeDigest(root)
    const preview = await previewMigration(paths, { now: NOW })
    assert.equal(preview.ok, true)
    assert.deepEqual({ ...preview.comparison }, { ok: true, canonical: true, baseline: true })
    assert.equal(preview.storeExists, false)
    assert.ok(preview.lines.some((line) => line.startsWith('比对：Canonical 与 readV2 一致；派生基线 一致')))
    assert.deepEqual(await treeDigest(root), before)
    assert.equal(privateDataSource(paths), 'v2')
  })
}

test('the dry run reports the kept extension keys and the unresolved view elements', async (t) => {
  const { paths } = await tempPrivateRoot(t)
  await writeV2Files(paths, edgeV2Files())
  const preview = await previewMigration(paths, { now: NOW })
  assert.ok(Object.keys(preview.report.extensionKeys).length > 0)
  assert.ok(Object.keys(preview.report.unresolvedViewElements).length > 0)
  const text = preview.lines.join('\n')
  for (const scope of Object.keys(preview.report.unresolvedViewElements)) assert.ok(text.includes(scope), scope)
  for (const kind of Object.keys(preview.report.extensionKeys)) assert.ok(text.includes(kind), kind)
})

test('a refused migration writes nothing and lists every problem without values', async (t) => {
  const { root, paths } = await tempPrivateRoot(t)
  const files = sampleV2Files()
  files.wantToGo.items.push({ ...files.wantToGo.items[0] }) // the same id twice
  files.travel.records[0].placeId = 'synthetic-missing-place'
  await writeV2Files(paths, files)
  const before = await treeDigest(root)
  for (const run of [() => previewMigration(paths, { now: NOW }), () => applyMigration(paths, { now: NOW })]) {
    const error = await run().then(() => undefined, (failure) => failure)
    assert.ok(error instanceof StoreToolError)
    assert.equal(error.code, 'E_MIGRATION_REFUSED')
    assert.ok(error.problems.length >= 2, error.problems.join('\n'))
    assert.ok(error.problems.every((line) => !line.includes('synthetic-missing-place')))
    assert.deepEqual(await treeDigest(root), before)
  }
  // A file that is not JSON is named, never quoted.
  await writeFile(paths.v2FilePaths.travel, '{"secret value": ')
  const unreadable = await readV2Inputs(paths).then(() => undefined, (failure) => failure)
  assert.equal(unreadable.code, 'E_V2_UNREADABLE')
  assert.deepEqual(unreadable.problems, ['data/v2/travel-map.local.json：不是合法的 JSON'])
})

test('--apply creates the store under the lease, keeps the identity ledger, closes cleanly and leaves the V2 files alone', async (t) => {
  const { root, paths } = await tempPrivateRoot(t)
  const files = sampleV2Files()
  await writeV2Files(paths, files)
  const v2Before = Object.fromEntries(Object.entries(await treeDigest(root)).filter(([file]) => file.startsWith('data/v2/')))
  const requestId = '01960000-0000-7000-8000-00000000a001'
  const applied = await applyMigration(paths, { now: NOW, requestId })
  assert.equal(applied.revision, 1)
  assert.equal(applied.comparison.ok, true)
  assert.equal(privateDataSource(paths), 'store')
  const after = await treeDigest(root)
  for (const [file, digest] of Object.entries(v2Before)) assert.equal(after[file], digest, file)
  assert.equal(existsSync(path.join(root, 'operations', 'library-operation.lock')), false)

  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    // A clean close: the writable open ran no quick_check (clean_shutdown was 1).
    assert.equal(handle.openTimings.quickCheckMs, undefined)
    assert.equal(handle.meta().libraryId, applied.libraryId)
    const wish = files.wantToGo.items[0]
    const entryId = handle.getIdMapping('entry', V2_SOURCES.wantToGo, wish.id)
    assert.match(entryId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    assert.equal(handle.read((reader) => reader.get('entries', entryId)).source.recordId, wish.id)
    const rows = handle.readRowsUnchecked()
    assert.deepEqual(projectToV2Files(rows).projection.canonical, readV2(files))
    assert.ok(compareWithV2(projectToV2Files(handle.readFormalState()).projection, files).ok)
    // The first request is the migration, with its receipt.
    const receipt = handle.lookup(requestId)
    assert.equal(receipt.found, true)
    assert.equal(receipt.receipt.kind, MIGRATION_KIND)
    assert.equal(receipt.receipt.revision, 1)
  } finally { await handle.close() }
})

test('--apply refuses an existing store, a held lease and a failed check, and leaves no new store behind', async (t) => {
  const { root, paths } = await tempPrivateRoot(t)
  await writeV2Files(paths, sampleV2Files())

  // A held lease: E_LIBRARY_BUSY, nothing created.
  await withLibraryOperation(paths, async () => {
    const busy = await applyMigration(paths, { now: NOW }).then(() => undefined, (failure) => failure)
    assert.equal(busy?.code, 'E_LIBRARY_BUSY')
  })
  assert.equal(existsSync(path.join(root, 'data', 'store')), false)

  // A failed parity check deletes the store it created (and the directory it created).
  const mismatch = await applyMigration(paths, { now: NOW, compare: () => ({ ok: false, canonical: false, baseline: true }) })
    .then(() => undefined, (failure) => failure)
  assert.equal(mismatch?.code, 'E_MIGRATION_MISMATCH')
  assert.equal(existsSync(path.join(root, 'data', 'store')), false)
  assert.equal(privateDataSource(paths), 'v2')
  assert.equal(existsSync(path.join(root, 'operations', 'library-operation.lock')), false)

  // An existing store file is never touched.
  await applyMigration(paths, { now: NOW })
  const before = await treeDigest(root)
  const again = await applyMigration(paths, { now: NOW }).then(() => undefined, (failure) => failure)
  assert.equal(again?.code, 'E_STORE_EXISTS')
  const after = await treeDigest(root)
  assert.equal(after['data/store/world.sqlite'], before['data/store/world.sqlite'])
})

test('the command line previews by default, applies with --apply and refuses unknown arguments', async (t) => {
  const { paths } = await tempPrivateRoot(t)
  await writeV2Files(paths, sampleV2Files())
  const output = quietly()
  assert.equal(await runMigrateCli(['--force'], { privatePaths: paths, ...output }), 1)
  const cli = (args) => spawnSync(process.execPath, [migrateScript, ...args], {
    env: { ...process.env, STARMAP_PRIVATE_ROOT: paths.root }, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  })
  const preview = cli([])
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /预演通过，没有写入任何文件/)
  assert.equal(privateDataSource(paths), 'v2')
  const applied = cli(['--apply'])
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(applied.stdout, /已创建 data\/store\/world\.sqlite/)
  assert.equal(privateDataSource(paths), 'store')
  const refused = cli(['--apply'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /已经存在，拒绝执行/)
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.equal(handle.meta().revision, 1) } finally { await handle.close() }
})
