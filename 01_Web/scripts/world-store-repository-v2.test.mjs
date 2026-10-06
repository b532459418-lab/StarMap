import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { seed, createRequest, stageRequest, acceptRequest } from './world-store-repository.fixture.mjs'
import { createWorldRepository } from './world-store-repository.mjs'
import { previewRepositoryUpgrade } from './world-store-upgrade-preview.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { createRepositoryV2, openRepositoryV2, replayRepositoryV2 } from './world-store-repository-v2.mjs'
async function setup(t, options = {}) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-writable-v2-'))
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-writable-v2-')); return rm(root, { recursive: true, force: true }) })
  const source = path.join(root, 'old.sqlite'), file = path.join(root, 'new.sqlite')
  const old = createWorldRepository(source, seed()); old.close()
  const envelope = previewRepositoryUpgrade(source, { libraryId: 'library', branchId: 'branch', genesisId: 'genesis' }).envelope
  return { file, envelope, repository: createRepositoryV2(file, envelope, options) }
}
test('facts, full request, snapshots and receipt survive reopen and exact retry', async t => {
  const { file, repository } = await setup(t), request = createRequest()
  const receipt = repository.apply(request), snapshot = repository.snapshot(); repository.close()
  const reopened = openRepositoryV2(file)
  try {
    assert.deepEqual(reopened.snapshot(), snapshot); assert.deepEqual(reopened.apply(request), receipt)
    assert.deepEqual(snapshot.history[0].request, request); assert.equal(snapshot.history.length, 1)
    assert.deepEqual(reopened.findOperation(request.id), receipt)
    assert.throws(() => reopened.apply({ ...request, expectedRevision: 1 }), e => e.code === 'E_REPO_OPERATION_CONFLICT')
  } finally { reopened.close() }
})
test('proposal acceptance history replays with fact, review and status', async t => {
  const { repository } = await setup(t)
  try { repository.apply(stageRequest()); repository.apply(acceptRequest()); const value = repository.snapshot(); assert.deepEqual(replayRepositoryV2(value), value); assert.equal(value.state.proposals[0].status, 'accepted'); assert.equal(value.state.world.reviews.length, 1) }
  finally { repository.close() }
})
test('stale second connection rejected and readonly host cannot write', async t => {
  const { file, repository } = await setup(t), other = openRepositoryV2(file), readonly = openRepositoryV2(file, { readOnly: true })
  try { repository.apply(createRequest()); assert.throws(() => other.apply(stageRequest()), e => e.code === 'E_REPO_STALE'); assert.throws(() => readonly.apply(stageRequest()), e => e.code === 'E_REPO_READONLY'); assert.equal(other.snapshot().history.length, 1) }
  finally { repository.close(); other.close(); readonly.close() }
})
for (const phase of ['locked', 'state-written', 'before-commit', 'committed']) test(`exception at ${phase} keeps atomic history and state`, async t => {
  const { file, repository } = await setup(t, { unsafeTestPhase(name) { if (name === phase) throw new Error('synthetic failure') } })
  assert.throws(() => repository.apply(createRequest())); repository.close()
  const reopened = openRepositoryV2(file)
  try { assert.equal(reopened.snapshot().history.length, phase === 'committed' ? 1 : 0); assert.equal(reopened.snapshot().state.revision, phase === 'committed' ? 1 : 0) }
  finally { reopened.close() }
})
test('self-consistent fingerprints cannot conceal impossible request semantics', async t => {
  const { repository } = await setup(t)
  try {
    repository.apply(createRequest()); const value = structuredClone(repository.snapshot())
    value.history[0].request.action.commands[0].value.fields.note = 'different'
    value.history[0].requestDigest = digest(value.history[0].request)
    assert.throws(() => replayRepositoryV2(value), e => e.code === 'E_REPO_V2_REPLAY')
  } finally { repository.close() }
})
test('nested receipt discovery refuses ownership of outer transaction', async t => {
  let active
  const { repository } = await setup(t, { unsafeTestPhase(name) { if (name === 'state-written') assert.throws(() => active.findOperation('create'), e => e.code === 'E_REPO_BUSY') } })
  active = repository
  try { repository.apply(createRequest()); assert.equal(repository.snapshot().history.length, 1) }
  finally { repository.close() }
})

test('incremental storage keeps compact logs; another connection invalidates cached state', async t => {
  const { file, repository } = await setup(t), other = openRepositoryV2(file)
  try {
    repository.apply(createRequest())
    assert.equal(other.state().revision, 1)
    const db = new DatabaseSync(file)
    try {
      const row = db.prepare('SELECT payload FROM operation_history').get()
      assert.equal(Object.hasOwn(JSON.parse(row.payload), 'after'), false)
      const state = repository.state(), corrupted = { ...state, revision: 2 }
      db.prepare('UPDATE repository_current SET payload=?,digest=?').run(JSON.stringify(corrupted), digest(corrupted))
    } finally { db.close() }
    assert.throws(() => repository.state(), e => e.code === 'E_REPO_V2_CHAIN')
    assert.throws(() => other.snapshot(), e => e.code === 'E_REPO_V2_CHAIN')
  } finally { repository.close(); other.close() }
})

test('legacy whole-envelope storage remains read-only and is preserved for explicit new-file upgrade', async t => {
  const { file, envelope, repository } = await setup(t); repository.close()
  const legacy = path.join(path.dirname(file), 'legacy.sqlite'), db = new DatabaseSync(legacy)
  try {
    db.exec('CREATE TABLE repository_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT')
    db.exec('PRAGMA application_id=1397573429; PRAGMA user_version=2')
    db.prepare('INSERT INTO repository_v2 VALUES (1,?,?)').run(JSON.stringify(envelope), digest(envelope))
  } finally { db.close() }
  const before = await readFile(legacy)
  assert.throws(() => openRepositoryV2(legacy), e => e.code === 'E_REPO_UPGRADE_REQUIRED')
  const readonly = openRepositoryV2(legacy, { readOnly: true })
  try { assert.deepEqual(readonly.snapshot(), envelope); assert.throws(() => readonly.apply(createRequest()), e => e.code === 'E_REPO_UPGRADE_REQUIRED') }
  finally { readonly.close() }
  assert.deepEqual(await readFile(legacy), before)
})
for (const phase of ['locked', 'state-written', 'before-commit', 'committed']) test(`killed writer at ${phase} recovers state and full history together`, async t => {
  const { file, repository } = await setup(t); repository.close()
  const spec = path.join(path.dirname(file), 'worker.json'), request = createRequest()
  // Spill beyond the default cache to exercise hot-journal recovery.
  if (phase === 'state-written') request.action.commands[0].value.fields.note = 'Synthetic '.repeat(350000)
  await writeFile(spec, JSON.stringify({ file, request, phase }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-repository-v2.worker.mjs', import.meta.url)), spec], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume(); const exited = once(child, 'exit'); exited.catch(() => {})
  try {
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('V2 worker timeout')), 10000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('V2 worker exited before phase')) })
      child.stdout.on('data', bytes => { output += bytes; if (output.includes(`paused:${phase}\n`)) { clearTimeout(timer); resolve() } })
    })
    assert.equal(child.kill('SIGKILL'), true); const [code, signal] = await exited
    assert.ok(signal === 'SIGKILL' || (code !== null && code !== 0))
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
  const reopened = openRepositoryV2(file)
  try {
    const committed = phase === 'committed', value = reopened.snapshot()
    assert.equal(value.history.length, committed ? 1 : 0); assert.equal(value.state.revision, committed ? 1 : 0)
    assert.equal(Boolean(reopened.findOperation(request.id)), committed)
    assert.equal(reopened.apply(request).repositoryRevision, 1)
    assert.equal(reopened.snapshot().history.length, 1)
  } finally { reopened.close() }
})
