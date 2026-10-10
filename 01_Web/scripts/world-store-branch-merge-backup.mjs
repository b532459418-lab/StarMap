/** Synthetic Saved backup packages and readonly historical loading. No writable
 * restore, database rebinding, new receipts, media/config or App integration.
 * Host callbacks test a trusted process protocol, not OS identity/permissions.
 */
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { freezeCopy, jsonKey, opaqueId, shape } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { checkRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { readRepositoryMergeSavedArchive } from './world-store-branch-merge-store-contract.mjs'
import { createRepositoryMergeStoreHost, openRepositoryMergeStore, restoreRepositoryMergeStoreFromBackup } from './world-store-branch-merge-store.mjs'
import { previewRepositorySavedBranchFork } from './world-store-saved-branch-fork-contract.mjs'

export const MAX_MERGE_BACKUP_BYTES = 128 * 1024 * 1024
const FORMAT = 'starmap.repository-merge-backup', PREVIEW = FORMAT + '-preview'
const hosts = new WeakMap(), fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
const hash = value => createHash('sha256').update(value).digest('hex')
const idOf = value => ({ dev: String(value.dev), ino: String(value.ino) })
const fileId = file => idOf(lstatSync(file, { bigint: true }))
function translate(error) {
  if (error?.code?.startsWith('E_')) return error
  return new RepositoryError(error?.code === 'EEXIST' ? 'E_MERGE_BACKUP_EXISTS' : 'E_MERGE_BACKUP_IO')
}
function host(options) {
  const value = hosts.get(options?.host)
  if (!value) fail('E_MERGE_BACKUP_AUTHORITY')
  return value
}
/** Backend capability stays private and denies every database write/recovery. */
export function createRepositoryMergeBackupHost(input) {
  const sandboxRoot = input.sandboxRoot
  if (typeof sandboxRoot !== 'string' || !path.isAbsolute(sandboxRoot) || path.normalize(sandboxRoot) !== sandboxRoot
    || path.dirname(sandboxRoot) !== realpathSync(tmpdir()) || !path.basename(sandboxRoot).startsWith('starmap-merge-store-')) fail('E_MERGE_BACKUP_LAB')
  const stat = lstatSync(sandboxRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(sandboxRoot) !== sandboxRoot) fail('E_MERGE_BACKUP_LAB')
  opaqueId(input.hostId, 'hostId')
  if (input.authorize !== undefined && typeof input.authorize !== 'function') fail('E_MERGE_BACKUP_AUTHORITY')
  const token = Object.freeze({})
  const backend = createRepositoryMergeStoreHost({ sandboxRoot, hostId: input.hostId })
  hosts.set(token, { sandboxRoot, labIdentity: fileId(sandboxRoot), hostId: input.hostId, backend, authorize: input.authorize ?? (() => false) })
  return token
}
function location(input, context, exists = true) {
  if (!equal(fileId(context.sandboxRoot), context.labIdentity)) fail('E_MERGE_BACKUP_PATH')
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.normalize(input) !== input
    || !input.startsWith(context.sandboxRoot + path.sep)) fail('E_MERGE_BACKUP_PATH')
  const name = path.basename(input)
  if (!name || (process.platform === 'win32' && (/[. :]+$/.test(name) || /:/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) fail('E_MERGE_BACKUP_PATH')
  const ancestors = []
  let parent = context.sandboxRoot
  for (const part of path.relative(context.sandboxRoot, path.dirname(input)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part)
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_MERGE_BACKUP_PATH')
    ancestors.push({ path: parent, identity: fileId(parent) })
  }
  if (realpathSync(parent) !== parent) fail('E_MERGE_BACKUP_PATH')
  if (exists) {
    const stat = lstatSync(input)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(input) !== input) fail('E_MERGE_BACKUP_PATH')
  }
  return { root: input, ancestors }
}
function verifyLocation(pin, context, rootIdentity) {
  const actual = location(pin.root, context, rootIdentity !== undefined)
  if (!equal(pin.ancestors, actual.ancestors) || (rootIdentity && !equal(rootIdentity, fileId(pin.root)))) fail('E_MERGE_BACKUP_PATH')
}
function bytes(file, limit = MAX_MERGE_BACKUP_BYTES) {
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('E_MERGE_BACKUP_PATH')
  if (stat.size <= 0n || stat.size > BigInt(limit)) fail('E_MERGE_BACKUP_SIZE')
  const fd = openSync(file, 'r')
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || !equal(idOf(stat), idOf(opened))) fail('E_MERGE_BACKUP_PATH')
    if (opened.size !== stat.size || opened.size <= 0n || opened.size > BigInt(limit)) fail('E_MERGE_BACKUP_SIZE')
    const buffer = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (count === 0) fail('E_MERGE_BACKUP_SIZE')
      offset += count
    }
    const ended = fstatSync(fd, { bigint: true })
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || ended.size !== opened.size) fail('E_MERGE_BACKUP_SIZE')
    if (ended.nlink !== 1n || !equal(idOf(opened), idOf(ended))) fail('E_MERGE_BACKUP_PATH')
    if (!equal(idOf(stat), fileId(file))) fail('E_MERGE_BACKUP_PATH')
    return { buffer, identity: idOf(stat) }
  } finally { closeSync(fd) }
}
function exclusive(file, buffer) {
  let fd
  try {
    fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, buffer); fsyncSync(fd)
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(Buffer.byteLength(buffer))) fail('E_MERGE_BACKUP_PATH')
    return idOf(stat)
  } catch (error) { throw translate(error) }
  finally { if (fd !== undefined) closeSync(fd) }
}
function phase(options, name) {
  const value = options.unsafeTestPhase?.(name)
  if (value && typeof value.then === 'function') fail('E_MERGE_BACKUP_ASYNC')
}
function makePreview(input, policy) {
  checkRepositoryMergeArchiveInputs([input, policy])
  const saved = readRepositoryMergeSavedArchive(input, policy)
  const raw = { format: PREVIEW, formatVersion: 1, saved, savedDigest: saved.savedDigest, policyDigest: digest(policy) }
  return freezeCopy({ ...raw, previewDigest: digest(raw) })
}
function manifestFor(saved, buffer, preview, operationId) {
  return freezeCopy({ format: FORMAT, formatVersion: 1, operationId, previewDigest: preview.previewDigest,
    policyDigest: preview.policyDigest, requestDigest: digest({ operationId, previewDigest: preview.previewDigest }),
    identity: saved.baseArchive.descriptor.identity, repositoryRevision: saved.projection.state.revision,
    worldRevision: saved.projection.state.world.revision, savedDigest: saved.savedDigest,
    snapshot: { file: 'saved.json', bytes: buffer.length, sha256: hash(buffer), digest: digest(saved) } })
}
function parse(buffer) {
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) } catch { fail('E_MERGE_BACKUP_CORRUPT') }
  checkRepositoryMergeArchiveInputs([value])
  return value
}
function readPackage(target, options) {
  const context = host(options), policy = freezeCopy(options.policy ?? {})
  const pin = location(target, context), rootIdentity = fileId(pin.root)
  if (!equal(readdirSync(pin.root).sort(), ['complete.json', 'saved.json'])) fail('E_MERGE_BACKUP_INCOMPLETE')
  const manifestBytes = bytes(path.join(pin.root, 'complete.json'), 128 * 1024)
  const savedBytes = bytes(path.join(pin.root, 'saved.json'))
  const manifest = parse(manifestBytes.buffer), input = parse(savedBytes.buffer)
  shape(manifest, ['format', 'formatVersion', 'operationId', 'previewDigest', 'policyDigest', 'requestDigest',
    'identity', 'repositoryRevision', 'worldRevision', 'savedDigest', 'snapshot'])
  if (manifest.format !== FORMAT || manifest.formatVersion !== 1) fail('E_MERGE_BACKUP_VERSION')
  opaqueId(manifest.operationId, 'operationId')
  shape(manifest.snapshot, ['file', 'bytes', 'sha256', 'digest'])
  if (manifest.snapshot.file !== 'saved.json' || manifest.snapshot.bytes !== savedBytes.buffer.length
    || manifest.snapshot.sha256 !== hash(savedBytes.buffer)) fail('E_MERGE_BACKUP_CORRUPT')
  const saved = readRepositoryMergeSavedArchive(input, policy), preview = makePreview(saved, policy)
  if (!equal(manifest, manifestFor(saved, savedBytes.buffer, preview, manifest.operationId))) fail('E_MERGE_BACKUP_CORRUPT')
  const savedAgain = bytes(path.join(pin.root, 'saved.json')), manifestAgain = bytes(path.join(pin.root, 'complete.json'), 128 * 1024)
  if (!equal(savedBytes.identity, savedAgain.identity) || !equal(manifestBytes.identity, manifestAgain.identity)
    || hash(savedAgain.buffer) !== hash(savedBytes.buffer) || hash(manifestAgain.buffer) !== hash(manifestBytes.buffer)) fail('E_MERGE_BACKUP_CORRUPT')
  verifyLocation(pin, context, rootIdentity)
  if (!equal(readdirSync(pin.root).sort(), ['complete.json', 'saved.json'])) fail('E_MERGE_BACKUP_INCOMPLETE')
  return freezeCopy({ status: 'completed', manifest, saved })
}
export function previewRepositoryMergeBackup(source, options = {}) {
  const context = host(options), store = openRepositoryMergeStore(source, { host: context.backend, policy: options.policy, readOnly: true })
  try { return store.withSnapshot(saved => makePreview(saved, options.policy ?? {})) } finally { store.close() }
}
export function verifyRepositoryMergeBackup(target, options = {}) {
  try { return readPackage(target, options) } catch (error) { throw translate(error) }
}
export function discoverRepositoryMergeBackup(target, options = {}) {
  const context = host(options)
  try {
    const pin = location(target, context, false)
    let stat
    try { stat = lstatSync(pin.root) } catch (error) { if (error.code === 'ENOENT') return freezeCopy({ status: 'absent' }); throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_MERGE_BACKUP_PATH')
    location(target, context)
    if (!readdirSync(pin.root).includes('complete.json')) return freezeCopy({ status: 'incomplete' })
    return readPackage(target, options)
  } catch (error) { throw translate(error) }
}
export function backupRepositoryMergeStore(source, target, input, operationId, options = {}) {
  checkRepositoryMergeArchiveInputs([input, operationId, options.policy ?? {}])
  opaqueId(operationId, 'operationId')
  shape(input, ['format', 'formatVersion', 'saved', 'savedDigest', 'policyDigest', 'previewDigest'])
  const context = host(options), policy = freezeCopy(options.policy ?? {}), preview = makePreview(input.saved, policy)
  if (!equal(input, preview)) fail('E_MERGE_BACKUP_PREVIEW')
  const pin = location(target, context, false), existing = discoverRepositoryMergeBackup(target, { ...options, policy })
  if (existing.status === 'completed') {
    if (existing.manifest.requestDigest !== digest({ operationId, previewDigest: preview.previewDigest })) fail('E_MERGE_BACKUP_EXISTS')
    return existing
  }
  if (existing.status !== 'absent') fail('E_MERGE_BACKUP_INCOMPLETE')
  const sourcePin = location(source, context)
  if (pin.root === sourcePin.root || pin.root.startsWith(sourcePin.root + path.sep)) fail('E_MERGE_BACKUP_PATH')
  const verifyParents = () => {
    for (const ancestor of [context.sandboxRoot, ...pin.ancestors.map(row => row.path)]) {
      if (readdirSync(ancestor).some(name => ['world.sqlite', 'binding.json', 'saved.json', 'complete.json'].includes(name))) fail('E_MERGE_BACKUP_PATH')
    }
  }
  verifyParents()
  const store = openRepositoryMergeStore(source, { host: context.backend, policy, readOnly: true })
  let attempted = false
  try {
    return store.withSnapshot((saved, verifySource) => {
      if (!equal(makePreview(saved, policy), preview)) fail('E_MERGE_BACKUP_STALE')
      const decision = context.authorize(freezeCopy({ kind: 'backup', hostId: context.hostId, target: pin.root, operationId,
        previewDigest: preview.previewDigest, savedDigest: saved.savedDigest, policyDigest: digest(policy) }))
      if (decision && typeof decision.then === 'function') fail('E_MERGE_BACKUP_ASYNC')
      if (decision !== true) fail('E_MERGE_BACKUP_AUTHORITY')
      verifyLocation(pin, context); verifyParents(); verifySource()
      const buffer = Buffer.from(JSON.stringify(saved))
      if (buffer.length > MAX_MERGE_BACKUP_BYTES) fail('E_MERGE_BACKUP_SIZE')
      try { mkdirSync(pin.root, { mode: 0o700 }) } catch (error) { throw translate(error) }
      const rootIdentity = fileId(pin.root), file = path.join(pin.root, 'saved.json')
      let savedIdentity, completeIdentity, manifestBuffer
      const verify = () => {
        verifySource(); verifyLocation(pin, context, rootIdentity); verifyParents()
        const names = readdirSync(pin.root)
        if (names.some(name => !['saved.json', 'complete.json'].includes(name))) fail('E_MERGE_BACKUP_PATH')
        if (savedIdentity) {
          const actual = bytes(file)
          if (!equal(actual.identity, savedIdentity) || hash(actual.buffer) !== hash(buffer)) fail('E_MERGE_BACKUP_CORRUPT')
        }
        if (completeIdentity) {
          const actual = bytes(path.join(pin.root, 'complete.json'), 128 * 1024)
          if (!equal(actual.identity, completeIdentity) || hash(actual.buffer) !== hash(manifestBuffer)) fail('E_MERGE_BACKUP_CORRUPT')
        }
      }
      phase(options, 'reserved'); verify()
      savedIdentity = exclusive(file, buffer)
      phase(options, 'snapshot-written'); verify()
      const manifest = manifestFor(saved, buffer, preview, operationId)
      manifestBuffer = Buffer.from(JSON.stringify(manifest))
      phase(options, 'before-seal'); verify()
      if (!equal(readdirSync(pin.root), ['saved.json'])) fail('E_MERGE_BACKUP_EXISTS')
      attempted = true; completeIdentity = exclusive(path.join(pin.root, 'complete.json'), manifestBuffer)
      phase(options, 'sealed'); verify()
      const result = readPackage(pin.root, { ...options, policy })
      if (!equal(result.manifest, manifest) || !equal(result.saved, saved)) fail('E_MERGE_BACKUP_CORRUPT')
      return result
    })
  } catch (error) {
    if (attempted) fail('E_MERGE_BACKUP_OUTCOME_UNKNOWN')
    throw translate(error)
  } finally { store.close() }
}
export function openRepositoryMergeBackup(target, options = {}) {
  const pkg = verifyRepositoryMergeBackup(target, options)
  return Object.freeze({ writableRestoreSupported: false, executable: false,
    state: () => pkg.saved.projection.state,
    snapshot: () => pkg.saved,
    findArchivedOperation(operationId) {
      opaqueId(operationId, 'operationId')
      const initialization = pkg.saved.initialization?.receipt
      if (initialization?.operationId === operationId) return freezeCopy({ archived: true, receipt: initialization })
      const event = pkg.saved.events.find(row => row.storeRequest.operationId === operationId)
      return event ? freezeCopy({ archived: true, receipt: event.receipt }) : undefined
    },
  })
}
export function previewRepositoryMergeBackupRestore(target, options = {}) {
  return withVerifiedRepositoryMergeBackup(target, options, (pkg, _verify, evidence) =>
    repositoryMergeBackupRestorePreview(pkg, evidence, options.policy ?? {}))
}
/** Deterministic comparison data; actual restore obtains pkg/evidence from IO. */
export function repositoryMergeBackupRestorePreview(pkg, evidence, policy = {}) {
  checkRepositoryMergeArchiveInputs([pkg, evidence, policy])
  const raw = { format: 'starmap.repository-merge-backup-restore-preview', formatVersion: 1,
    packageDigest: digest(pkg.manifest), packageEvidenceDigest: evidence, savedDigest: pkg.saved.savedDigest,
    sourceArchiveDigest: digest(pkg.saved), forkPreview: previewRepositorySavedBranchFork(pkg.saved, policy),
    policyDigest: digest(policy), executable: false, persisted: false, commands: [] }
  return freezeCopy({ ...raw, previewDigest: digest(raw) })
}
/** Holds real member descriptors and pins bytes throughout synchronous restore.
 * No database capability is provided to the callback or backup context. */
export function withVerifiedRepositoryMergeBackup(target, options, callback) {
  const context = host(options), pin = location(target, context), rootIdentity = fileId(pin.root)
  const pkg = readPackage(target, options), handles = []
  let active = true, outcome, failure, hasFailure = false
  try {
    const members = ['saved.json', 'complete.json'].map(name => {
      const file = path.join(pin.root, name), limit = name === 'complete.json' ? 128 * 1024 : MAX_MERGE_BACKUP_BYTES
      const captured = bytes(file, limit)
      if (name === 'saved.json' && hash(captured.buffer) !== pkg.manifest.snapshot.sha256) fail('E_MERGE_BACKUP_CORRUPT')
      if (name === 'complete.json' && !equal(parse(captured.buffer), pkg.manifest)) fail('E_MERGE_BACKUP_CORRUPT')
      const fd = openSync(file, 'r'); handles.push(fd)
      if (!equal(idOf(fstatSync(fd, { bigint: true })), captured.identity)) fail('E_MERGE_BACKUP_PATH')
      return { file, limit, fd, identity: captured.identity, sha256: hash(captured.buffer), size: captured.buffer.length }
    })
    const evidence = digest({ rootIdentity, ancestors: pin.ancestors,
      members: members.map(({ identity, sha256, size }) => ({ identity, sha256, size })) })
    const verify = () => {
      if (!active) fail('E_MERGE_BACKUP_ASYNC')
      verifyLocation(pin, context, rootIdentity)
      if (!equal(readdirSync(pin.root).sort(), ['complete.json', 'saved.json'])) fail('E_MERGE_BACKUP_CORRUPT')
      for (const member of members) {
        const opened = fstatSync(member.fd, { bigint: true }), actual = bytes(member.file, member.limit)
        if (!equal(idOf(opened), member.identity) || opened.nlink !== 1n || opened.size !== BigInt(member.size)
          || !equal(actual.identity, member.identity) || hash(actual.buffer) !== member.sha256) fail('E_MERGE_BACKUP_CORRUPT')
      }
    }
    verify()
    const result = callback(pkg, verify, evidence)
    if (result && typeof result.then === 'function') fail('E_MERGE_BACKUP_ASYNC')
    verify(); outcome = result
  } catch (error) { failure = error; hasFailure = true }
  finally {
    active = false
    for (const fd of handles.reverse()) {
      try { closeSync(fd) } catch (error) { if (!hasFailure) { failure = error; hasFailure = true } }
    }
  }
  if (hasFailure) throw translate(failure)
  return outcome
}
export function restoreRepositoryMergeBackup(backup, target, inputPreview, operationId, options = {}) {
  return restoreRepositoryMergeStoreFromBackup(backup, target, inputPreview, operationId,
    { ...options, host: options.restoreHost, backupHost: options.host })
}
