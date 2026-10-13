import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { atomicJsonWrite } from './json-file.mjs'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { createStore, openStore, storePathFor } from './store-host.mjs'
import { recoverLibrary } from './store-recover.mjs'
import { V2_EDITOR_ROUTES, createV2WriteContext, readV2EditorState, runV2Write } from './v2-editor-store.mjs'
import { V2_FILE_KEYS } from '../src/data/canonical/v2Schema.ts'
import { FORMAL_TABLES, readFormalState } from '../src/worldgraph/store/formal.ts'
import { formalFixture, formalFromWorld } from '../src/worldgraph/store/formal.fixture.ts'
import { withFilm } from '../src/worldgraph/store/parity.fixture.ts'
import { applyChangeSet, planCommands } from '../src/worldgraph/store/planner.ts'
import { jsonKey } from '../src/worldgraph/store/primitives.ts'
import { memoryReader } from '../src/worldgraph/store/reader.ts'

const LIBRARY_ID = '01900000-0000-7000-8000-00000000abce'
const NOW = '2026-10-13T00:00:00.000Z'
const worker = fileURLToPath(new URL('./store-host.worker.mjs', import.meta.url))
const recoverScript = fileURLToPath(new URL('./store-recover.mjs', import.meta.url))
const fixtureV2 = fileURLToPath(new URL('./fixtures/editor-store-v2.json', import.meta.url))

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'starmap-store-recover-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('starmap-store-recover-'))
    await rm(directory, { recursive: true, force: true })
  })
  const root = path.join(directory, 'private')
  await mkdir(root)
  return { directory, root, paths: getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }) }
}
const lockPath = (root) => path.join(root, 'operations', 'library-operation.lock')
const exists = (target) => readFile(target).then(() => true, () => false)
/** Hashes of every file under `root` (the generation record included). */
async function snapshot(root) {
  const files = {}
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name)
      if (item.isDirectory()) await walk(target)
      else files[path.relative(root, target)] = createHash('sha256').update(await readFile(target)).digest('hex')
    }
  }
  await walk(root)
  return files
}
const recoverCli = (root, args = []) => spawnSync(process.execPath, [recoverScript, ...args], {
  env: { ...process.env, STARMAP_PRIVATE_ROOT: root }, encoding: 'utf8', timeout: 60_000, windowsHide: true,
})
const quietly = () => {
  const lines = []
  return { lines, log: (line) => lines.push(line), logError: (line) => lines.push(line) }
}

/** Run the worker until it prints `paused:<phase>`, then kill it for real. */
let workerSpecs = 0
async function killedAt(directory, spec, phase) {
  const specFile = path.join(directory, `worker-${++workerSpecs}.json`)
  await writeFile(specFile, JSON.stringify({ ...spec, phase }))
  const child = spawn(process.execPath, [worker, specFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (bytes) => { stderr += bytes })
  const exited = once(child, 'exit')
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`worker timeout before ${phase}: ${stderr}`)), 30_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited (${code}) before ${phase}: ${output} ${stderr}`)) })
      child.stdout.on('data', (bytes) => {
        output += bytes
        if (output.includes(`paused:${phase}\n`)) { clearTimeout(timer); resolve() }
      })
    })
    assert.equal(child.kill('SIGKILL'), true)
    const [code, signal] = await exited
    assert.ok(signal === 'SIGKILL' || (code !== 0 && code !== 94 && code !== 95), `killed, not finished (code ${code}, signal ${signal})`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  }
}

// ---------------------------------------------------------------------------
// V2 mode
// ---------------------------------------------------------------------------

async function v2Library(t, mutate = (files) => files) {
  const context = await tempDirectory(t)
  const files = mutate(JSON.parse(readFileSync(fixtureV2, 'utf8')))
  for (const key of V2_FILE_KEYS) await atomicJsonWrite(context.paths.v2FilePaths[key], files[key])
  return context
}

test('library:recover (V2 mode): a holder killed in its lease, a read-only dry run, then --confirm clears it and writes work again', { timeout: 120_000 }, async (t) => {
  const { directory, root, paths } = await v2Library(t)
  await killedAt(directory, { mode: 'lease', root }, 'leased')
  assert.deepEqual(await inspectLibraryOperation(paths), { state: 'busy', reason: 'lease_present' })
  const owner = JSON.parse(await readFile(lockPath(root), 'utf8')).owner
  const generationBefore = JSON.parse(await readFile(path.join(root, 'operations', 'library-operation-state.json'), 'utf8')).generation
  const before = await snapshot(root)
  const dry = recoverCli(root)
  assert.equal(dry.status, 0, dry.stderr)
  for (const expected of [`持有者：${owner}`, '创建时间：', '与当前私人根一致', 'V2（data/v2/）', '未加 --confirm，没有修改任何文件']) assert.ok(dry.stdout.includes(expected), expected)
  assert.deepEqual(await snapshot(root), before, 'the dry run changes nothing')
  const confirmed = recoverCli(root, ['--confirm'])
  assert.equal(confirmed.status, 0, confirmed.stderr)
  for (const expected of ['请确认持有这个锁的进程已经不在了', '数据检查通过', '已推进库操作记录的 generation']) assert.ok(confirmed.stdout.includes(expected), expected)
  assert.equal(await exists(lockPath(root)), false)
  const after = await inspectLibraryOperation(paths)
  assert.equal(after.state, 'idle')
  assert.notEqual(after.generation, generationBefore, 'recovery advanced the generation')
  // An ordinary V2 write works again.
  const state = (await readV2EditorState({ privatePaths: paths })).body.state
  const written = await withLibraryOperation(paths, () => runV2Write({
    privatePaths: paths, route: V2_EDITOR_ROUTES['PUT /__travelatlas/editor/state'], input: state, ctx: createV2WriteContext({ countryCatalog: new Map() }),
  }))
  assert.equal(written.status, 200, JSON.stringify(written.body))
  const again = recoverCli(root)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /没有库操作锁/)
})

test('library:recover (V2 mode) keeps the lock when the data check fails or the lock is bound elsewhere', { timeout: 120_000 }, async (t) => {
  const { directory, root, paths } = await v2Library(t, (files) => {
    files.wantToGo.items[0].placeId = '01900000-0000-7000-8000-00000000dead'
    return files
  })
  await killedAt(directory, { mode: 'lease', root }, 'leased')
  const before = await snapshot(root)
  const output = quietly()
  assert.equal(await recoverLibrary(paths, { confirm: true, ...output }), 1)
  assert.match(output.lines.join('\n'), /数据检查没有通过（1 项），锁保留/)
  assert.match(output.lines.join('\n'), /引用的地点不存在/)
  assert.deepEqual(await snapshot(root), before, 'lock and generation untouched')
  // A lock written for another root binding is not cleared either.
  const lock = JSON.parse(await readFile(lockPath(root), 'utf8'))
  await writeFile(lockPath(root), JSON.stringify({ ...lock, rootBinding: 'a'.repeat(64) }))
  const moved = quietly()
  assert.equal(await recoverLibrary(paths, { confirm: true, ...moved }), 1)
  assert.match(moved.lines.join('\n'), /绑定的不是当前私人根/)
  assert.equal(await exists(lockPath(root)), true)
})

// ---------------------------------------------------------------------------
// New-store mode
// ---------------------------------------------------------------------------

let requestCounter = 0x500
const nextRequestId = () => `01900000-0000-7000-8000-${(++requestCounter).toString(16).padStart(12, '0')}`
const startState = () => readFormalState({ ...formalFromWorld(withFilm()), viewItems: formalFixture().viewItems, viewSettings: formalFixture().viewSettings })
const createCommands = (state) => FORMAL_TABLES.flatMap((table) => state[table].map((row) => ({ op: 'create', table, value: row })))
const normalized = (state) => jsonKey({
  ...Object.fromEntries(FORMAL_TABLES.map((table) => [table, [...state[table]].sort((a, b) => (a.id < b.id ? -1 : 1))])),
  revision: state.revision,
  tombstones: [...state.tombstones].sort((a, b) => (jsonKey([a.table, a.id]) < jsonKey([b.table, b.id]) ? -1 : 1)),
})

/** A private root in new-store mode: the store at its planned path, seeded with the 3C-1a start state. */
async function storeLibrary(t) {
  const context = await tempDirectory(t)
  const file = storePathFor(context.root)
  await mkdir(path.dirname(file), { recursive: true })
  const seed = startState()
  const handle = await createStore(file, { libraryId: LIBRARY_ID, now: () => NOW, privatePaths: { root: context.root },
    initial: { requestId: nextRequestId(), actor: 'test', commands: createCommands(seed) } })
  await handle.close()
  return { ...context, file, seed }
}
const editRequest = (seed) => ({
  requestId: nextRequestId(), baseRevision: 1, kind: 'test.edit', actor: 'test',
  commands: [{ op: 'update', table: 'entries', id: seed.entries[0].id, expectedRevision: 0, value: { ...seed.entries[0], revision: 1, fields: { rating: 2 } } }],
})

test('library:recover (new-store mode): a writer killed inside its transaction; --confirm checks the store, clears the lock, and the same request commits', { timeout: 120_000 }, async (t) => {
  const { directory, root, file, seed } = await storeLibrary(t)
  const edit = editRequest(seed)
  await killedAt(directory, { mode: 'commit', root, file, now: NOW, request: edit }, 'written')
  assert.equal((await inspectLibraryOperation({ root })).state, 'busy')
  const confirmed = recoverCli(root, ['--confirm'])
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr)
  assert.ok(confirmed.stdout.includes('新库（data/store/world.sqlite）'))
  assert.equal(await exists(lockPath(root)), false)
  const handle = openStore(file, { privatePaths: { root }, now: () => NOW })
  try {
    assert.equal(normalized(handle.readFormalState()), normalized(seed), 'the interrupted transaction left nothing behind')
    assert.deepEqual(handle.lookup(edit.requestId), { found: false })
    const committed = await handle.commit(edit)
    assert.deepEqual([committed.status, committed.revision], ['committed', 2])
  } finally { await handle.close() }
})

test('library:recover (new-store mode) keeps the lock when quick_check or Core validation fails', { timeout: 120_000 }, async (t) => {
  for (const damage of ['page', 'body']) {
    const { directory, root, paths, file, seed } = await storeLibrary(t)
    if (damage === 'page') {
      const db = new DatabaseSync(file, { readOnly: true })
      const pageSize = db.prepare('PRAGMA page_size').get().page_size
      const rootPage = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'anchors'").get().rootpage
      db.close()
      const fd = openSync(file, 'r+')
      try { writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (rootPage - 1) * pageSize) } finally { closeSync(fd) }
    } else {
      // quick_check cannot see a row that breaks a Core rule.
      const db = new DatabaseSync(file)
      db.prepare("UPDATE entities SET body = json_set(body, '$.fields.related', 'missing-entity') WHERE id = ?").run(seed.entities[0].id)
      db.close()
    }
    await killedAt(directory, { mode: 'lease', root }, 'leased')
    const before = await snapshot(root)
    const output = quietly()
    assert.equal(await recoverLibrary(paths, { confirm: true, ...output }), 1, damage)
    assert.match(output.lines.join('\n'), damage === 'page' ? /E_STORE_CORRUPT/ : /E_REFERENCE: entities\.fields/)
    assert.deepEqual(await snapshot(root), before, `${damage}: lock, generation and store untouched`)
  }
})

// ---------------------------------------------------------------------------
// Fault injection: a real writer process killed at each write phase
// ---------------------------------------------------------------------------

const PHASES = ['leased', 'begun', 'deleted', 'written', 'before-commit', 'committed']
const fileHash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
function countRows(file, table) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n } finally { db.close() }
}
/** One request with work in every phase: a delete, an update, and a create large enough (3 MB) to spill
 * SQLite's page cache into the database file before COMMIT, so recovery has a real hot journal to roll back. */
function faultRequest(seed) {
  const [entity] = seed.entities
  const anchor = seed.anchors.find((row) => row.id === 'time-one')
  return {
    requestId: nextRequestId(), baseRevision: 1, kind: 'test.fault', actor: 'test',
    commands: [
      { op: 'remove', table: 'anchors', id: anchor.id, expectedRevision: 0 },
      { op: 'update', table: 'entities', id: entity.id, expectedRevision: 0, value: { ...entity, revision: 1, title: { names: { en: 'Renamed' } } } },
      { op: 'create', table: 'entities', value: { ...entity, id: '01900000-0000-7000-8000-000000000900', source: { ...entity.source, recordId: 'large' },
        fields: { author: 'Synthetic '.repeat(300_000) } } },
    ],
  }
}

test('fault injection: a writer killed at each phase leaves exactly the state before or after; recovery and a same-id retry never write twice', { timeout: 300_000 }, async (t) => {
  const report = []
  for (const phase of PHASES) {
    const { directory, root, paths, file, seed } = await storeLibrary(t)
    const fault = faultRequest(seed)
    const after = applyChangeSet(seed, planCommands(memoryReader(seed), fault.commands, { baseRevision: 1, now: NOW }))
    const bytesBefore = fileHash(file)
    await killedAt(directory, { mode: 'commit', root, file, now: NOW, request: fault }, phase)
    const journal = existsSync(`${file}-journal`)
    const fileChanged = fileHash(file) !== bytesBefore
    assert.equal((await inspectLibraryOperation({ root })).state, 'busy', `${phase}: the killed writer left its lock`)
    // The lock is cleared by library:recover (the real CLI once, the same function otherwise).
    if (phase === 'written') {
      const cli = recoverCli(root, ['--confirm'])
      assert.equal(cli.status, 0, cli.stdout + cli.stderr)
    } else assert.equal(await recoverLibrary(paths, { confirm: true, ...quietly() }), 0, phase)
    assert.equal(await exists(lockPath(root)), false, phase)
    const committed = phase === 'committed'
    const handle = openStore(file, { privatePaths: { root }, now: () => NOW })
    try {
      assert.equal(normalized(handle.readFormalState()), normalized(committed ? after : seed), `${phase}: exactly the state ${committed ? 'after' : 'before'}`)
      assert.equal(handle.lookup(fault.requestId).found, committed, phase)
      assert.equal(countRows(file, 'receipts'), committed ? 2 : 1, phase)
      const retried = await handle.commit(fault)
      assert.deepEqual([retried.status, retried.revision], [committed ? 'duplicate' : 'committed', 2], phase)
      assert.equal(normalized(handle.readFormalState()), normalized(after), `${phase}: after the retry`)
      assert.deepEqual([countRows(file, 'receipts'), countRows(file, 'op_log')], [2, 2], `${phase}: written once`)
      assert.deepEqual(handle.check(), { ok: true, problems: [] }, phase)
    } finally { await handle.close() }
    report.push(`${phase}: ${committed ? 'after' : 'before'} (journal ${journal}, file changed ${fileChanged}), retry ${committed ? 'duplicate' : 'committed'}`)
  }
  t.diagnostic(report.join(' | '))
  assert.ok(report.some((line) => !line.startsWith('committed') && line.includes('journal true, file changed true')),
    'at least one uncommitted phase had already written to the database file, so a hot journal was rolled back')
})
