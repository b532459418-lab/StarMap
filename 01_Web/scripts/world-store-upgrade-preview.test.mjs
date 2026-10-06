import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorldRepository } from './world-store-repository.mjs'
import { seed, createRequest } from './world-store-repository.fixture.mjs'
import { previewRepositoryUpgrade, revalidateRepositoryUpgrade } from './world-store-upgrade-preview.mjs'

const identity = { libraryId: 'library', branchId: 'branch', genesisId: 'genesis' }
async function setup(t) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-upgrade-preview-'))
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-upgrade-preview-')); return rm(root, { recursive: true, force: true }) })
  const file = path.join(root, 'world.sqlite'), repository = createWorldRepository(file, seed())
  return { root, file, repository }
}
test('preview preserves source bytes and creates no target or executable commands', async t => {
  const { root, file, repository } = await setup(t); repository.close()
  const before = await readFile(file), files = await readdir(root)
  const result = previewRepositoryUpgrade(file, identity)
  assert.deepEqual(await readFile(file), before); assert.deepEqual(await readdir(root), files)
  assert.equal(result.executable, false); assert.deepEqual(result.commands, [])
  assert.equal(result.envelope.baseline.coverage, 'baselineOnly')
  assert.deepEqual(revalidateRepositoryUpgrade(file, result), result)
  assert.ok(Object.isFrozen(result.envelope.state))
})
test('nonzero source revisions and legacy request fingerprints are archived', async t => {
  const { file, repository } = await setup(t)
  repository.apply({ ...createRequest(), id: 'legacy-save' })
  const state = repository.snapshot(); repository.close()
  const result = previewRepositoryUpgrade(file, identity)
  assert.deepEqual(result.envelope.state, state)
  assert.equal(result.envelope.baseline.receipts[0].operationId, 'legacy-save')
  assert.equal(result.envelope.history.length, 0)
})
test('source changes invalidate the whole preview', async t => {
  const { file, repository } = await setup(t)
  const preview = previewRepositoryUpgrade(file, identity)
  repository.apply({ ...createRequest(), id: 'changed' }); repository.close()
  assert.throws(() => revalidateRepositoryUpgrade(file, preview), e => e.code === 'E_UPGRADE_STALE')
})
test('tampering with selected identity or report requires a new preview', async t => {
  const { file, repository } = await setup(t); repository.close()
  for (const change of [p => { p.envelope.identity.branchId = 'other' }, p => { p.executable = true }, p => { p.sourceDigest = '0'.repeat(64) }]) {
    const preview = structuredClone(previewRepositoryUpgrade(file, identity)); change(preview)
    assert.throws(() => revalidateRepositoryUpgrade(file, preview), e => e.code === 'E_UPGRADE_STALE')
  }
})
test('invalid identity and relative source fail before any write', async t => {
  const { file, repository } = await setup(t); repository.close()
  assert.throws(() => previewRepositoryUpgrade(file, { ...identity, branchId: '' }))
  assert.throws(() => previewRepositoryUpgrade('world.sqlite', identity), e => e.code === 'E_UPGRADE_PATH')
})
