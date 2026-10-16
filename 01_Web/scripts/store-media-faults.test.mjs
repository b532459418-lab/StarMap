/**
 * Fault injection for the new library's media writes (3C-4c, design v2 §4 and the v1 interruption table): a child
 * process (./store-media-crash.fixture.mjs) dies at a chosen point with SIGKILL, so the library lock stays as after a
 * crash. Each case checks what was left, that library:recover lists it and clears the lock with --confirm, and that the
 * library ends consistent (check() passes, the registry and the files agree):
 *   1. an import killed after its generated files, before its commit: the store unchanged, the generated directory
 *      unregistered; the next import registers it, reusing the files;
 *   2. a deletion killed after its commit, before its file run: the records gone, the deletions queued; recovery runs them;
 *   3. the queued deletions killed half-way: one file gone, the queue intact; the next run finishes it.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256File } from './file-hash.mjs'
import { COLOR, PLACE, inboxFile, makeImage, writeJson } from './media-inbox.fixture.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { directoryOf, pathKeyOf } from './store-media-registry.mjs'
import { openStore } from './store-host.mjs'
import { NOW, exists, servedLibrary } from './store-media.fixture.mjs'
import { runStoreMediaCli } from './store-media-cli.mjs'
import { mediaLeftovers, recoverLibrary } from './store-recover.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const crashScript = fileURLToPath(new URL('./store-media-crash.fixture.mjs', import.meta.url))
const crash = (root, scenario, input) => {
  const environment = { ...process.env }
  for (const key of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete environment[key]
  const result = spawnSync(process.execPath, [crashScript, root, scenario, ...(input ? [JSON.stringify(input)] : [])], { encoding: 'utf8', timeout: 120_000, windowsHide: true, env: environment })
  assert.doesNotMatch(result.stdout, /not killed/, result.stderr)
  assert.notEqual(result.status, 0, 'the child died')
  return result
}
async function storeState(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    const rows = handle.readRowsUnchecked()
    return { revision: rows.revision, registry: handle.mediaRegistry(), problems: handle.check().problems }
  } finally { await handle.close() }
}
const lockOf = (paths) => path.join(paths.root, 'operations', 'library-operation.lock')
const quiet = () => {
  const lines = []
  return { lines, log: (line) => lines.push(String(line)), logError: (line) => lines.push(String(line)) }
}
/** library:recover as the user runs it: first without, then with --confirm. Returns the listing's text. */
async function recover(paths) {
  const listing = quiet()
  assert.equal(await recoverLibrary(paths, { policy: OFFICIAL_POLICY, ...listing }), 0, listing.lines.join('\n'))
  const confirmed = quiet()
  assert.equal(await recoverLibrary(paths, { confirm: true, policy: OFFICIAL_POLICY, ...confirmed }), 0, confirmed.lines.join('\n'))
  return listing.lines.join('\n')
}

test('fault 1: an import killed after its generated files, before its commit; recovery, then the next import reuses them', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-fault-import-')
  const { paths } = library
  await library.plugin.buildEnd()
  const file = 'MediaInbox/Synthland/Harbor Town/photos/crash.jpg'
  await makeImage(inboxFile(paths, file), { color: COLOR.purple })
  const sha256 = await sha256File(inboxFile(paths, file))
  const generated = path.join(paths.root, ...directoryOf(sha256).split('/'))
  crash(paths.root, 'import-before-commit')
  let state = await storeState(paths)
  assert.equal(state.revision, 1, 'nothing committed')
  assert.equal(state.registry.files.some((row) => row.sha256 === sha256), false)
  assert.equal(await exists(path.join(generated, 'original.jpg')), true, 'the generated files were written')
  assert.equal(await exists(lockOf(paths)), true, 'the lock stays after a crash')
  await assert.rejects(runStoreMediaCli({ privatePaths: paths, argv: ['--apply'], ...quiet() }), { code: 'E_LIBRARY_BUSY' })
  const listed = await recover(paths)
  assert.match(listed, /没有登记的生成目录 1 个/)
  assert.equal(await exists(lockOf(paths)), false)
  const imported = quiet()
  assert.equal(await runStoreMediaCli({ privatePaths: paths, argv: ['--apply'], ...imported }), 0, imported.lines.join('\n'))
  state = await storeState(paths)
  assert.equal(state.revision, 2)
  const row = state.registry.files.find((item) => item.sha256 === sha256)
  assert.ok(row)
  for (const output of row.outputs) assert.equal(await sha256File(path.join(generated, output.name)), output.sha256)
  assert.deepEqual((await mediaLeftovers(paths, { policy: OFFICIAL_POLICY })).unregistered, [])
  assert.deepEqual(state.problems, [])
})

test('fault 2: a deletion killed after its commit, before its file run; recovery runs the queued deletions', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-fault-delete-')
  const { paths, inbox } = library
  const assetB = await library.assetAt(inbox.b)
  const sha256 = (await storeState(paths)).registry.sources.find((source) => source.pathKey === pathKeyOf(inbox.b)).sha256
  await library.hide([assetB], 1)
  await library.plugin.buildEnd()
  crash(paths.root, 'delete-after-commit', { cityId: PLACE.harbor, ids: [assetB] })
  let state = await storeState(paths)
  assert.equal(state.revision, 3, 'the deletion committed')
  assert.equal(state.registry.pendingFileOps.length, 2)
  assert.equal(await exists(inboxFile(paths, inbox.b)), true, 'no file removed yet')
  const listed = await recover(paths)
  assert.match(listed, /等待删除的文件 2 个/)
  assert.equal(await exists(lockOf(paths)), false)
  assert.equal(await exists(inboxFile(paths, inbox.b)), false)
  assert.equal(await exists(path.join(paths.root, ...directoryOf(sha256).split('/'))), false)
  state = await storeState(paths)
  assert.deepEqual(state.registry.pendingFileOps, [])
  assert.deepEqual(state.problems, [])
})

test('fault 3: the queued deletions killed half-way; the next run finishes them', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-fault-drain-')
  const { paths, inbox, root } = library
  const mark = path.join(root, 'operations', 'store-backup', '01960000-0000-7000-8000-00000000b003.json')
  await writeJson(mark, { format: 'starmap.store-backup.media-copy', backupId: '01960000-0000-7000-8000-00000000b003', startedAt: NOW, pid: 1 })
  const assetA = await library.assetAt(inbox.a)
  const sha256 = (await storeState(paths)).registry.sources.find((source) => source.pathKey === pathKeyOf(inbox.a)).sha256
  const revision = await library.hide([assetA], 1)
  const deleted = await library.write('media/delete', { cityId: PLACE.harbor, ids: [assetA] }, revision)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  await library.plugin.buildEnd()
  await unlink(mark)
  assert.equal((await storeState(paths)).registry.pendingFileOps.length, 3, 'a.jpg, a-copy.jpg and the generated directory')
  crash(paths.root, 'drain-midway')
  let state = await storeState(paths)
  assert.equal(state.registry.pendingFileOps.length, 3, 'nothing settled')
  const left = [await exists(inboxFile(paths, inbox.a)), await exists(inboxFile(paths, inbox.aCopy))]
  assert.deepEqual(left.filter(Boolean).length, 1, 'the first source file was removed, the second not yet')
  await recover(paths)
  for (const file of [inbox.a, inbox.aCopy]) assert.equal(await exists(inboxFile(paths, file)), false)
  assert.equal(await exists(path.join(paths.root, ...directoryOf(sha256).split('/'))), false)
  state = await storeState(paths)
  assert.deepEqual(state.registry.pendingFileOps, [])
  assert.deepEqual(state.problems, [])
})
