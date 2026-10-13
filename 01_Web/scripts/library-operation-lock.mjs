import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const version = 1
const ownerPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const hashPattern = /^[a-f0-9]{64}$/
const busy = () => new V2WriteError('E_LIBRARY_BUSY')
const rootMoved = () => new V2WriteError('E_LIBRARY_ROOT_MOVED')
const missing = (error) => error?.code === 'ENOENT'
const binding = (root) => createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex')
const valid = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && value.schemaVersion === version && typeof value.owner === 'string' && ownerPattern.test(value.owner)
  && typeof value.rootBinding === 'string' && hashPattern.test(value.rootBinding)

/** The generation file is bound to the canonical private-root path; a moved/renamed root no longer matches it. */
export const libraryRootBinding = binding

async function locations(privatePaths, create) {
  const requestedRoot = path.resolve(privatePaths.root)
  if (create) await mkdir(requestedRoot, { recursive: true })
  const root = await realpath(requestedRoot)
  const operations = path.join(root, 'operations')
  try {
    const metadata = await lstat(operations)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw busy()
  } catch (error) {
    if (!missing(error)) throw error
    if (create) {
      await mkdir(operations, { recursive: true })
      const metadata = await lstat(operations)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw busy()
    }
  }
  return { rootBinding: binding(root), lockPath: path.join(operations, 'library-operation.lock'), statePath: path.join(operations, 'library-operation-state.json') }
}

/** Valid generation records only; returns null when absent. A record bound to another root path is E_LIBRARY_ROOT_MOVED. */
export async function readGenerationRecord(statePath) {
  try {
    const metadata = await lstat(statePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw busy()
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (state?.schemaVersion !== version || typeof state.rootBinding !== 'string' || !hashPattern.test(state.rootBinding)
      || typeof state.generation !== 'string' || !ownerPattern.test(state.generation)) throw busy()
    return state
  } catch (error) {
    if (missing(error)) return null
    throw busy()
  }
}

async function readGeneration(statePath, rootBinding) {
  const state = await readGenerationRecord(statePath)
  if (state === null) return null
  if (state.rootBinding !== rootBinding) throw rootMoved()
  return state.generation
}

/** Atomic generation write: exclusive random temporary file, fsync, rename. Shared with `npm run library:rebind`. */
export async function writeGenerationRecord(statePath, rootBinding, generation = randomUUID()) {
  const temporary = `${statePath}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: version, rootBinding, generation }))
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  await handle.close()
  try { await rename(temporary, statePath) } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function advanceGeneration(statePath, rootBinding) {
  await readGeneration(statePath, rootBinding)
  await writeGenerationRecord(statePath, rootBinding)
}

async function readLock(lockPath) {
  const metadata = await lstat(lockPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw busy()
  const record = JSON.parse(await readFile(lockPath, 'utf8'))
  if (!valid(record)) throw busy()
  return record
}

function decodeToken(leaseToken) {
  try {
    if (typeof leaseToken !== 'string' || leaseToken.length > 4096) throw busy()
    const record = JSON.parse(Buffer.from(leaseToken, 'base64url').toString('utf8'))
    if (!valid(record)) throw busy()
    return record
  } catch { throw busy() }
}

/** Inspect only: an old lock is never deleted, reset, or assumed stale by age/PID. */
export async function inspectLibraryOperation(privatePaths) {
  try {
    const { lockPath, statePath, rootBinding } = await locations(privatePaths, false)
    let record
    try { record = await readLock(lockPath) } catch (error) {
      if (missing(error)) {
        try { return { state: 'idle', generation: await readGeneration(statePath, rootBinding) } }
        catch (generationError) {
          return { state: 'needs_review', reason: generationError?.code === 'E_LIBRARY_ROOT_MOVED' ? 'root_moved' : 'generation_invalid' }
        }
      }
      return { state: 'needs_review', reason: 'lock_invalid' }
    }
    return record.rootBinding === rootBinding
      ? { state: 'busy', reason: 'lease_present' }
      : { state: 'needs_review', reason: 'root_binding_mismatch' }
  } catch (error) {
    return missing(error) ? { state: 'idle', generation: null } : { state: 'needs_review', reason: 'lock_unreadable' }
  }
}

const MEDIA_TASK_IDENTITY = ['operations', 'media-import', 'v1', 'library.json']

/** The media task identity (media-job-store.mjs) carries the same canonical root binding. Absent → null. */
async function readMediaTaskIdentity(root) {
  const target = path.join(root, ...MEDIA_TASK_IDENTITY)
  let metadata
  try { metadata = await lstat(target) } catch (error) { if (missing(error)) return null; throw error }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096) return { target, invalid: true }
  try {
    const value = JSON.parse(await readFile(target, 'utf8'))
    const keys = ['schemaVersion', 'libraryId', 'rootBinding', 'createdAt']
    const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every((key) => keys.includes(key)) && value.schemaVersion === 1
      && typeof value.rootBinding === 'string' && hashPattern.test(value.rootBinding)
    return valid ? { target, value } : { target, invalid: true }
  } catch { return { target, invalid: true } }
}

async function atomicReplace(target, encoded) {
  const temporary = path.join(path.dirname(target), `${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(encoded, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  await handle.close()
  try { await rename(temporary, target) } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * `npm run library:rebind`: after the private root was moved/renamed (E_LIBRARY_ROOT_MOVED), rebind the generation
 * record (and the media task identity, which carries the same binding) to the current root. Prints the old and new
 * bindings; writes only with `confirm`. Refuses while any lock exists, and holds its own lock while writing.
 * Returns an exit code: 0 done / nothing to do / dry run, 1 refused.
 */
export async function rebindLibraryRoot(privatePaths, { confirm = false, log = console.log, logError = console.error } = {}) {
  let resolved
  try { resolved = await realpath(path.resolve(privatePaths.root)) } catch (error) {
    if (!missing(error)) throw error
    logError('[library:rebind] 私人根不存在，没有可以重新绑定的库。')
    return 1
  }
  const { lockPath, statePath, rootBinding } = await locations(privatePaths, false)
  if (await lstat(lockPath).then(() => true, (error) => { if (missing(error)) return false; throw error })) {
    logError('[library:rebind] 库操作锁存在（operations/library-operation.lock），拒绝执行。先确认没有正在进行或中断的操作，再处理这个锁。')
    return 1
  }
  let generation
  try { generation = await readGenerationRecord(statePath) } catch {
    logError('[library:rebind] 库操作记录（operations/library-operation-state.json）损坏或无法读取，拒绝执行。请核对或从备份恢复这个文件。')
    return 1
  }
  const identity = await readMediaTaskIdentity(resolved)
  if (identity?.invalid) {
    logError('[library:rebind] 媒体待办身份（operations/media-import/v1/library.json）损坏或不是普通文件，拒绝执行。')
    return 1
  }
  const changes = []
  if (generation && generation.rootBinding !== rootBinding) changes.push({ label: '库操作记录（operations/library-operation-state.json）', from: generation.rootBinding })
  if (identity?.value && identity.value.rootBinding !== rootBinding) changes.push({ label: '媒体待办身份（operations/media-import/v1/library.json）', from: identity.value.rootBinding })
  log(`StarMap library:rebind\n私人根：${resolved}`)
  if (changes.length === 0) {
    log('绑定与当前私人根一致，不需要重新绑定。')
    return 0
  }
  for (const change of changes) log(`${change.label}\n  旧 binding：${change.from}\n  新 binding：${rootBinding}`)
  if (!confirm) {
    log('\n未加 --confirm，没有修改任何文件。确认这就是原来的私人库（只是被移动、改名或换了盘符）后运行：npm run library:rebind -- --confirm')
    return 0
  }
  const owner = { schemaVersion: version, owner: randomUUID(), rootBinding }
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') {
      logError('[library:rebind] 库操作锁刚刚出现，拒绝执行。')
      return 1
    }
    throw error
  }
  try {
    await handle.writeFile(JSON.stringify(owner))
    await handle.sync()
  } finally { await handle.close() }
  try {
    if (generation && generation.rootBinding !== rootBinding) await writeGenerationRecord(statePath, rootBinding)
    if (identity?.value && identity.value.rootBinding !== rootBinding) {
      await atomicReplace(identity.target, `${JSON.stringify({ ...identity.value, rootBinding }, null, 2)}\n`)
    }
  } finally {
    await unlink(lockPath)
  }
  log('\n已重新绑定到当前私人根。')
  return 0
}

/**
 * `npm run library:recover` (3C-2, design 3B §5.2): a lock left by a holder that ended during its lease. Never decided by
 * age or PID — the person running the command confirms the holder is gone. Without `confirm` it only prints the holder,
 * the lock's creation time and the root bindings, and changes nothing. With `confirm` it runs `checkData` (the caller's
 * data check for the library's mode); only when that reports no problems does it advance the generation and then remove
 * exactly the lock it inspected. Otherwise the lock stays and the problems are printed.
 *
 * A lock or generation record bound to another root path (the private root was moved while a lock was left behind) is
 * refused, unless `rebind` (`--confirm --rebind`, 3C-2b, design 3B v1.1 §16.3): after the same data check it rebinds the
 * generation record and the media task identity to the current root, as library:rebind would, and then removes the lock.
 * Returns an exit code (same as library:rebind): 0 done / nothing to do / dry run, 1 refused.
 */
export async function recoverLibraryOperation(privatePaths, { confirm = false, rebind = false, checkData, modeLabel, log = console.log, logError = console.error } = {}) {
  let root
  try { root = await realpath(path.resolve(privatePaths.root)) } catch (error) {
    if (!missing(error)) throw error
    logError('[library:recover] 私人根不存在，没有可以恢复的库。')
    return 1
  }
  const { lockPath, statePath, rootBinding } = await locations(privatePaths, false)
  log(`StarMap library:recover\n私人根：${root}\n当前私人根的 binding：${rootBinding}`)
  if (modeLabel) log(`数据模式：${modeLabel}`)
  let metadata
  try { metadata = await lstat(lockPath) } catch (error) {
    if (!missing(error)) throw error
    log('没有库操作锁（operations/library-operation.lock），不需要恢复。')
    return 0
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
    logError('[library:recover] 库操作锁不是普通文件，拒绝执行。请人工核对 operations/library-operation.lock。')
    return 1
  }
  const lockBytes = await readFile(lockPath)
  let record
  try { record = JSON.parse(lockBytes.toString('utf8')) } catch { record = undefined }
  if (!valid(record)) record = undefined
  const created = metadata.birthtimeMs > 0 ? metadata.birthtime : metadata.mtime
  log('库操作锁：operations/library-operation.lock')
  log(record ? `  持有者：${record.owner}` : '  持有者：无法解析（锁可能是在写入时中断的）')
  log(`  创建时间：${created.toISOString()}`)
  if (record) log(`  锁记录的 binding：${record.rootBinding}（${record.rootBinding === rootBinding ? '与当前私人根一致' : '与当前私人根不一致'}）`)
  let generation
  try { generation = await readGenerationRecord(statePath) } catch {
    logError('[library:recover] 库操作记录（operations/library-operation-state.json）损坏或无法读取，拒绝执行。锁保留。')
    return 1
  }
  log(generation
    ? `库操作记录：generation ${generation.generation}，binding ${generation.rootBinding === rootBinding ? '与当前私人根一致' : `${generation.rootBinding}（与当前私人根不一致）`}`
    : '库操作记录：不存在')
  const moved = Boolean((record && record.rootBinding !== rootBinding) || (generation && generation.rootBinding !== rootBinding))
  // The media task identity carries the same binding; only --rebind reads and rewrites it.
  const identity = moved && rebind ? await readMediaTaskIdentity(root) : null
  if (identity?.value) log(`媒体待办身份：binding ${identity.value.rootBinding === rootBinding ? '与当前私人根一致' : `${identity.value.rootBinding}（与当前私人根不一致）`}`)
  if (!confirm) {
    log(moved
      ? '\n未加 --confirm，没有修改任何文件。锁或库操作记录绑定的不是当前私人根（私人根可能被移动、改名或换了盘符）。确认这就是原来的私人库、并且持有这个锁的进程已经不在了之后运行：npm run library:recover -- --confirm --rebind'
      : '\n未加 --confirm，没有修改任何文件。确认持有这个锁的进程已经不在了（编辑器、导入或其他写入已经关闭或崩溃）之后运行：npm run library:recover -- --confirm')
    return 0
  }
  if (moved && !rebind) {
    logError('[library:recover] 锁或库操作记录绑定的不是当前私人根（私人根可能被移动过），拒绝执行。锁保留。'
      + '如果私人根只是被移动、改名或换了盘符，确认之后运行：npm run library:recover -- --confirm --rebind')
    return 1
  }
  if (identity?.invalid) {
    logError('[library:recover] 媒体待办身份（operations/media-import/v1/library.json）损坏或不是普通文件，拒绝重新绑定。锁保留。')
    return 1
  }
  log('\n请确认持有这个锁的进程已经不在了：锁不会因为存在时间长、或进程号不存在而被自动清除，--confirm 表示你已经确认。')
  log('正在检查数据……')
  let problems
  try { problems = [...(await checkData()).problems] } catch (error) { problems = [error?.code ?? '数据检查本身失败'] }
  if (problems.length > 0) {
    logError(`[library:recover] 数据检查没有通过（${problems.length} 项），锁保留。请先处理这些问题或从备份恢复：`)
    for (const problem of problems.slice(0, 20)) logError(`  - ${problem}`)
    if (problems.length > 20) logError(`  ……另有 ${problems.length - 20} 项`)
    return 1
  }
  log('数据检查通过。')
  // Exactly the lock inspected above: a changed lock is someone else's and stays.
  let current
  try { current = await readFile(lockPath) } catch { current = undefined }
  if (!current || !current.equals(lockBytes)) {
    logError('[library:recover] 库操作锁在检查期间发生了变化，拒绝执行。')
    return 1
  }
  // A new generation bound to the current root: the ordinary advance, and with --rebind also the rebinding.
  await writeGenerationRecord(statePath, rootBinding)
  if (identity?.value && identity.value.rootBinding !== rootBinding) {
    await atomicReplace(identity.target, `${JSON.stringify({ ...identity.value, rootBinding }, null, 2)}\n`)
  }
  await unlink(lockPath)
  log(moved
    ? '已把库操作记录（以及媒体待办身份）重新绑定到当前私人根、推进了 generation，并清除了残留的库操作锁。现在可以正常写入。'
    : '已推进库操作记录的 generation，并清除了残留的库操作锁。现在可以正常写入。')
  return 0
}

/**
 * The pre-write check of ordinary formal-store writes (3C-2b, design 3B v1.1 §16.2-1). They take no lease: SQLite's
 * BEGIN IMMEDIATE keeps writers apart. They only refuse while somebody else holds the library operation lock (a media
 * operation, a backup, a restore or a migration). Resolves the private root once and returns `check(leaseToken)`:
 * - no lock: one lstat, returns (a `leaseToken` naming a lease that is no longer held is E_LIBRARY_BUSY);
 * - a lock, and no `leaseToken`, or a token that is not that lock's holder: E_LIBRARY_BUSY;
 * - a lock held by the caller (its verified `leaseToken`, as withLibraryOperation hands it out): returns.
 * Never creates, changes or removes anything.
 */
export function libraryLockProbe(privatePaths) {
  const root = realpathSync(path.resolve(privatePaths.root))
  const lockPath = path.join(root, 'operations', 'library-operation.lock')
  const rootBinding = binding(root)
  return Object.freeze({
    lockPath,
    check(leaseToken) {
      let metadata
      try { metadata = lstatSync(lockPath) } catch (error) {
        if (missing(error) && leaseToken === undefined) return
        throw busy()
      }
      if (leaseToken === undefined) throw busy()
      const supplied = decodeToken(leaseToken)
      let actual
      try {
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw busy()
        actual = JSON.parse(readFileSync(lockPath, 'utf8'))
      } catch { throw busy() }
      if (!valid(actual) || actual.owner !== supplied.owner || actual.rootBinding !== rootBinding || supplied.rootBinding !== rootBinding) throw busy()
    },
  })
}

/** Explicit trusted parent leases allow child importers to join, never to release the lock. */
export async function withLibraryOperation(privatePaths, callback, { leaseToken } = {}) {
  if (leaseToken !== undefined) {
    const supplied = decodeToken(leaseToken)
    try {
      const { lockPath, rootBinding } = await locations(privatePaths, false)
      const actual = await readLock(lockPath)
      if (supplied.rootBinding !== rootBinding || actual.rootBinding !== rootBinding || actual.owner !== supplied.owner) throw busy()
    } catch { throw busy() }
    return callback(leaseToken)
  }

  const { lockPath, statePath, rootBinding } = await locations(privatePaths, true)
  const record = { schemaVersion: version, owner: randomUUID(), rootBinding }
  const encoded = JSON.stringify(record)
  const token = Buffer.from(encoded).toString('base64url')
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') throw busy()
    throw error
  }
  // Once the callback has started, files may have changed under this lease: only a successful second
  // generation advance releases it. Before that, nothing has been written beyond this lock file.
  let callbackStarted = false
  try {
    await handle.writeFile(encoded)
    await handle.sync()
    await handle.close()
    handle = undefined
    await advanceGeneration(statePath, rootBinding)
    callbackStarted = true
    return await callback(token)
  } finally {
    if (handle) await handle.close().catch(() => {})
    // A failed/partial receipt remains for review. Never unlink someone else's receipt.
    try {
      if (callbackStarted) {
        const actual = await readLock(lockPath)
        if (actual.owner === record.owner && actual.rootBinding === record.rootBinding) {
          await advanceGeneration(statePath, rootBinding)
          await unlink(lockPath)
        }
      } else if (await ownUnstartedLock(lockPath, encoded)) {
        // Failed between acquisition and the callback (moved root, damaged generation, failed lock write):
        // remove only this call's own lock, without touching the generation file.
        await unlink(lockPath)
      }
    } catch { /* Conservative: preserve unknown lock content. */ }
  }
}

/** This call created the lock with `wx`; its bytes are our complete record or a prefix left by a failed write. */
async function ownUnstartedLock(lockPath, encoded) {
  const metadata = await lstat(lockPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > encoded.length) return false
  return encoded.startsWith(await readFile(lockPath, 'utf8'))
}
