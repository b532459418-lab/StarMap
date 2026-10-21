/**
 * The host's read model and `store:export-read-model` (3C-5A spec §2.2, §2.3). Temporary private roots under the OS
 * temp directory, neutral synthetic data only: Core's formal fixture with seeded random batches, the public sample,
 * and the synthetic media library of ./media-inbox.fixture.mjs.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { importedV2Library } from './media-inbox.fixture.mjs'
import { webRoot } from './private-profile.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { createStore, openStore, withoutLibraryLock } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { exportStoreReadModel, parseExportArguments, runExportReadModelCli } from './store-read-model.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { sampleV2Files, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { publicReadModelOf } from '../src/data/store/publicReadModel.ts'
import { readModelOf } from '../src/worldgraph/readModel/build.ts'
import { validateReadModel } from '../src/worldgraph/readModel/check.ts'
import { applyReadModelDelta } from '../src/worldgraph/readModel/delta.ts'
import { FORMAL_TABLES } from '../src/worldgraph/store/formal.ts'
import { formalFixture, worldFromFormal } from '../src/worldgraph/store/formal.fixture.ts'
import { generator, randomBatch } from '../src/worldgraph/store/parity.fixture.ts'
import { applyChangeSet, planCommands } from '../src/worldgraph/store/planner.ts'
import { StoreError } from '../src/worldgraph/store/primitives.ts'
import { memoryReader } from '../src/worldgraph/store/reader.ts'
import { NOW as FIXTURE_NOW } from '../src/worldgraph/store/store.fixture.ts'

const NOW = '2026-10-20T00:00:00.000Z'
const LIBRARY_ID = '01900000-0000-7000-8000-00000000abcd'
const quiet = { log: () => {}, logError: () => {} }
let requestCounter = 0
const requestId = () => `01970000-0000-7000-8000-${(++requestCounter).toString(16).padStart(12, '0')}`

/** A migrated public sample in a temporary private root (store mode). */
async function sampleStore(t) {
  const context = await tempPrivateRoot(t, 'starmap-read-model-')
  await writeV2Files(context.paths, sampleV2Files())
  await applyMigration(context.paths, { now: NOW, libraryId: LIBRARY_ID })
  return context
}

for (const seed of [3, 47]) test(`readModel(): after every committed random batch it equals the previous read model plus the batch's change set (seed ${seed})`, async (t) => {
  const { directory, closeAfter } = await tempPrivateRoot(t, 'starmap-read-model-')
  const file = path.join(directory, 'world.sqlite')
  const handle = closeAfter(await createStore(file, { libraryId: LIBRARY_ID, now: () => NOW, lock: withoutLibraryLock }))
  // The formal fixture, created row by row in table order.
  let state = formalFixture()
  const seedCommands = FORMAL_TABLES.flatMap((table) => state[table].map((value) => ({ op: 'create', table, value })))
  await handle.commit({ requestId: requestId(), baseRevision: 0, kind: 'test.seed', actor: 'test', commands: seedCommands })
  state = { ...state, revision: 1 }
  let model = handle.readModel()
  assert.deepEqual(model, readModelOf(handle.readFormalState(), { origin: 'local' }))
  assert.equal(model.origin, 'local'); assert.equal(model.revision, 1)
  const random = generator(seed), counter = { n: 500000 + seed * 1000 }
  let committed = 0
  for (let step = 0; step < 40; step++) {
    const { commands } = randomBatch(worldFromFormal(state), random, counter)
    if (!commands.length) continue
    let changeSet
    try { changeSet = planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: FIXTURE_NOW }) } catch (error) {
      if (!(error instanceof StoreError)) throw error
      await assert.rejects(handle.commit({ requestId: requestId(), baseRevision: state.revision, kind: 'test.random', actor: 'test', commands }))
      continue
    }
    const result = await handle.commit({ requestId: requestId(), baseRevision: state.revision, kind: 'test.random', actor: 'test', commands })
    assert.equal(result.status, 'committed')
    state = applyChangeSet(state, changeSet)
    model = applyReadModelDelta(model, changeSet)
    assert.deepEqual(model, handle.readModel(), `step ${step}`)
    committed++
  }
  assert.ok(committed >= 10, `enough committed steps (${committed})`)
})

test('readModel() never carries the host\'s own tables: no Inbox path, registry hash, receipt id or tombstoned id', async (t) => {
  const context = await tempPrivateRoot(t, 'starmap-read-model-')
  const { paths, closeAfter } = context
  await importedV2Library(paths, { now: NOW })
  const migrationRequest = requestId()
  await applyMigration(paths, { now: NOW, libraryId: LIBRARY_ID, requestId: migrationRequest })
  const handle = closeAfter(openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY }))
  // A removal (a tombstone and a receipt of its own).
  const before = handle.readModel()
  const removed = before.viewItems[0]
  const removal = requestId()
  await handle.commit({ requestId: removal, baseRevision: before.revision, kind: 'test.remove', actor: 'test',
    commands: [{ op: 'remove', table: 'viewItems', id: removed.id, expectedRevision: removed.revision }] })
  const text = JSON.stringify(handle.readModel())
  const registry = handle.mediaRegistry()
  assert.ok(registry.sources.length > 0 && registry.files.length > 0, 'the library has a media registry')
  const db = rawConnection(storeFileOf(paths))
  let receipts, tombstones
  try {
    receipts = db.prepare('SELECT request_id FROM receipts').all().map((row) => row.request_id)
    tombstones = db.prepare('SELECT id FROM tombstones').all().map((row) => row.id)
  } finally { db.close() }
  assert.ok(receipts.includes(migrationRequest) && receipts.includes(removal) && tombstones.includes(removed.id))
  const secrets = [
    ...registry.sources.flatMap((source) => [source.path, source.pathKey, source.sha256]),
    ...registry.files.map((file) => file.sha256), ...registry.scanCache.flatMap((entry) => [entry.pathKey, entry.sha256]),
    ...receipts, ...tombstones,
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const secret of new Set(secrets)) assert.ok(!text.includes(secret), 'a host-only value is in the read model')
  assert.ok(!text.includes('MediaInbox'))
  for (const key of ['tombstones', 'reviews', 'receipts', 'op_log', 'id_map', 'pending_file_ops']) assert.ok(!text.includes(`"${key}"`), key)
})

test('store:export-read-model writes the full read model to a new file, checked in full', async (t) => {
  const { directory, paths } = await sampleStore(t)
  const out = path.join(directory, 'exports', 'library.read-model.json')
  const result = await exportStoreReadModel(paths, { out })
  const written = JSON.parse(await readFile(out, 'utf8'))
  assert.doesNotThrow(() => validateReadModel(written, OFFICIAL_POLICY))
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(written, JSON.parse(JSON.stringify(handle.readModel()))) } finally { await handle.close() }
  assert.equal(written.revision, 1); assert.equal(written.origin, 'local')
  assert.match(result.lines[0], /完整读模型/)
  assert.ok(result.lines.some((line) => /^行数：sources \d+，/.test(line)))
})

test('store:export-read-model --public publishes only public entities and what they need', async (t) => {
  const { directory, paths } = await sampleStore(t)
  // Make one city public through an ordinary commit.
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  const model = handle.readModel()
  const city = model.entities.find((row) => row.fields.subtype === 'city')
  await handle.commit({ requestId: requestId(), baseRevision: model.revision, kind: 'test.visibility', actor: 'test',
    commands: [{ op: 'update', table: 'entities', id: city.id, expectedRevision: city.revision, value: { ...city, revision: city.revision + 1, visibility: 'public' } }] })
  const full = handle.readModel()
  await handle.close()
  const out = path.join(directory, 'public.read-model.json')
  const result = await exportStoreReadModel(paths, { out, publicOnly: true })
  const written = JSON.parse(await readFile(out, 'utf8'))
  assert.deepEqual(written, JSON.parse(JSON.stringify(publicReadModelOf(full))))
  assert.deepEqual(written.entities.map((row) => row.id), [city.id])
  assert.ok(written.entries.length > 0 && written.entries.every((row) => row.entityId === city.id))
  assert.doesNotThrow(() => validateReadModel(written, OFFICIAL_POLICY))
  assert.match(result.lines[0], /公开读模型/)
  assert.ok(result.lines.some((line) => line.startsWith('没有公开、未导出：')))
  assert.ok(result.lines.some((line) => line.includes('overviewTarget') && line.includes('原始文件名')), 'the export says what else it publishes and leaves out')
})

test('store:export-read-model refuses an existing file, a V2 root and an output inside the repository, writing nothing', async (t) => {
  const { directory, paths } = await sampleStore(t)
  const existing = path.join(directory, 'existing.json')
  await writeFile(existing, 'keep')
  await assert.rejects(exportStoreReadModel(paths, { out: existing }), (error) => error.code === 'E_TARGET_EXISTS')
  assert.equal(await readFile(existing, 'utf8'), 'keep')
  const inside = path.join(webRoot, 'read-model-export-test.json')
  await assert.rejects(exportStoreReadModel(paths, { out: inside }), (error) => error.code === 'E_PRIVATE_OUTPUT')
  await assert.rejects(readFile(inside), (error) => error.code === 'ENOENT')
  const v2 = await tempPrivateRoot(t, 'starmap-read-model-')
  await mkdir(v2.paths.v2DataRoot, { recursive: true })
  await assert.rejects(exportStoreReadModel(v2.paths, { out: path.join(v2.directory, 'out.json') }), (error) => error.code === 'E_NOT_STORE_MODE')
  await assert.rejects(readFile(path.join(v2.directory, 'out.json')), (error) => error.code === 'ENOENT')
})

test('the command line: arguments, exit codes', async (t) => {
  assert.deepEqual(parseExportArguments(['--out', 'x.json']), { out: 'x.json', publicOnly: false })
  assert.deepEqual(parseExportArguments(['--public', '--out', 'x.json']), { out: 'x.json', publicOnly: true })
  for (const argv of [[], ['--public'], ['--out'], ['--out', '--public'], ['--out', 'a', '--out', 'b'], ['--public', '--public', '--out', 'a'], ['--all', '--out', 'a']]) {
    assert.equal(parseExportArguments(argv), undefined, argv.join(' '))
  }
  const { directory, paths } = await sampleStore(t)
  const errors = []
  assert.equal(await runExportReadModelCli([], { privatePaths: paths, ...quiet, logError: (line) => errors.push(line) }), 1)
  assert.match(errors[0], /用法/)
  const lines = []
  assert.equal(await runExportReadModelCli(['--out', path.join(directory, 'cli.json')], { privatePaths: paths, log: (line) => lines.push(line), logError: () => {} }), 0)
  assert.ok(lines.some((line) => line.includes('cli.json')))
  assert.equal(await runExportReadModelCli(['--out', path.join(directory, 'cli.json')], { privatePaths: paths, ...quiet }), 1)
})
