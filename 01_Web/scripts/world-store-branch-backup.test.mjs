import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile, mkdir, rename, cp, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { seed } from './world-store-repository.fixture.mjs'
import { createWorldRepository } from './world-store-repository.mjs'
import { previewRepositoryUpgrade } from './world-store-upgrade-preview.mjs'
import { createRepositoryV2 } from './world-store-repository-v2.mjs'
import { previewRepositoryFork, forkRepositoryToDirectory, openRepositoryBranch, discoverRepositoryFork } from './world-store-branch.mjs'
import { previewRepositoryBranchBackup, backupRepositoryBranch, verifyRepositoryBranchBackup, discoverRepositoryBranchBackup,
  previewRepositoryBranchRestore, restoreRepositoryBranch, MAX_BRANCH_BACKUP_BYTES } from './world-store-branch-backup.mjs'

const host = { hostId: 'test-host' }
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)
function edit(branch, name = 'edit') {
  const state = branch.state(), row = state.world.entries[0]
  return branch.apply({ id: name, expectedRevision: state.revision, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
    expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: name } } }] } })
}
async function setup(t) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-branch-backup-'))
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-branch-backup-')); return rm(root, { recursive: true, force: true }) })
  const old = path.join(root, 'old.sqlite'), parent = path.join(root, 'parent.sqlite'), source = path.join(root, 'source'), backup = path.join(root, 'backup'), restored = path.join(root, 'restored')
  createWorldRepository(old, seed()).close()
  const envelope = previewRepositoryUpgrade(old, { libraryId: 'family', branchId: 'parent', genesisId: 'initial' }).envelope
  createRepositoryV2(parent, envelope).close()
  forkRepositoryToDirectory(parent, source, previewRepositoryFork(parent), 'initial-fork', host)
  const branch = openRepositoryBranch(source, host)
  try { edit(branch) } finally { branch.close() }
  return { root, source, backup, restored, preview: previewRepositoryBranchBackup(source) }
}
const makeBackup = value => backupRepositoryBranch(value.source, value.backup, value.preview, 'backup')
test('backup retains complete identity/history and original bytes without enabling writes', async t => {
  const value = await setup(t), before = await readFile(path.join(value.source, 'world.sqlite')), binding = await readFile(path.join(value.source, 'binding.json'))
  assert.equal(discoverRepositoryBranchBackup(value.backup).status, 'absent')
  const result = makeBackup(value), verified = verifyRepositoryBranchBackup(value.backup)
  assert.deepEqual(result, verified); assert.deepEqual(result.snapshot, value.preview.snapshot)
  assert.deepEqual(result.manifest.identity, result.snapshot.descriptor.identity)
  assert.equal(result.snapshot.history[0].operationId, 'edit')
  assert.deepEqual(await readFile(path.join(value.source, 'world.sqlite')), before)
  assert.deepEqual(await readFile(path.join(value.source, 'binding.json')), binding)
  const moved = path.join(value.root, 'moved-backup'); await rename(value.backup, moved)
  assert.deepEqual(verifyRepositoryBranchBackup(moved), result)
})
test('restore creates a new branch with facts/history provenance and separate local receipts', async t => {
  const value = await setup(t), pkg = makeBackup(value), preview = previewRepositoryBranchRestore(value.backup)
  const result = restoreRepositoryBranch(value.backup, value.restored, preview, 'restore', host)
  assert.equal(result.status, 'completed'); assert.equal(result.descriptor.origin.source.repositoryFormatVersion, 3)
  assert.equal(result.descriptor.identity.libraryId, pkg.manifest.identity.libraryId)
  assert.notEqual(result.descriptor.identity.branchId, pkg.manifest.identity.branchId)
  const branch = openRepositoryBranch(value.restored, host)
  try {
    assert.deepEqual(branch.state(), pkg.snapshot.state)
    assert.deepEqual(branch.snapshot().sourceArchive, pkg.snapshot)
    assert.equal(branch.findOperation('edit'), undefined)
    assert.equal(branch.creation().context.packageDigest, preview.packageDigest)
    assert.equal(branch.creation().context.requestId, 'restore')
    assert.equal(edit(branch).status, 'committed'); assert.equal(branch.findOperation('edit').repositoryRevision, 2)
    assert.equal(branch.snapshot().history.length, 1)
  } finally { branch.close() }
  assert.deepEqual(verifyRepositoryBranchBackup(value.backup), pkg)
})
test('restore retry survives later child edits and missing external backup', async t => {
  const value = await setup(t); makeBackup(value)
  const preview = previewRepositoryBranchRestore(value.backup), first = restoreRepositoryBranch(value.backup, value.restored, preview, 'restore', host)
  const branch = openRepositoryBranch(value.restored, host)
  try { edit(branch, 'later') } finally { branch.close() }
  await rename(value.backup, path.join(value.root, 'moved-backup'))
  assert.deepEqual(restoreRepositoryBranch(value.backup, value.restored, preview, 'restore', host), first)
  rejects(() => restoreRepositoryBranch(value.backup, value.restored, preview, 'different', host), 'E_BRANCH_EXISTS')
})
test('backup retry retains original sealed snapshot after source edits', async t => {
  const value = await setup(t), first = makeBackup(value), branch = openRepositoryBranch(value.source, host)
  try { edit(branch, 'later') } finally { branch.close() }
  assert.deepEqual(makeBackup(value), first)
  rejects(() => backupRepositoryBranch(value.source, value.backup, previewRepositoryBranchBackup(value.source), 'backup'), 'E_BACKUP_EXISTS')
})
test('source changed after backup preview rejects before creating target', async t => {
  const value = await setup(t), branch = openRepositoryBranch(value.source, host)
  try { edit(branch, 'later') } finally { branch.close() }
  rejects(() => makeBackup(value), 'E_BACKUP_CHANGED')
  assert.equal(discoverRepositoryBranchBackup(value.backup).status, 'absent')
})
test('live v3 source forks its current state with a complete parent archive', async t => {
  const value = await setup(t), file = path.join(value.source, 'world.sqlite'), before = await readFile(file)
  const preview = previewRepositoryFork(file), target = path.join(value.root, 'next-generation')
  assert.equal(preview.source.repositoryFormatVersion, 3)
  const result = forkRepositoryToDirectory(file, target, preview, 'next-fork', host)
  assert.notEqual(result.descriptor.identity.branchId, value.preview.snapshot.descriptor.identity.branchId)
  const branch = openRepositoryBranch(target, host)
  try {
    assert.deepEqual(branch.snapshot().sourceArchive, value.preview.snapshot)
    assert.equal(branch.findOperation('edit'), undefined)
    assert.deepEqual(branch.state(), value.preview.snapshot.state)
  } finally { branch.close() }
  assert.deepEqual(await readFile(file), before)
})
test('v3 source cannot commit a competing edit while a descendant is being sealed', async t => {
  const value = await setup(t), file = path.join(value.source, 'world.sqlite'), preview = previewRepositoryFork(file), parent = openRepositoryBranch(value.source, host)
  try {
    forkRepositoryToDirectory(file, path.join(value.root, 'next-generation'), preview, 'next-fork', { ...host, unsafeTestPhase(name) {
      if (name === 'before-seal') rejects(() => edit(parent, 'competing'), 'E_REPO_OUTCOME_UNKNOWN')
    } })
    assert.equal(parent.findOperation('competing'), undefined)
    assert.equal(parent.state().revision, 1)
  } finally { parent.close() }
})
test('source filename casing respects the platform and never locks a different v3 file', async t => {
  const value = await setup(t), alternate = path.join(value.source, 'WORLD.SQLITE')
  if (process.platform === 'win32') {
    assert.deepEqual(previewRepositoryFork(alternate).archive, value.preview.snapshot)
  } else {
    await cp(path.join(value.source, 'world.sqlite'), alternate)
    rejects(() => previewRepositoryFork(alternate), 'E_BRANCH_PATH')
  }
})
test('source read transaction remains held through backup seal', async t => {
  const value = await setup(t), branch = openRepositoryBranch(value.source, host)
  try {
    backupRepositoryBranch(value.source, value.backup, value.preview, 'backup', { unsafeTestPhase(name) {
      if (name === 'before-seal') rejects(() => edit(branch, 'competing'), 'E_REPO_OUTCOME_UNKNOWN')
    } })
    assert.equal(branch.findOperation('competing'), undefined)
    assert.equal(branch.state().revision, 1)
  } finally { branch.close() }
})
test('withSnapshot refuses nested ownership and asynchronous callbacks', async t => {
  const value = await setup(t), branch = openRepositoryBranch(value.source, { readOnly: true })
  try {
    branch.withSnapshot(() => rejects(() => branch.snapshot(), 'E_REPO_BUSY'))
    rejects(() => branch.withSnapshot(() => Promise.resolve()), 'E_BRANCH_ASYNC_HOOK')
    assert.equal(branch.state().revision, 1)
  } finally { branch.close() }
})
test('modified backup bytes and missing sealed snapshot are not accepted as absent/success', async t => {
  const value = await setup(t); makeBackup(value)
  const file = path.join(value.backup, 'snapshot.json'), original = await readFile(file)
  await writeFile(file, '{}')
  rejects(() => verifyRepositoryBranchBackup(value.backup), 'E_BACKUP_CORRUPT')
  await writeFile(file, original); await rename(file, path.join(value.root, 'removed-snapshot.json'))
  rejects(() => discoverRepositoryBranchBackup(value.backup), 'E_BACKUP_INCOMPLETE')
})
test('changed package between restore preview and confirm refuses a new target', async t => {
  const value = await setup(t); makeBackup(value)
  const preview = previewRepositoryBranchRestore(value.backup), manifestFile = path.join(value.backup, 'complete.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.operationId = 'tampered'; await writeFile(manifestFile, JSON.stringify(manifest))
  assert.throws(() => restoreRepositoryBranch(value.backup, value.restored, preview, 'restore', host))
  assert.equal(discoverRepositoryFork(value.restored).status, 'absent')
})
test('backup mutation during target generation prevents a completion seal', async t => {
  const value = await setup(t); makeBackup(value)
  const preview = previewRepositoryBranchRestore(value.backup)
  assert.throws(() => restoreRepositoryBranch(value.backup, value.restored, preview, 'restore', { ...host, unsafeTestPhase(name) {
    if (name === 'before-seal') {
      writeFileSync(path.join(value.backup, 'snapshot.json'), '{}')
    }
  } }))
  assert.equal(discoverRepositoryFork(value.restored).status, 'incomplete')
})
test('existing directories remain intact and copied restores refuse writable binding', async t => {
  const value = await setup(t); await mkdir(value.backup); await writeFile(path.join(value.backup, 'keep'), 'unchanged')
  rejects(() => makeBackup(value), 'E_BACKUP_INCOMPLETE')
  assert.equal(await readFile(path.join(value.backup, 'keep'), 'utf8'), 'unchanged')
  const backup = path.join(value.root, 'valid'); backupRepositoryBranch(value.source, backup, value.preview, 'backup')
  restoreRepositoryBranch(backup, value.restored, previewRepositoryBranchRestore(backup), 'restore', host)
  const copy = path.join(value.root, 'copy'); await cp(value.restored, copy, { recursive: true })
  rejects(() => openRepositoryBranch(copy, host), 'E_BRANCH_BINDING')
})
test('unknown package version, extra files and oversized snapshot are refused', async t => {
  const value = await setup(t); makeBackup(value)
  const manifestFile = path.join(value.backup, 'complete.json'), original = await readFile(manifestFile), manifest = JSON.parse(original)
  manifest.formatVersion = 2; await writeFile(manifestFile, JSON.stringify(manifest))
  rejects(() => verifyRepositoryBranchBackup(value.backup), 'E_BACKUP_VERSION')
  await writeFile(manifestFile, original)
  await writeFile(path.join(value.backup, 'unexpected'), 'data')
  rejects(() => verifyRepositoryBranchBackup(value.backup), 'E_BACKUP_INCOMPLETE')
  await rm(path.join(value.backup, 'unexpected'))
  await truncate(path.join(value.backup, 'snapshot.json'), MAX_BRANCH_BACKUP_BYTES + 1)
  rejects(() => verifyRepositoryBranchBackup(value.backup), 'E_BACKUP_SIZE')
})
for (const phase of ['reserved', 'snapshot-written', 'before-seal', 'sealed']) test('backup exception at ' + phase + ' leaves a discoverable bounded result', async t => {
  const value = await setup(t)
  assert.throws(() => backupRepositoryBranch(value.source, value.backup, value.preview, 'backup', { unsafeTestPhase(name) { if (name === phase) throw new Error('synthetic interruption') } }))
  const result = discoverRepositoryBranchBackup(value.backup)
  assert.equal(result.status, phase === 'sealed' ? 'completed' : 'incomplete')
  if (phase === 'sealed') assert.deepEqual(makeBackup(value), result)
  else rejects(() => makeBackup(value), 'E_BACKUP_INCOMPLETE')
})
async function killWorker(value, action, phase) {
  const spec = path.join(value.root, `worker-${action}-${phase}.json`)
  const source = action === 'backup' ? value.source : value.backup, target = action === 'backup' ? value.backup : value.restored
  const preview = action === 'backup' ? value.preview : previewRepositoryBranchRestore(value.backup)
  await writeFile(spec, JSON.stringify({ source, target, preview, phase, action }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-branch-backup.worker.mjs', import.meta.url)), spec], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit'); exited.catch(() => {}); child.stderr.resume()
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Synthetic backup worker phase timeout')), 10000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic backup worker exited early')) })
      child.stdout.on('data', bytes => { output += bytes; if (output.includes(`paused:${phase}\n`)) { clearTimeout(timer); resolve() } })
    })
    assert.equal(child.kill('SIGKILL'), true); await exited
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
}
for (const phase of ['reserved', 'snapshot-written', 'before-seal', 'sealed']) test('real process exit during backup at ' + phase, async t => {
  const value = await setup(t), before = await readFile(path.join(value.source, 'world.sqlite'))
  await killWorker(value, 'backup', phase)
  assert.deepEqual(await readFile(path.join(value.source, 'world.sqlite')), before)
  assert.equal(discoverRepositoryBranchBackup(value.backup).status, phase === 'sealed' ? 'completed' : 'incomplete')
})
for (const phase of ['directory-created', 'metadata-written', 'before-seal', 'completed']) test('real process exit during restore at ' + phase, async t => {
  const value = await setup(t), pkg = makeBackup(value)
  await killWorker(value, 'restore', phase)
  assert.deepEqual(verifyRepositoryBranchBackup(value.backup), pkg)
  const result = discoverRepositoryFork(value.restored)
  if (phase === 'completed') {
    assert.equal(result.status, 'completed')
    const preview = previewRepositoryBranchRestore(value.backup)
    assert.deepEqual(restoreRepositoryBranch(value.backup, value.restored, preview, 'restore', host), result)
  } else assert.ok(['incomplete', 'recovery-required'].includes(result.status))
})
