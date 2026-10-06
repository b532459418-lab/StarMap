import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createWorldRepository, openWorldRepository } from './world-store-repository.mjs'
import { seed, createRequest } from './world-store-repository.fixture.mjs'
import { previewRepositoryUpgrade } from './world-store-upgrade-preview.mjs'
import { discoverRepositoryUpgrade, upgradeRepositoryToDirectory } from './world-store-upgrade.mjs'
const identity = { libraryId: 'new-library', branchId: 'new-branch', genesisId: 'new-genesis' }
async function setup(t) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-upgrade-artifact-'))
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-upgrade-artifact-')); return rm(root, { recursive: true, force: true }) })
  const file = path.join(root, 'source.sqlite'), target = path.join(root, 'target'), repository = createWorldRepository(file, seed())
  repository.apply(createRequest()); repository.close()
  return { file, target, preview: previewRepositoryUpgrade(file, identity) }
}
test('upgrade artifact retains complete source and receipts without editing source bytes', async t => {
  const { file, target, preview } = await setup(t), bytes = await readFile(file)
  assert.equal(discoverRepositoryUpgrade(target).status, 'absent')
  const result = upgradeRepositoryToDirectory(file, target, preview, 'upgrade')
  assert.equal(result.status, 'completed'); assert.deepEqual(result.envelope, preview.envelope)
  assert.deepEqual(await readFile(file), bytes)
  assert.deepEqual(discoverRepositoryUpgrade(target), result)
  assert.deepEqual(upgradeRepositoryToDirectory(file, target, preview, 'upgrade'), result)
  assert.throws(() => upgradeRepositoryToDirectory(file, target, preview, 'different'), e => e.code === 'E_UPGRADE_EXISTS')
  const altered = structuredClone(preview); altered.executable = true
  assert.throws(() => upgradeRepositoryToDirectory(file, target, altered, 'upgrade'), e => e.code === 'E_UPGRADE_EXISTS')
})
for (const phase of ['directory-created', 'envelope-written', 'database-committed', 'before-completion', 'completed']) {
  test(`interruption at ${phase} preserves discoverable completion boundary`, async t => {
    const { file, target, preview } = await setup(t), before = await readFile(file)
    assert.throws(() => upgradeRepositoryToDirectory(file, target, preview, 'upgrade', { unsafeTestPhase(name) { if (name === phase) throw new Error('synthetic interruption') } }))
    assert.deepEqual(await readFile(file), before)
    const result = discoverRepositoryUpgrade(target)
    assert.equal(result.status, phase === 'completed' ? 'completed' : 'incomplete')
    if (phase === 'completed') assert.deepEqual(upgradeRepositoryToDirectory(file, target, preview, 'upgrade'), result)
    else assert.throws(() => upgradeRepositoryToDirectory(file, target, preview, 'upgrade'), e => e.code === 'E_UPGRADE_INCOMPLETE')
  })
}
test('changed preview rejected before target creation', async t => {
  const { file, target, preview } = await setup(t), changed = structuredClone(preview)
  changed.envelope.identity.branchId = 'another'
  assert.throws(() => upgradeRepositoryToDirectory(file, target, changed, 'upgrade'))
  assert.equal(discoverRepositoryUpgrade(target).status, 'absent')
})
test('modified artifact bytes cannot be discovered as success', async t => {
  const { file, target, preview } = await setup(t)
  upgradeRepositoryToDirectory(file, target, preview, 'upgrade')
  await writeFile(path.join(target, 'world.sqlite'), 'damaged synthetic artifact')
  assert.throws(() => discoverRepositoryUpgrade(target), e => e.code === 'E_UPGRADE_CORRUPT')
})
test('modified marker cannot claim a different source', async t => {
  const { file, target, preview } = await setup(t)
  upgradeRepositoryToDirectory(file, target, preview, 'upgrade')
  const fileMarker = path.join(target, 'complete.json'), marker = JSON.parse(await readFile(fileMarker, 'utf8'))
  marker.sourceDigest = '0'.repeat(64); await writeFile(fileMarker, JSON.stringify(marker))
  assert.throws(() => discoverRepositoryUpgrade(target), e => e.code === 'E_UPGRADE_CORRUPT')
})
test('source modification during conversion is refused while sealing holds a snapshot', async t => {
  const { file, target, preview } = await setup(t)
  assert.throws(() => upgradeRepositoryToDirectory(file, target, preview, 'upgrade', { unsafeTestPhase(name) {
    if (name !== 'database-committed') return
    const repository = openWorldRepository(file)
    try { repository.apply({ id: 'after-preview', expectedRevision: 1, action: { kind: 'merge', incoming: repository.snapshot().world } }) }
    finally { repository.close() }
  } }), e => e.code === 'E_REPO_OUTCOME_UNKNOWN')
  assert.equal(discoverRepositoryUpgrade(target).status, 'incomplete')
})

test('a normal writer cannot slip between final validation and completion marker', async t => {
  const { file, target, preview } = await setup(t)
  const result = upgradeRepositoryToDirectory(file, target, preview, 'upgrade', { unsafeTestPhase(name) {
    if (name !== 'before-completion') return
    const competing = openWorldRepository(file)
    try {
      assert.throws(() => competing.apply({ id: 'concurrent', expectedRevision: 1, action: { kind: 'merge', incoming: competing.snapshot().world } }), e => e.code === 'E_REPO_OUTCOME_UNKNOWN')
      assert.equal(competing.findOperation('concurrent'), undefined)
    }
    finally { competing.close() }
  } })
  assert.equal(result.status, 'completed')
  const source = openWorldRepository(file)
  try { assert.deepEqual(source.snapshot(), result.envelope.state); assert.equal(source.apply({ id: 'later', expectedRevision: 1, action: { kind: 'merge', incoming: source.snapshot().world } }).repositoryRevision, 2) }
  finally { source.close() }
})

test('WAL source is refused before reserving a target because its read lock cannot seal out writers', async t => {
  const { file, target, preview } = await setup(t), db = new DatabaseSync(file)
  try { assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal') }
  finally { db.close() }
  const before = await readFile(file)
  assert.throws(() => upgradeRepositoryToDirectory(file, target, preview, 'upgrade'), e => e.code === 'E_REPO_SETTINGS')
  assert.equal(discoverRepositoryUpgrade(target).status, 'absent')
  assert.deepEqual(await readFile(file), before)
})

async function killUpgrade(file, target, preview, phase) {
  const spec = path.join(path.dirname(file), `worker-${phase}.json`)
  await writeFile(spec, JSON.stringify({ source: file, target, preview, phase }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-upgrade.worker.mjs', import.meta.url)), spec],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit'); exited.catch(() => {})
  // Keep diagnostics neutral: a failed worker must not print fixture contents.
  child.stderr.resume()
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Upgrade worker phase timeout')), 7000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Upgrade worker exited before phase')) })
      child.stdout.on('data', bytes => {
        output += bytes
        if (output.includes(`paused:${phase}\n`)) { clearTimeout(timer); resolve() }
      })
    })
    assert.equal(child.kill('SIGKILL'), true)
    const [code, signal] = await exited
    assert.ok(signal === 'SIGKILL' || (code !== null && code !== 0))
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  }
}
for (const phase of ['directory-created', 'envelope-written', 'database-committed', 'before-completion', 'completed']) {
  test(`actual process exit at ${phase} preserves source and completion discovery`, async t => {
    const { file, target, preview } = await setup(t), before = await readFile(file)
    await killUpgrade(file, target, preview, phase)
    assert.deepEqual(await readFile(file), before)
    const repository = openWorldRepository(file)
    try { assert.deepEqual(repository.snapshot(), preview.envelope.state); assert.equal(repository.findOperation('create').status, 'committed') }
    finally { repository.close() }
    const result = discoverRepositoryUpgrade(target)
    if (phase === 'completed') {
      assert.equal(result.status, 'completed'); assert.deepEqual(result.envelope, preview.envelope)
      assert.deepEqual(upgradeRepositoryToDirectory(file, target, preview, 'upgrade'), result)
    } else {
      assert.equal(result.status, 'incomplete')
      assert.throws(() => upgradeRepositoryToDirectory(file, target, preview, 'upgrade'), e => e.code === 'E_UPGRADE_INCOMPLETE')
    }
  })
}
