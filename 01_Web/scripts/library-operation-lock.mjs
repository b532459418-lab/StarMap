import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const version = 1
const ownerPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const hashPattern = /^[a-f0-9]{64}$/
const busy = () => new V2WriteError('E_LIBRARY_BUSY')
const missing = (error) => error?.code === 'ENOENT'
const binding = (root) => createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex')
const valid = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && value.schemaVersion === version && typeof value.owner === 'string' && ownerPattern.test(value.owner)
  && typeof value.rootBinding === 'string' && hashPattern.test(value.rootBinding)

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

async function readGeneration(statePath, rootBinding) {
  try {
    const metadata = await lstat(statePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw busy()
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (state?.schemaVersion !== version || state.rootBinding !== rootBinding || typeof state.generation !== 'string' || !ownerPattern.test(state.generation)) throw busy()
    return state.generation
  } catch (error) {
    if (missing(error)) return null
    throw busy()
  }
}

async function advanceGeneration(statePath, rootBinding) {
  await readGeneration(statePath, rootBinding)
  const temporary = `${statePath}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: version, rootBinding, generation: randomUUID() }))
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, statePath) } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
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
        catch { return { state: 'needs_review', reason: 'generation_invalid' } }
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
  const token = Buffer.from(JSON.stringify(record)).toString('base64url')
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') throw busy()
    throw error
  }
  try {
    await handle.writeFile(JSON.stringify(record))
    await handle.sync()
    await handle.close()
    handle = undefined
    await advanceGeneration(statePath, rootBinding)
    return await callback(token)
  } finally {
    if (handle) await handle.close()
    // A failed/partial receipt remains for review. Never unlink someone else's receipt.
    try {
      const actual = await readLock(lockPath)
      if (actual.owner === record.owner && actual.rootBinding === record.rootBinding) {
        await advanceGeneration(statePath, rootBinding)
        await unlink(lockPath)
      }
    } catch { /* Conservative: preserve unknown lock content. */ }
  }
}
