/** G3b isolated database packages. No V2/media/config reads or App endpoint.
 * Caller-owned local directories are trusted; hashes detect corruption, not
 * malicious replacement. Incomplete directories are preserved for review. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { openWorldRepository, RepositoryError } from './world-store-repository.mjs'
import { freezeCopy, shape, validateJson } from '../src/worldgraph/store/schema.ts'

const FORMAT = 'starmap.world-repository-package'
const DATABASE = 'world.sqlite', COMPLETION = 'complete.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new RepositoryError(code) }
function translate(error) {
  if (error instanceof RepositoryError) return error
  return new RepositoryError(error?.code === 'EEXIST' ? 'E_BACKUP_EXISTS' : 'E_BACKUP_IO')
}
function directory(input, create = false) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('E_BACKUP_PATH')
  const result = path.join(realpathSync(path.dirname(input)), path.basename(input))
  if (create) mkdirSync(result, { mode: 0o700 })
  const stat = lstatSync(result)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_BACKUP_PATH')
  return result
}
function bytes(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('E_BACKUP_PATH')
  return readFileSync(file)
}
function writeExclusive(file, value) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
}
function phase(options, name) {
  const value = options.unsafeTestPhase?.(name)
  if (value && typeof value.then === 'function') fail('E_BACKUP_ASYNC_HOOK')
}
function manifestFor(kind, databaseBytes, state) {
  return freezeCopy({ format: FORMAT, formatVersion: 1, kind,
    database: { file: DATABASE, bytes: databaseBytes.length, sha256: hash(databaseBytes) },
    repositoryRevision: state.revision, worldRevision: state.world.revision,
    stateSha256: hash(JSON.stringify(state)) })
}
function stateAt(file, options) {
  const repository = openWorldRepository(file, { policy: options.policy, readOnly: true })
  try { return repository.snapshot() } finally { repository.close() }
}
function readPackage(input, kind, options) {
  const root = directory(input)
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([COMPLETION, DATABASE].sort())) fail('E_BACKUP_INCOMPLETE')
  let manifest
  try {
    manifest = JSON.parse(bytes(path.join(root, COMPLETION)).toString('utf8'))
    validateJson(manifest)
    shape(manifest, ['format', 'formatVersion', 'kind', 'database', 'repositoryRevision', 'worldRevision', 'stateSha256'])
    shape(manifest.database, ['file', 'bytes', 'sha256'])
  } catch { fail('E_BACKUP_MANIFEST') }
  if (manifest.format !== FORMAT || manifest.formatVersion !== 1) fail('E_BACKUP_VERSION')
  if (manifest.kind !== kind || manifest.database.file !== DATABASE) fail('E_BACKUP_MANIFEST')
  const file = path.join(root, DATABASE), buffer = bytes(file)
  if (manifest.database.bytes !== buffer.length || manifest.database.sha256 !== hash(buffer)) fail('E_BACKUP_CORRUPT')
  const state = stateAt(file, options)
  const expected = manifestFor(kind, buffer, state)
  // Compare fields without making property order part of the package format.
  if (manifest.database.bytes !== expected.database.bytes || manifest.database.sha256 !== expected.database.sha256 ||
      manifest.repositoryRevision !== expected.repositoryRevision || manifest.worldRevision !== expected.worldRevision ||
      manifest.stateSha256 !== expected.stateSha256) fail('E_BACKUP_CORRUPT')
  if (hash(bytes(file)) !== expected.database.sha256) fail('E_BACKUP_CORRUPT')
  return { manifest: expected, state, buffer }
}

export function verifyWorldRepositoryBackup(directoryPath, options = {}) {
  try { const { manifest, state } = readPackage(directoryPath, 'backup', options); return freezeCopy({ manifest, state }) }
  catch (error) { throw translate(error) }
}
export function verifyWorldRepositoryRestore(directoryPath, options = {}) {
  try { const { manifest, state } = readPackage(directoryPath, 'restore', options); return freezeCopy({ manifest, state }) }
  catch (error) { throw translate(error) }
}
export function backupWorldRepository(sourceFile, destinationDirectory, options = {}) {
  let source, sealAttempted = false
  try {
    source = openWorldRepository(sourceFile, { policy: options.policy, readOnly: true })
    const root = directory(destinationDirectory, true), file = path.join(root, DATABASE)
    phase(options, 'reserved')
    source.exportSnapshot(file); phase(options, 'database-written')
    const state = stateAt(file, options), buffer = bytes(file), manifest = manifestFor('backup', buffer, state)
    phase(options, 'validated')
    sealAttempted = true; writeExclusive(path.join(root, COMPLETION), JSON.stringify(manifest))
    phase(options, 'sealed')
    return freezeCopy({ manifest, state })
  } catch (error) { if (sealAttempted) fail('E_BACKUP_OUTCOME_UNKNOWN'); throw translate(error) }
  finally { source?.close() }
}
export function restoreWorldRepository(backupDirectory, destinationDirectory, options = {}) {
  let sealAttempted = false
  try {
    const backup = readPackage(backupDirectory, 'backup', options)
    const root = directory(destinationDirectory, true), file = path.join(root, DATABASE)
    phase(options, 'reserved')
    writeExclusive(file, backup.buffer); phase(options, 'database-written')
    const state = stateAt(file, options), buffer = bytes(file), manifest = manifestFor('restore', buffer, state)
    if (manifest.database.sha256 !== backup.manifest.database.sha256 || manifest.stateSha256 !== backup.manifest.stateSha256) fail('E_BACKUP_CORRUPT')
    phase(options, 'validated')
    sealAttempted = true; writeExclusive(path.join(root, COMPLETION), JSON.stringify(manifest))
    phase(options, 'sealed')
    return freezeCopy({ manifest, state })
  } catch (error) { if (sealAttempted) fail('E_BACKUP_OUTCOME_UNKNOWN'); throw translate(error) }
}
