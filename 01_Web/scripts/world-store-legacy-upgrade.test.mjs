import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { seed, createRequest, stageRequest, acceptRequest, candidate, id } from './world-store-repository.fixture.mjs'
import { createWorldRepository, openWorldRepository } from './world-store-repository.mjs'
import { previewLegacyRepositoryUpgrade, upgradeLegacyRepositoryToDirectory } from './world-store-legacy-upgrade.mjs'
import { discoverRepositoryFork, openRepositoryBranch, previewRepositoryFork, forkRepositoryToDirectory } from './world-store-branch.mjs'
import { previewRepositoryBranchBackup, backupRepositoryBranch, previewRepositoryBranchRestore, restoreRepositoryBranch } from './world-store-branch-backup.mjs'
const host = { hostId: 'test-host' }
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)
function noop(revision, name = 'create') {
  return { id: name, expectedRevision: revision, action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: seed().world.entries[0] }] } }
}
async function setup(t) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-legacy-upgrade-'))
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-legacy-upgrade-')); return rm(root, { recursive: true, force: true }) })
  const source = path.join(root, 'old.sqlite'), target = path.join(root, 'upgraded'), old = createWorldRepository(source, seed())
  try {
    old.apply(createRequest())
    const stage = stageRequest(); stage.expectedRevision = 1; stage.action.proposal.baseRevision = old.snapshot().world.revision
    old.apply(stage); old.apply({ ...acceptRequest(), expectedRevision: 2 })
    old.apply({ id: 'remove', expectedRevision: 3, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
    const pending = candidate(); pending.id = 'pending-kept'; pending.baseRevision = old.snapshot().world.revision
    pending.commands[0].value.id = id(70); pending.commands[0].value.source.recordId = 'pending-record'
    old.apply({ id: 'pending', expectedRevision: 4, action: { kind: 'stage-proposal', proposal: pending } })
  } finally { old.close() }
  return { root, source, target, preview: previewLegacyRepositoryUpgrade(source) }
}
const upgrade = (value, options = {}) => upgradeLegacyRepositoryToDirectory(value.source, value.target, value.preview, 'upgrade', { ...host, ...options })
test('preview preserves complete old state/receipts without allocating identity or changing bytes', async t => {
  const value = await setup(t), before = await readFile(value.source), preview = previewLegacyRepositoryUpgrade(value.source)
  assert.deepEqual(preview, value.preview); assert.equal(preview.source.identity, null)
  assert.equal(preview.source.identityStatus, 'unknown'); assert.equal(preview.archive.coverage, 'baselineOnly')
  assert.equal(preview.archive.editBodies, 'unavailable'); assert.equal(preview.archive.receipts.length, 5)
  assert.deepEqual(await readFile(value.source), before)
  assert.equal(discoverRepositoryFork(value.target).status, 'absent')
})
test('direct writable upgrade preserves facts, stable IDs, ledger, tombstones, reviews and revision', async t => {
  const value = await setup(t), before = await readFile(value.source), result = upgrade(value)
  assert.equal(result.status, 'completed'); assert.equal(result.descriptor.origin.kind, 'upgrade')
  for (const name of ['libraryId', 'branchId', 'genesisId']) assert.match(result.descriptor.identity[name], /^[a-f0-9-]{36}$/)
  const branch = openRepositoryBranch(value.target, host)
  let receipt, request
  try {
    const snapshot = branch.snapshot()
    assert.deepEqual(snapshot.state, value.preview.archive.state)
    assert.deepEqual(snapshot.sourceArchive, value.preview.archive)
    assert.deepEqual(snapshot.state.proposals.map(p => p.status), ['accepted', 'pending'])
    assert.equal(snapshot.state.retired.length, 1); assert.equal(snapshot.state.identities.identities.length, 1)
    assert.equal(snapshot.state.world.reviews.length, 1); assert.equal(snapshot.history.length, 0)
    for (const name of ['create', 'stage', 'accept', 'remove', 'pending']) assert.equal(branch.findOperation(name), undefined)
    request = noop(5); receipt = branch.apply(request)
    assert.equal(receipt.repositoryRevision, 6); assert.deepEqual(branch.apply(request), receipt)
    const resurrection = createRequest(); delete resurrection.identities; resurrection.expectedRevision = 6
    rejects(() => branch.apply(resurrection), 'E_REPO_OPERATION_CONFLICT')
  } finally { branch.close() }
  const reopened = openRepositoryBranch(value.target, host)
  try { assert.deepEqual(reopened.apply(request), receipt); assert.equal(reopened.snapshot().history.length, 1) } finally { reopened.close() }
  assert.deepEqual(await readFile(value.source), before)
})
test('tombstones and pending proposal are functional after upgrade, not just copied text', async t => {
  const value = await setup(t); upgrade(value)
  const branch = openRepositoryBranch(value.target, host)
  try {
    const request = createRequest(); delete request.identities; request.id = 'resurrect'; request.expectedRevision = 5
    rejects(() => branch.apply(request), 'E_REPO_RETIRED_ID')
    assert.equal(branch.apply({ id: 'reject-local', expectedRevision: 5, action: { kind: 'reject-proposal', proposalId: 'pending-kept' } }).status, 'committed')
    assert.deepEqual(branch.state().proposals.map(p => p.status), ['accepted', 'rejected'])
  } finally { branch.close() }
})
test('old request fingerprints and receipt values remain exact archived evidence', async t => {
  const value = await setup(t), old = openWorldRepository(value.source)
  try {
    for (const row of value.preview.archive.receipts) {
      const { requestDigest, ...receipt } = row
      assert.match(requestDigest, /^[a-f0-9]{64}$/); assert.deepEqual(receipt, old.findOperation(row.operationId))
    }
  } finally { old.close() }
})
test('completed retry finds the same permanent identity after source is moved and child changes', async t => {
  const value = await setup(t), result = upgrade(value), branch = openRepositoryBranch(value.target, host)
  try { branch.apply(noop(5)) } finally { branch.close() }
  await rename(value.source, path.join(value.root, 'moved.sqlite'))
  assert.deepEqual(upgrade(value), result)
  rejects(() => upgradeLegacyRepositoryToDirectory(value.source, value.target, value.preview, 'other', host), 'E_BRANCH_EXISTS')
})
test('different old snapshots are not assumed to share permanent identity', async t => {
  const value = await setup(t), first = upgrade(value)
  const second = upgrade({ ...value, target: path.join(value.root, 'another') })
  assert.notEqual(first.descriptor.identity.libraryId, second.descriptor.identity.libraryId)
  assert.equal(first.descriptor.origin.source.identity, null)
  assert.equal(second.descriptor.origin.source.identity, null)
})
test('source changes after preview refuse before target creation', async t => {
  const value = await setup(t), old = openWorldRepository(value.source)
  try { old.apply(noop(5, 'later')) } finally { old.close() }
  rejects(() => upgrade(value), 'E_BRANCH_SOURCE_CHANGED')
  assert.equal(discoverRepositoryFork(value.target).status, 'absent')
})
test('source lock covers final seal and refuses competing commit', async t => {
  const value = await setup(t), before = await readFile(value.source), old = openWorldRepository(value.source)
  try {
    upgrade(value, { unsafeTestPhase(name) { if (name === 'before-seal') rejects(() => old.apply(noop(5, 'competing')), 'E_REPO_OUTCOME_UNKNOWN') } })
    assert.equal(old.findOperation('competing'), undefined)
    assert.deepEqual(await readFile(value.source), before)
    assert.equal(old.apply(noop(5, 'after')).status, 'committed')
  } finally { old.close() }
})
test('WAL or corrupt receipt cannot create a writable upgrade', async t => {
  const value = await setup(t), db = new DatabaseSync(value.source)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    rejects(() => previewLegacyRepositoryUpgrade(value.source), 'E_REPO_SETTINGS')
    db.exec('PRAGMA journal_mode=DELETE')
    db.prepare('UPDATE operation_receipts SET request_digest=? WHERE id=?').run('bad', 'create')
    assert.throws(() => upgrade(value))
    assert.equal(discoverRepositoryFork(value.target).status, 'absent')
  } finally { db.close() }
})
test('tampered preview, getter and existing directory are refused without overwrite', async t => {
  const value = await setup(t), preview = structuredClone(value.preview)
  preview.source.repositoryRevision++
  rejects(() => upgradeLegacyRepositoryToDirectory(value.source, value.target, preview, 'upgrade', host), 'E_BRANCH_PREVIEW')
  let calls = 0
  Object.defineProperty(preview, 'archive', { enumerable: true, get() { calls++; return {} } })
  assert.throws(() => upgradeLegacyRepositoryToDirectory(value.source, value.target, preview, 'upgrade', host)); assert.equal(calls, 0)
  await mkdir(value.target); await writeFile(path.join(value.target, 'keep'), 'unchanged')
  rejects(() => upgrade(value), 'E_BRANCH_INCOMPLETE')
  assert.equal(await readFile(path.join(value.target, 'keep'), 'utf8'), 'unchanged')
})
test('upgraded library can fork, back up and restore with unknown old origin still explicit', async t => {
  const value = await setup(t), result = upgrade(value), branch = openRepositoryBranch(value.target, host)
  try { branch.apply(noop(5)) } finally { branch.close() }
  const next = path.join(value.root, 'forked'), file = path.join(value.target, 'world.sqlite')
  const forked = forkRepositoryToDirectory(file, next, previewRepositoryFork(file), 'next', host)
  assert.equal(forked.descriptor.identity.libraryId, result.descriptor.identity.libraryId)
  const backup = path.join(value.root, 'backup'), restored = path.join(value.root, 'restored')
  backupRepositoryBranch(value.target, backup, previewRepositoryBranchBackup(value.target), 'backup')
  restoreRepositoryBranch(backup, restored, previewRepositoryBranchRestore(backup), 'restore', host)
  const restoredBranch = openRepositoryBranch(restored, host)
  try {
    const snapshot = restoredBranch.snapshot()
    assert.equal(snapshot.state.revision, 6)
    assert.equal(snapshot.sourceArchive.sourceArchive.coverage, 'baselineOnly')
    assert.equal(snapshot.sourceArchive.sourceArchive.editBodies, 'unavailable')
    assert.equal(restoredBranch.findOperation('create'), undefined)
  } finally { restoredBranch.close() }
})
for (const phase of ['directory-created', 'metadata-written', 'before-seal', 'completed']) test('upgrade exception at ' + phase + ' preserves original and discovery', async t => {
  const value = await setup(t), before = await readFile(value.source)
  assert.throws(() => upgrade(value, { unsafeTestPhase(name) { if (name === phase) throw new Error('synthetic interruption') } }))
  assert.equal(discoverRepositoryFork(value.target).status, phase === 'completed' ? 'completed' : 'incomplete')
  if (phase === 'completed') assert.equal(upgrade(value).status, 'completed')
  else rejects(() => upgrade(value), 'E_BRANCH_INCOMPLETE')
  assert.deepEqual(await readFile(value.source), before)
})
async function killWorker(value, phase) {
  const spec = path.join(value.root, `worker-${phase}.json`)
  await writeFile(spec, JSON.stringify({ ...value, phase }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-legacy-upgrade.worker.mjs', import.meta.url)), spec], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit'); exited.catch(() => {}); child.stderr.resume()
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Synthetic legacy worker phase timeout')), 10000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic legacy worker exited early')) })
      child.stdout.on('data', bytes => { output += bytes; if (output.includes(`paused:${phase}\n`)) { clearTimeout(timer); resolve() } })
    })
    assert.equal(child.kill('SIGKILL'), true); await exited
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
}
for (const phase of ['directory-created', 'metadata-written', 'before-seal', 'completed']) test('actual process exit during upgrade at ' + phase + ' is discoverable', async t => {
  const value = await setup(t), before = await readFile(value.source)
  await killWorker(value, phase)
  assert.deepEqual(await readFile(value.source), before)
  const result = discoverRepositoryFork(value.target)
  if (phase === 'completed') assert.deepEqual(upgrade(value), result)
  else {
    assert.ok(['incomplete', 'recovery-required'].includes(result.status))
    assert.throws(() => upgrade(value))
  }
})
