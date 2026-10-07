/** Explicit v1 experimental SQLite -> new writable branch directory.
 * Source remains untouched; no real-private-root/media/config discovery. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, openWorldRepository } from './world-store-repository.mjs'
import { readLegacyRepositoryArchive } from './world-store-legacy-archive.mjs'
import { previewRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { discoverRepositoryFork, forkRepositoryArchiveToDirectory } from './world-store-branch.mjs'

const fail = code => { throw new RepositoryError(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
function translated(error) {
  if (error?.code?.startsWith('E_')) return error
  return new RepositoryError([5, 6].includes(error?.errcode) ? 'E_REPO_BUSY' : 'E_REPO_IO')
}
function withLegacyArchive(sourceFile, options, callback) {
  let source, reader
  try {
    if (typeof sourceFile !== 'string' || !path.isAbsolute(sourceFile)) fail('E_UPGRADE_PATH')
    const stat = lstatSync(sourceFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('E_UPGRADE_PATH')
    const file = realpathSync(sourceFile)
    source = openWorldRepository(file, { readOnly: true, policy: options.policy })
    return source.withSnapshot(state => {
      // The authority's shared read transaction covers all receipt reads and
      // the target's final commit, including the last unsafe test phase.
      reader = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 0 })
      reader.exec('PRAGMA trusted_schema=OFF; BEGIN')
      const receipts = reader.prepare('SELECT * FROM operation_receipts ORDER BY repository_revision').all().map(row => {
        if (hash(row.payload) !== row.digest) fail('E_UPGRADE_CORRUPT')
        const receipt = JSON.parse(row.payload)
        shape(receipt, ['status', 'operationId', 'repositoryRevision', 'worldRevision'])
        if (receipt.operationId !== row.id || receipt.repositoryRevision !== row.repository_revision || receipt.worldRevision !== row.world_revision) fail('E_UPGRADE_CORRUPT')
        return { ...receipt, requestDigest: row.request_digest }
      })
      const archive = readLegacyRepositoryArchive({ format: 'starmap.world-repository-legacy', formatVersion: 1, coverage: 'baselineOnly', editBodies: 'unavailable', state, receipts }, options.policy)
      return callback(archive)
    })
  } catch (error) { throw translated(error) }
  finally {
    try { if (reader) { try { if (reader.isTransaction) reader.exec('ROLLBACK') } finally { reader.close() } } }
    finally { source?.close() }
  }
}
export function previewLegacyRepositoryUpgrade(sourceFile, options = {}) {
  return withLegacyArchive(sourceFile, options, archive => previewRepositoryArchive(archive, options.policy ?? {}))
}
export function upgradeLegacyRepositoryToDirectory(sourceFile, target, preview, operationId, options = {}) {
  validateJson(preview); opaqueId(operationId, 'operationId')
  if (preview?.format !== 'starmap.repository-upgrade-branch-preview') fail('E_UPGRADE_PREVIEW')
  // A valid sealed result is historical. Its source may now have changed or
  // moved; the branch host still checks original preview/request/binding.
  if (discoverRepositoryFork(target, options).status === 'completed') return forkRepositoryArchiveToDirectory(preview.archive, target, preview, operationId, options)
  return withLegacyArchive(sourceFile, options, archive => forkRepositoryArchiveToDirectory(archive, target, preview, operationId, options))
}
