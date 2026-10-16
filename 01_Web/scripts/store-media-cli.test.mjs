/**
 * The command lines of the new library's media (3C-4c, design v2 §3 to §7; review §8) on temporary private roots with a
 * migrated synthetic library (./media-inbox.fixture.mjs, ./store-media.fixture.mjs):
 *
 * - media:check is read-only: next to the dev server's open store it writes nothing (not even the library lease);
 *   --verify reports a generated file that changed;
 * - media:import --apply: folder bindings and source matches need their flags (exit 2, nothing written);
 * - --reimport: a file of a deleted record put back is skipped, and imported as a new record only when asked;
 * - --reread: a sidecar changed later is listed by media:check, written by media:import; sources that describe one
 *   record differently are refused;
 * - library:recover lists a backup mark left behind, the deletions it holds and unregistered generated directories,
 *   and with --confirm removes the mark and runs the deletions;
 * - store:export-v2: refused while deletions wait; a record created in the new library with its own content takes V2's
 *   content id, one sharing its content keeps its id; the media source index is written; the losses of going back listed.
 */
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { COLOR, PLACE, imageBytes, importedV2Library, inboxFile, makeImage, writeJson } from './media-inbox.fixture.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { exportStoreV2 } from './store-backup.mjs'
import { openStore } from './store-host.mjs'
import { NOW, UUID_V7, exists, servedLibrary } from './store-media.fixture.mjs'
import { runStoreMediaCli } from './store-media-cli.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { applyMigration } from './store-migrate.mjs'
import { tempPrivateRoot, treeDigest } from './store-mode.fixture.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { recoverLibrary } from './store-recover.mjs'
import { validateV2Files } from '../src/data/canonical/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const cli = async (paths, argv) => {
  const lines = []
  const code = await runStoreMediaCli({ privatePaths: paths, argv, log: (line) => lines.push(String(line)), logError: (line) => lines.push(String(line)) })
  return { code, text: lines.join('\n') }
}
/** The store as a read-only connection sees it: revision, V2 view, registry. */
async function storeState(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    const rows = handle.readRowsUnchecked()
    return { revision: rows.revision, files: projectToV2Files(rows).files, registry: handle.mediaRegistry(), entities: handle.mediaEntities(), problems: handle.check().problems }
  } finally { await handle.close() }
}
const assetAt = (state, portable) => {
  const source = state.registry.sources.find((item) => item.pathKey === pathKeyOf(portable) && item.state === 'present')
  return state.entities.find((entity) => entity.id === source?.recordId)?.fields.asset
}
async function migratedLibrary(t, prefix) {
  const context = await tempPrivateRoot(t, prefix)
  const inbox = await importedV2Library(context.paths, { now: NOW })
  await applyMigration(context.paths, { now: NOW })
  return { ...context, inbox }
}

test('media:check is read-only: next to the dev server\'s open store it writes nothing, not even the lease; --verify reports a changed generated file', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-cli-check-')
  const { paths, root } = library
  assert.equal((await library.reading()).revision, 1, 'the dev server has the store open')
  await makeImage(inboxFile(paths, 'MediaInbox/Synthland/Harbor Town/photos/new.jpg'), { color: COLOR.purple })
  const before = await treeDigest(root)
  const checked = await cli(paths, [])
  assert.equal(checked.code, 0, checked.text)
  assert.match(checked.text, /新资料 1/)
  assert.match(checked.text, /预检通过/)
  assert.deepEqual(await treeDigest(root), before, 'not a byte written, operations/ included')
  // The dev server writes on: an import through it.
  const imported = await library.write('import', {}, 1)
  assert.equal(imported.status, 200, JSON.stringify(imported.body))

  const state = await storeState(paths)
  const [file] = state.registry.files
  await writeFile(path.join(root, ...file.directory.split('/'), file.outputs.find((output) => output.name.endsWith('.webp')).name), 'changed')
  const verified = await cli(paths, ['--verify'])
  assert.equal(verified.code, 0, verified.text)
  assert.match(verified.text, /校验：核对了新库登记的 \d+ 个生成文件。/)
  assert.match(verified.text, /的内容与登记不一致/)
})

test('media:import --apply: folder bindings and source matches need their flags (exit 2, nothing written)', async (t) => {
  const { paths, inbox, root } = await migratedLibrary(t, 'starmap-store-media-cli-import-')
  await unlink(path.join(paths.inboxRoot, 'Synthland', 'Hill Town', 'place.json'))
  await makeImage(inboxFile(paths, 'MediaInbox/Synthland/Hill Town/photos/d.jpg'), { color: COLOR.grey })
  let before = await treeDigest(root)
  let result = await cli(paths, ['--apply'])
  assert.equal(result.code, 2, result.text)
  assert.match(result.text, /--accept-folder-bindings/)
  assert.deepEqual(Object.keys(await treeDigest(root)).filter((file) => !file.startsWith('operations/')), Object.keys(before).filter((file) => !file.startsWith('operations/')))
  assert.equal((await storeState(paths)).revision, 1)
  result = await cli(paths, ['--apply', '--accept-folder-bindings'])
  assert.equal(result.code, 0, result.text)
  assert.ok(await exists(path.join(paths.inboxRoot, 'Synthland', 'Hill Town', 'place.json')))
  let state = await storeState(paths)
  assert.equal(state.revision, 2)
  assert.match(assetAt(state, 'MediaInbox/Synthland/Hill Town/photos/d.jpg'), UUID_V7)
  assert.deepEqual(state.problems, [])

  await writeFile(inboxFile(paths, inbox.a), await imageBytes({ color: COLOR.yellow, width: 90 }))
  before = (await storeState(paths)).revision
  result = await cli(paths, ['--apply'])
  assert.equal(result.code, 2, result.text)
  assert.match(result.text, /--accept-source-matches/)
  assert.equal((await storeState(paths)).revision, before)
  result = await cli(paths, ['--apply', '--accept-source-matches'])
  assert.equal(result.code, 0, result.text)
  state = await storeState(paths)
  assert.equal(state.revision, before + 1)
  assert.deepEqual(state.problems, [])
  // Nothing left to do: exit 0, no commit.
  result = await cli(paths, ['--apply'])
  assert.equal(result.code, 0, result.text)
  assert.match(result.text, /没有需要导入的变化/)
  assert.equal((await storeState(paths)).revision, before + 1)
  // Unknown options and paths outside the Inbox are refused.
  assert.equal((await cli(paths, ['--apply', '--everything'])).code, 1)
  assert.equal((await cli(paths, ['--reread', '../outside'])).code, 1)
})

test('--reimport: a deleted record\'s file put back is skipped, and becomes a new record only when asked', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-cli-reimport-')
  const { paths, inbox } = library
  const bytes = await readFile(inboxFile(paths, inbox.b))
  const assetB = await library.assetAt(inbox.b)
  const revision = await library.hide([assetB], 1)
  const deleted = await library.write('media/delete', { cityId: PLACE.harbor, ids: [assetB] }, revision)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  await library.plugin.buildEnd()
  await writeFile(inboxFile(paths, inbox.b), bytes)
  const count = (await storeState(paths)).files.media.items.length
  let result = await cli(paths, ['--apply'])
  assert.equal(result.code, 0, result.text)
  assert.match(result.text, /已删除不再导入 1/)
  assert.equal((await storeState(paths)).files.media.items.length, count)
  result = await cli(paths, ['--apply', '--reimport', 'Synthland/Harbor Town/photos/b.jpg'])
  assert.equal(result.code, 0, result.text)
  const state = await storeState(paths)
  assert.equal(state.files.media.items.length, count + 1)
  const reimported = assetAt(state, inbox.b)
  assert.match(reimported, UUID_V7)
  assert.notEqual(reimported, assetB)
  assert.equal(state.files.editorState.mediaOrderByCity[PLACE.harbor].at(-1), reimported, 'an explicit addition joins its city order')
  assert.equal((await cli(paths, ['--apply', '--reimport', 'Synthland/Harbor Town/photos/never.jpg'])).code, 1)
})

test('--reread: a sidecar changed later is listed by media:check and written by media:import; sources describing one record differently are refused', async (t) => {
  const { paths, inbox, root } = await migratedLibrary(t, 'starmap-store-media-cli-reread-')
  const sidecar = path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json')
  await writeJson(sidecar, { 'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama, renamed', date: '2026-08-01', resolution: '200 × 100' } })
  const plain = await cli(paths, [])
  assert.match(plain.text, /说明有变化、没有生效（1）/)
  const before = await treeDigest(root)
  const preview = await cli(paths, ['--reread', 'MediaInbox/Second Land/River Town'])
  assert.equal(preview.code, 0, preview.text)
  assert.match(preview.text, /其中 1 条有变化/)
  assert.match(preview.text, /date/)
  assert.match(preview.text, /title/)
  assert.deepEqual(await treeDigest(root), before)
  const written = await cli(paths, ['--apply', '--reread', 'Second Land/River Town'])
  assert.equal(written.code, 0, written.text)
  let state = await storeState(paths)
  const pano = state.files.media.items.find((item) => item.id === assetAt(state, inbox.pano))
  assert.equal(pano.date, '2026-08-01')
  assert.deepEqual(pano.title, { names: { en: 'Synthetic panorama, renamed' } })
  assert.deepEqual(state.problems, [])
  assert.doesNotMatch((await cli(paths, [])).text, /说明有变化/, 'the source records the description it now has')

  // a.jpg and a-copy.jpg are one record (V2 merged them); a-copy moved to another city describes it differently.
  await rename(inboxFile(paths, inbox.aCopy), inboxFile(paths, 'MediaInbox/Synthland/Hill Town/photos/a-copy.jpg'))
  assert.equal((await cli(paths, ['--apply'])).code, 0)
  const revision = (await storeState(paths)).revision
  const conflict = await cli(paths, ['--apply', '--reread', 'Synthland'])
  assert.equal(conflict.code, 1, conflict.text)
  assert.match(conflict.text, /互相冲突/)
  state = await storeState(paths)
  assert.equal(state.revision, revision)
})

test('library:recover lists a backup mark left behind, the deletions it holds and unregistered directories; --confirm removes the mark and runs them', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-cli-recover-')
  const { paths, inbox, root } = library
  const mark = path.join(root, 'operations', 'store-backup', '01960000-0000-7000-8000-00000000b001.json')
  await writeJson(mark, { format: 'starmap.store-backup.media-copy', backupId: '01960000-0000-7000-8000-00000000b001', startedAt: NOW, pid: 1 })
  const assetB = await library.assetAt(inbox.b)
  const revision = await library.hide([assetB], 1)
  const deleted = await library.write('media/delete', { cityId: PLACE.harbor, ids: [assetB] }, revision)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.match(deleted.body.output, /备份正在复制媒体/)
  await library.plugin.buildEnd()
  const orphan = path.join(root, 'media', 'user', '0123456789abcdef')
  await mkdir(orphan, { recursive: true })
  await copyFile(inboxFile(paths, inbox.a), path.join(orphan, 'original.jpg'))
  const lines = []
  const log = (line) => lines.push(String(line))
  const before = await treeDigest(root)
  assert.equal(await recoverLibrary(paths, { policy: OFFICIAL_POLICY, log, logError: log }), 0)
  const listed = lines.join('\n')
  assert.match(listed, /备份标记 1 个，等待删除的文件 2 个，没有登记的生成目录 1 个/)
  assert.match(listed, /未加 --confirm，没有修改任何文件/)
  assert.deepEqual(await treeDigest(root), before)
  assert.equal(await recoverLibrary(paths, { confirm: true, policy: OFFICIAL_POLICY, log, logError: log }), 0)
  assert.equal(await exists(mark), false)
  assert.equal(await exists(inboxFile(paths, inbox.b)), false)
  assert.equal(await exists(path.join(orphan, 'original.jpg')), true, 'an unregistered directory is only listed')
  const state = await storeState(paths)
  assert.deepEqual(state.registry.pendingFileOps, [])
  assert.deepEqual(state.problems, [])
})

test('store:export-v2: refused while deletions wait; own content takes V2\'s content id, shared content keeps its id; index and losses', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-cli-export-')
  const { paths, inbox, root, directory } = library
  const own = await library.upload(await imageBytes({ color: COLOR.purple }), { fileName: 'own.jpg' })
  const shared = await library.upload(await readFile(inboxFile(paths, inbox.a)), { fileName: 'a-again.jpg' })
  const imported = await library.write('import', { sourcePaths: [own.body.sourcePath, shared.body.sourcePath] }, 1)
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  const [ownId, sharedId] = imported.body.restoredMediaIds
  // A deletion held by a backup mark: the export waits for it.
  const mark = path.join(root, 'operations', 'store-backup', '01960000-0000-7000-8000-00000000b002.json')
  await writeJson(mark, { format: 'starmap.store-backup.media-copy', backupId: '01960000-0000-7000-8000-00000000b002', startedAt: NOW, pid: 1 })
  const assetC = await library.assetAt(inbox.c)
  const city = (await library.reading()).files.media.items.find((item) => item.id === assetC).placeId
  let revision = await library.hide([assetC], imported.body.revision)
  const deleted = await library.write('media/delete', { cityId: city, ids: [assetC] }, revision)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  await assert.rejects(exportStoreV2(paths, { out: path.join(directory, 'refused'), now: NOW }), { code: 'E_EXPORT_PENDING_FILE_OPS' })
  assert.equal(await exists(path.join(directory, 'refused')), false)
  await unlink(mark)
  revision = deleted.body.revision
  const drained = await library.write('import', {}, revision)
  assert.equal(drained.status, 200, JSON.stringify(drained.body))
  await library.plugin.buildEnd()

  const result = await exportStoreV2(paths, { out: path.join(directory, 'export'), now: NOW })
  const ownSha = (await storeState(paths)).registry.sources.find((source) => source.pathKey === pathKeyOf(`MediaInbox/${own.body.sourcePath}`)).sha256
  assert.deepEqual([...result.remapped], [[ownId, `media-${ownSha.slice(0, 16)}`]])
  const ids = result.files.media.items.map((item) => item.id)
  assert.ok(ids.includes(`media-${ownSha.slice(0, 16)}`) && !ids.includes(ownId))
  assert.ok(ids.includes(sharedId), 'a record sharing its content keeps its id')
  assert.deepEqual(validateV2Files(result.files), [])
  assert.ok(Object.values(result.files.editorState.mediaOrderByCity).flat().includes(`media-${ownSha.slice(0, 16)}`), 'the city order follows the new id')
  const index = JSON.parse(await readFile(path.join(directory, 'export', 'media-source-index.local.json'), 'utf8'))
  assert.deepEqual(index.sourcesById[`media-${ownSha.slice(0, 16)}`], [own.body.sourcePath])
  assert.deepEqual(index.sourcesById[sharedId], [shared.body.sourcePath])
  assert.equal(index.sourcesById[assetC], undefined, 'a deleted record is gone')
  // Back in V2, one content is one item: the shared record merges into a.jpg's.
  assert.deepEqual(result.losses.removed, [sharedId])
  assert.ok(result.lines.some((line) => line === `  移除 ${sharedId}`))
})
