import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-library-lock-'))
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir())
    assert.ok(path.basename(root).startsWith('starmap-library-lock-'))
    await rm(root, { recursive: true, force: true })
  })
  return { root }
}
const isBusy = (error) => error.name === 'V2WriteError' && error.code === 'E_LIBRARY_BUSY'
const lockPath = ({ root }) => path.join(root, 'operations', 'library-operation.lock')

test('inspection of an absent library is read only and has no generation', async (t) => {
  const paths = await fixture(t)
  paths.root = path.join(paths.root, 'absent')
  assert.deepEqual(await inspectLibraryOperation(paths), { state: 'idle', generation: null })
  await assert.rejects(readFile(path.join(paths.root, 'operations', 'library-operation-state.json')), { code: 'ENOENT' })
})

test('independent holders contend while distinct libraries remain independent', async (t) => {
  const paths = await fixture(t)
  const other = await fixture(t)
  await withLibraryOperation(paths, async () => {
    assert.deepEqual(await inspectLibraryOperation(paths), { state: 'busy', reason: 'lease_present' })
    await assert.rejects(withLibraryOperation({ root: paths.root }, () => assert.fail()), isBusy)
    assert.equal(await withLibraryOperation(other, () => 'other'), 'other')
  })
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})

test('generation changes before mutation and again before release, including failed mutations', async (t) => {
  const paths = await fixture(t)
  assert.equal((await inspectLibraryOperation(paths)).generation, null)
  let inside
  await withLibraryOperation(paths, async () => {
    inside = JSON.parse(await readFile(path.join(paths.root, 'operations', 'library-operation-state.json'), 'utf8')).generation
  })
  const first = (await inspectLibraryOperation(paths)).generation
  assert.notEqual(first, inside)
  await assert.rejects(withLibraryOperation(paths, () => { throw new Error('synthetic failure') }), /synthetic failure/)
  const last = await inspectLibraryOperation(paths)
  assert.equal(last.state, 'idle')
  assert.notEqual(last.generation, first)
})

test('explicit matching child lease does not release the parent or advance its generation', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async (leaseToken) => {
    const before = await readFile(lockPath(paths), 'utf8')
    const stateBefore = await readFile(path.join(paths.root, 'operations', 'library-operation-state.json'), 'utf8')
    assert.equal(await withLibraryOperation(paths, () => 'joined', { leaseToken }), 'joined')
    assert.equal(await readFile(lockPath(paths), 'utf8'), before)
    assert.equal(await readFile(path.join(paths.root, 'operations', 'library-operation-state.json'), 'utf8'), stateBefore)
  })
})

test('replayed, fabricated and foreign library lease tokens never bypass acquisition', async (t) => {
  const paths = await fixture(t)
  const other = await fixture(t)
  let old
  await withLibraryOperation(paths, async (leaseToken) => {
    old = leaseToken
    await assert.rejects(withLibraryOperation(other, () => assert.fail(), { leaseToken }), isBusy)
    await assert.rejects(withLibraryOperation(paths, () => assert.fail(), { leaseToken: 'forged' }), isBusy)
    const forged = JSON.parse(Buffer.from(leaseToken, 'base64url').toString('utf8'))
    forged.owner = '00000000-0000-0000-0000-000000000000'
    await assert.rejects(withLibraryOperation(paths, () => assert.fail(), { leaseToken: Buffer.from(JSON.stringify(forged)).toString('base64url') }), isBusy)
  })
  await assert.rejects(withLibraryOperation(paths, () => assert.fail(), { leaseToken: old }), isBusy)
})

test('corrupt lock and future version remain untouched and never count as stale', async (t) => {
  const paths = await fixture(t)
  await mkdir(path.dirname(lockPath(paths)))
  for (const bytes of ['{broken', JSON.stringify({ schemaVersion: 99, owner: 'unknown' })]) {
    await writeFile(lockPath(paths), bytes)
    assert.equal((await inspectLibraryOperation(paths)).state, 'needs_review')
    await assert.rejects(withLibraryOperation(paths, () => assert.fail()), isBusy)
    assert.equal(await readFile(lockPath(paths), 'utf8'), bytes)
  }
})

test('a copied lock receipt is rejected by its canonical library binding', async (t) => {
  const paths = await fixture(t)
  const other = await fixture(t)
  await withLibraryOperation(paths, async () => {
    const receipt = await readFile(lockPath(paths), 'utf8')
    await mkdir(path.dirname(lockPath(other)))
    await writeFile(lockPath(other), receipt)
    assert.deepEqual(await inspectLibraryOperation(other), { state: 'needs_review', reason: 'root_binding_mismatch' })
    await assert.rejects(withLibraryOperation(other, () => assert.fail()), isBusy)
    assert.equal(await readFile(lockPath(other), 'utf8'), receipt)
  })
})

test('corrupt generation is blocked and preserved instead of reset', async (t) => {
  const paths = await fixture(t)
  await mkdir(path.join(paths.root, 'operations'))
  const state = path.join(paths.root, 'operations', 'library-operation-state.json')
  await writeFile(state, '{invalid')
  assert.deepEqual(await inspectLibraryOperation(paths), { state: 'needs_review', reason: 'generation_invalid' })
  await assert.rejects(withLibraryOperation(paths, () => assert.fail()), isBusy)
  assert.equal(await readFile(state, 'utf8'), '{invalid')
})

test('replaced lock content is never deleted by the original owner', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => { await writeFile(lockPath(paths), '{changed') })
  assert.equal(await readFile(lockPath(paths), 'utf8'), '{changed')
  assert.equal((await inspectLibraryOperation(paths)).state, 'needs_review')
})

test('a killed holder leaves a conservative orphan lock that a new process cannot steal', { timeout: 15000 }, async (t) => {
  const paths = await fixture(t)
  const moduleUrl = new URL('./library-operation-lock.mjs', import.meta.url).href
  const code = `import {withLibraryOperation} from ${JSON.stringify(moduleUrl)}; await withLibraryOperation({root:process.argv[1]},async()=>{process.send('locked');setInterval(()=>{},1000);await new Promise(()=>{});});`
  const holder = spawn(process.execPath, ['--input-type=module', '-e', code, paths.root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  t.after(() => { if (holder.exitCode === null) holder.kill() })
  const [message] = await once(holder, 'message')
  assert.equal(message, 'locked')
  const receipt = await readFile(lockPath(paths), 'utf8')
  const exited = once(holder, 'exit')
  holder.kill()
  await exited
  assert.equal((await inspectLibraryOperation(paths)).state, 'busy')
  await assert.rejects(withLibraryOperation(paths, () => assert.fail()), isBusy)
  assert.equal(await readFile(lockPath(paths), 'utf8'), receipt)
  const probe = `import {withLibraryOperation} from ${JSON.stringify(moduleUrl)};try {await withLibraryOperation({root:process.argv[1]},()=>process.exitCode=9)}catch(error){process.exitCode=error.code==='E_LIBRARY_BUSY'?0:8}`
  const contender = spawn(process.execPath, ['--input-type=module', '-e', probe, paths.root], { stdio: 'pipe' })
  const [exitCode] = await once(contender, 'exit')
  assert.equal(exitCode, 0)
})
