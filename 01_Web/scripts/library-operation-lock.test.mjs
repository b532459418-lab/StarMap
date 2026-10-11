import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspectLibraryOperation, libraryRootBinding, rebindLibraryRoot, withLibraryOperation } from './library-operation-lock.mjs'

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

// ---------------------------------------------------------------------------
// 第 1 批 D3：回调开始之前失败不残留锁；私人根移动用独立错误码；library:rebind
// ---------------------------------------------------------------------------

const statePath = ({ root }) => path.join(root, 'operations', 'library-operation-state.json')
const isRootMoved = (error) => error.name === 'V2WriteError' && error.code === 'E_LIBRARY_ROOT_MOVED'
const exists = (target) => readFile(target).then(() => true, () => false)
/** Simulates a moved/renamed private root: the generation record keeps another root's binding. */
const bindToAnotherRoot = async (paths) => {
  const state = JSON.parse(await readFile(statePath(paths), 'utf8'))
  state.rootBinding = 'a'.repeat(64)
  await writeFile(statePath(paths), JSON.stringify(state))
  return state
}

test('D3: a moved root fails with E_LIBRARY_ROOT_MOVED before the callback and leaves no lock behind', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => {})
  const moved = await bindToAnotherRoot(paths)
  const before = await readFile(statePath(paths), 'utf8')
  let called = false
  await assert.rejects(withLibraryOperation(paths, () => { called = true }), isRootMoved)
  assert.equal(called, false)
  assert.equal(await exists(lockPath(paths)), false, 'the lock acquired by the failed call is removed')
  assert.equal(await readFile(statePath(paths), 'utf8'), before, 'the generation record is not advanced or reset')
  assert.deepEqual(await inspectLibraryOperation(paths), { state: 'needs_review', reason: 'root_moved' })
  // Still the same error on every later attempt: nothing became busy.
  await assert.rejects(withLibraryOperation(paths, () => assert.fail()), isRootMoved)
  assert.equal(JSON.parse(await readFile(statePath(paths), 'utf8')).generation, moved.generation)
})

test('D3: a damaged generation record also leaves no lock behind and is preserved', async (t) => {
  const paths = await fixture(t)
  await mkdir(path.join(paths.root, 'operations'))
  await writeFile(statePath(paths), '{invalid')
  await assert.rejects(withLibraryOperation(paths, () => assert.fail()), isBusy)
  assert.equal(await exists(lockPath(paths)), false)
  assert.equal(await readFile(statePath(paths), 'utf8'), '{invalid')
  await assert.rejects(withLibraryOperation(paths, () => assert.fail()), isBusy, 'still refused, but never by a leftover lock')
  assert.equal(await exists(lockPath(paths)), false)
})

test('D3: once the callback has started, a failed release keeps the conservative lock', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => {})
  // The callback ran; the root then appears moved, so the release cannot advance the generation.
  assert.equal(await withLibraryOperation(paths, async () => { await bindToAnotherRoot(paths); return 'done' }), 'done')
  // Release errors are swallowed as before, but the lock must remain for review.
  assert.equal(await exists(lockPath(paths)), true)
  assert.equal((await inspectLibraryOperation(paths)).state, 'busy')
})

test('D3: library:rebind prints old and new bindings, writes only with --confirm and then unblocks operations', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => {})
  const moved = await bindToAnotherRoot(paths)
  const lines = []
  const log = (line) => lines.push(line)
  assert.equal(await rebindLibraryRoot(paths, { log, logError: log }), 0)
  const output = lines.join('\n')
  assert.match(output, new RegExp(`旧 binding：${'a'.repeat(64)}`))
  const current = libraryRootBinding(await realpath(paths.root))
  assert.match(output, new RegExp(`新 binding：${current}`))
  assert.match(output, /未加 --confirm，没有修改任何文件/)
  assert.equal(JSON.parse(await readFile(statePath(paths), 'utf8')).rootBinding, 'a'.repeat(64), 'dry run writes nothing')

  lines.length = 0
  assert.equal(await rebindLibraryRoot(paths, { confirm: true, log, logError: log }), 0)
  const rebound = JSON.parse(await readFile(statePath(paths), 'utf8'))
  assert.equal(rebound.rootBinding, current)
  assert.notEqual(rebound.generation, moved.generation, 'a new generation tells readers that the record changed')
  assert.equal(await exists(lockPath(paths)), false)
  assert.deepEqual((await readdir(path.join(paths.root, 'operations'))).sort(), ['library-operation-state.json'], 'no temporary files remain')
  assert.equal(await withLibraryOperation(paths, () => 'works again'), 'works again')

  lines.length = 0
  assert.equal(await rebindLibraryRoot(paths, { confirm: true, log, logError: log }), 0)
  assert.match(lines.join('\n'), /不需要重新绑定/)
})

test('D3: library:rebind refuses while a lock exists, and on a damaged record, without touching anything', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => {})
  await bindToAnotherRoot(paths)
  const before = await readFile(statePath(paths), 'utf8')
  await writeFile(lockPath(paths), '{"orphan":true}')
  const lines = []
  const log = (line) => lines.push(line)
  assert.equal(await rebindLibraryRoot(paths, { confirm: true, log, logError: log }), 1)
  assert.match(lines.join('\n'), /库操作锁存在/)
  assert.equal(await readFile(statePath(paths), 'utf8'), before)
  assert.equal(await readFile(lockPath(paths), 'utf8'), '{"orphan":true}')

  await rm(lockPath(paths))
  await writeFile(statePath(paths), '{invalid')
  lines.length = 0
  assert.equal(await rebindLibraryRoot(paths, { confirm: true, log, logError: log }), 1)
  assert.match(lines.join('\n'), /损坏或无法读取/)
  assert.equal(await readFile(statePath(paths), 'utf8'), '{invalid')
})

test('D3: library:rebind also rebinds the media task identity that carries the same root binding', async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => {})
  await bindToAnotherRoot(paths)
  const identityPath = path.join(paths.root, 'operations', 'media-import', 'v1', 'library.json')
  await mkdir(path.dirname(identityPath), { recursive: true })
  const identity = { schemaVersion: 1, libraryId: '018f0000-0000-7000-8000-000000000001', rootBinding: 'b'.repeat(64), createdAt: '2026-10-11T00:00:00.000Z' }
  await writeFile(identityPath, JSON.stringify(identity))
  const lines = []
  assert.equal(await rebindLibraryRoot(paths, { confirm: true, log: (line) => lines.push(line), logError: (line) => lines.push(line) }), 0)
  assert.match(lines.join('\n'), new RegExp(`媒体待办身份[^\\n]*\\n  旧 binding：${'b'.repeat(64)}`))
  const current = libraryRootBinding(await realpath(paths.root))
  assert.deepEqual(JSON.parse(await readFile(identityPath, 'utf8')), { ...identity, rootBinding: current })
  assert.deepEqual(await readdir(path.dirname(identityPath)), ['library.json'])
})

test('D3: npm run library:rebind (CLI) uses STARMAP_PRIVATE_ROOT and needs --confirm', { timeout: 30000 }, async (t) => {
  const paths = await fixture(t)
  await withLibraryOperation(paths, async () => {})
  await bindToAnotherRoot(paths)
  const script = fileURLToPath(new URL('./library-rebind.mjs', import.meta.url))
  const run = (args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, STARMAP_PRIVATE_ROOT: paths.root }, encoding: 'utf8' })
  const dry = run([])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /未加 --confirm/)
  assert.equal(JSON.parse(await readFile(statePath(paths), 'utf8')).rootBinding, 'a'.repeat(64))
  const confirmed = run(['--confirm'])
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.match(confirmed.stdout, /已重新绑定到当前私人根/)
  assert.equal(await withLibraryOperation(paths, () => 'ok'), 'ok')
})
