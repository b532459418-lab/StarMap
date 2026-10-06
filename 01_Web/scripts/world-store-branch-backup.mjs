/** Experimental database snapshot packages only, no media/config/App access.
 * Immutable backup identity is retained; writable restore creates a new branch.
 * Fingerprints detect corruption, not malicious replacement by the same user.
 */
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { freezeCopy, opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { openRepositoryBranch, forkRepositoryArchiveToDirectory, discoverRepositoryFork } from './world-store-branch.mjs'
import { readBranchSnapshot, previewRepositoryArchive } from './world-store-branch-snapshot.mjs'

export const MAX_BRANCH_BACKUP_BYTES = 128 * 1024 * 1024
const FORMAT = 'starmap.repository-branch-backup'
const fail = code => { throw new RepositoryError(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function translate(error) {
  if (error?.code?.startsWith('E_')) return error
  return new RepositoryError(error?.code === 'EEXIST' ? 'E_BACKUP_EXISTS' : 'E_BACKUP_IO')
}
function location(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('E_BACKUP_PATH')
  const name = path.basename(input)
  if (!name || (process.platform === 'win32' && (/[. :]+$/.test(name) || name.includes(':') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) fail('E_BACKUP_PATH')
  return path.join(realpathSync(path.dirname(input)), name)
}
function bytes(file, limit = MAX_BRANCH_BACKUP_BYTES) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('E_BACKUP_PATH')
  if (stat.size <= 0 || stat.size > limit) fail('E_BACKUP_SIZE')
  return readFileSync(file)
}
function exclusive(file, buffer) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, buffer); fsyncSync(fd) } finally { closeSync(fd) }
}
function phase(options, name) {
  const result = options.unsafeTestPhase?.(name)
  if (result && typeof result.then === 'function') fail('E_BACKUP_ASYNC_HOOK')
}
function backupPreview(value, policy) {
  const snapshot = readBranchSnapshot(value, policy)
  const raw = { format: 'starmap.repository-branch-backup-preview', formatVersion: 1, snapshot, snapshotDigest: digest(snapshot), policyDigest: digest(policy) }
  return freezeCopy({ ...raw, previewDigest: digest(raw) })
}
export function previewRepositoryBranchBackup(source, options = {}) {
  const branch = openRepositoryBranch(source, { readOnly: true, policy: options.policy })
  try { return branch.withSnapshot(snapshot => backupPreview(snapshot, options.policy ?? {})) } finally { branch.close() }
}
function manifestFor(snapshot, buffer, preview, operationId) {
  return freezeCopy({ format: FORMAT, formatVersion: 1, operationId, previewDigest: preview.previewDigest,
    requestDigest: digest({ operationId, previewDigest: preview.previewDigest }), identity: snapshot.descriptor.identity,
    repositoryRevision: snapshot.state.revision, worldRevision: snapshot.state.world.revision,
    snapshot: { file: 'snapshot.json', bytes: buffer.length, sha256: hash(buffer), digest: digest(snapshot) } })
}
function readPackage(target, options = {}) {
  const root = location(target), stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_BACKUP_PATH')
  if (digest(readdirSync(root).sort()) !== digest(['complete.json', 'snapshot.json'])) fail('E_BACKUP_INCOMPLETE')
  let manifest, input
  const manifestBytes = bytes(path.join(root, 'complete.json'), 128 * 1024)
  const buffer = bytes(path.join(root, 'snapshot.json'))
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); input = JSON.parse(buffer.toString('utf8')) } catch { fail('E_BACKUP_CORRUPT') }
  validateJson(manifest)
  shape(manifest, ['format', 'formatVersion', 'operationId', 'previewDigest', 'requestDigest', 'identity', 'repositoryRevision', 'worldRevision', 'snapshot'])
  if (manifest.format !== FORMAT || manifest.formatVersion !== 1) fail('E_BACKUP_VERSION')
  opaqueId(manifest.operationId, 'operationId')
  shape(manifest.snapshot, ['file', 'bytes', 'sha256', 'digest'])
  if (manifest.snapshot.file !== 'snapshot.json' || manifest.snapshot.bytes !== buffer.length || manifest.snapshot.sha256 !== hash(buffer)) fail('E_BACKUP_CORRUPT')
  const snapshot = readBranchSnapshot(input, options.policy ?? {}), preview = backupPreview(snapshot, options.policy ?? {})
  if (digest(manifest) !== digest(manifestFor(snapshot, buffer, preview, manifest.operationId))) fail('E_BACKUP_CORRUPT')
  // Pin actual file bytes as well as canonical snapshot semantics.
  if (hash(bytes(path.join(root, 'snapshot.json'))) !== hash(buffer) || hash(bytes(path.join(root, 'complete.json'), 128 * 1024)) !== hash(manifestBytes)) fail('E_BACKUP_CHANGED')
  return freezeCopy({ status: 'completed', manifest, snapshot })
}
export function verifyRepositoryBranchBackup(target, options = {}) {
  try { return readPackage(target, options) } catch (error) { throw translate(error) }
}
export function discoverRepositoryBranchBackup(target, options = {}) {
  const root = location(target)
  let stat
  try { stat = lstatSync(root) } catch (error) { if (error.code === 'ENOENT') return freezeCopy({ status: 'absent' }); throw translate(error) }
  try {
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_BACKUP_PATH')
    if (!readdirSync(root).includes('complete.json')) return freezeCopy({ status: 'incomplete' })
    return readPackage(root, options)
  } catch (error) { throw translate(error) }
}
export function backupRepositoryBranch(source, target, input, operationId, options = {}) {
  opaqueId(operationId, 'operationId'); validateJson(input)
  const policy = freezeCopy(options.policy ?? {}), expected = backupPreview(input.snapshot, policy)
  if (digest(input) !== digest(expected)) fail('E_BACKUP_PREVIEW')
  const root = location(target), existing = discoverRepositoryBranchBackup(root, { policy })
  if (existing.status === 'completed') {
    if (existing.manifest.requestDigest !== digest({ operationId, previewDigest: input.previewDigest })) fail('E_BACKUP_EXISTS')
    return existing
  }
  if (existing.status !== 'absent') fail('E_BACKUP_INCOMPLETE')
  const branch = openRepositoryBranch(source, { readOnly: true, policy })
  let sealAttempted = false
  try { return branch.withSnapshot(snapshot => {
    if (digest(backupPreview(snapshot, policy)) !== digest(input)) fail('E_BACKUP_CHANGED')
    const buffer = Buffer.from(JSON.stringify(snapshot))
    if (buffer.length > MAX_BRANCH_BACKUP_BYTES) fail('E_BACKUP_SIZE')
    mkdirSync(root, { mode: 0o700 }); phase(options, 'reserved')
    exclusive(path.join(root, 'snapshot.json'), buffer); phase(options, 'snapshot-written')
    const manifest = manifestFor(snapshot, buffer, input, operationId)
    phase(options, 'before-seal')
    if (hash(bytes(path.join(root, 'snapshot.json'))) !== manifest.snapshot.sha256) fail('E_BACKUP_CORRUPT')
    sealAttempted = true; exclusive(path.join(root, 'complete.json'), JSON.stringify(manifest))
    phase(options, 'sealed'); return readPackage(root, { policy })
  }) } catch (error) { if (sealAttempted) fail('E_BACKUP_OUTCOME_UNKNOWN'); throw translate(error) }
  finally { branch.close() }
}
export function previewRepositoryBranchRestore(backup, options = {}) {
  const pkg = verifyRepositoryBranchBackup(backup, options)
  return restorePreview(pkg, options)
}
function restorePreview(pkg, options) {
  const raw = { format: 'starmap.repository-branch-restore-preview', formatVersion: 1, packageDigest: digest(pkg.manifest), forkPreview: previewRepositoryArchive(pkg.snapshot, options.policy ?? {}) }
  return freezeCopy({ ...raw, previewDigest: digest(raw) })
}
export function restoreRepositoryBranch(backup, target, input, operationId, options = {}) {
  opaqueId(operationId, 'operationId'); validateJson(input)
  shape(input, ['format', 'formatVersion', 'packageDigest', 'forkPreview', 'previewDigest'])
  if (input.format !== 'starmap.repository-branch-restore-preview' || input.formatVersion !== 1
    || typeof input.packageDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.packageDigest)) fail('E_BACKUP_PREVIEW')
  const forkPreview = previewRepositoryArchive(input.forkPreview.archive, options.policy ?? {})
  const raw = { format: input.format, formatVersion: input.formatVersion, packageDigest: input.packageDigest, forkPreview }
  if (digest(input) !== digest({ ...raw, previewDigest: digest(raw) })) fail('E_BACKUP_PREVIEW')
  const context = { kind: 'backup-restore', requestId: operationId, packageDigest: input.packageDigest }
  // Sealed historical success is discovered without reopening a now removed or
  // edited external backup. The fork host still checks context/head/binding.
  if (discoverRepositoryFork(target, options).status === 'completed') return forkRepositoryArchiveToDirectory(input.forkPreview.archive, target, input.forkPreview, operationId, { ...options, context })
  const pkg = verifyRepositoryBranchBackup(backup, options), current = restorePreview(pkg, options)
  if (digest(input) !== digest(current)) fail('E_BACKUP_CHANGED')
  return forkRepositoryArchiveToDirectory(pkg.snapshot, target, input.forkPreview, operationId, { ...options, context, unsafeTestPhase(name) {
    phase(options, name)
    if (name === 'before-seal' && digest(verifyRepositoryBranchBackup(backup, options).manifest) !== input.packageDigest) fail('E_BACKUP_CHANGED')
  } })
}
