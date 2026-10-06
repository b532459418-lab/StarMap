/** Read-only v1 -> v2 planning. No target creation or executable commands. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { openWorldRepository, RepositoryError } from './world-store-repository.mjs'
import { freezeCopy, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { readRepositoryV2, repositoryStateDigest } from './world-store-repository-v2-contract.mjs'

const fail = code => { throw new RepositoryError(code) }
const bytesDigest = value => createHash('sha256').update(value).digest('hex')
export function previewRepositoryUpgrade(sourceFile, identity, options = {}) {
  validateJson(identity)
  if (typeof sourceFile !== 'string' || !path.isAbsolute(sourceFile)) fail('E_UPGRADE_PATH')
  const stat = lstatSync(sourceFile)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('E_UPGRADE_PATH')
  const source = realpathSync(sourceFile)
  const checked = openWorldRepository(source, { readOnly: true, policy: options.policy })
  checked.close()
  const db = new DatabaseSync(source, { readOnly: true, allowExtension: false, timeout: 0 })
  try {
    db.exec('BEGIN')
    const row = db.prepare('SELECT revision,payload,digest FROM repository_state WHERE singleton=1').get()
    if (!row || bytesDigest(row.payload) !== row.digest) fail('E_UPGRADE_CORRUPT')
    const state = JSON.parse(row.payload)
    if (state.revision !== row.revision) fail('E_UPGRADE_CORRUPT')
    const receipts = db.prepare('SELECT * FROM operation_receipts ORDER BY repository_revision').all().map(receipt => {
      if (bytesDigest(receipt.payload) !== receipt.digest) fail('E_UPGRADE_CORRUPT')
      const value = JSON.parse(receipt.payload)
      shape(value, ['status', 'operationId', 'repositoryRevision', 'worldRevision'])
      if (value.status !== 'committed' || value.operationId !== receipt.id || value.repositoryRevision !== receipt.repository_revision || value.worldRevision !== receipt.world_revision) fail('E_UPGRADE_CORRUPT')
      return { operationId: value.operationId, requestDigest: receipt.request_digest,
        repositoryRevision: value.repositoryRevision, worldRevision: value.worldRevision }
    })
    const envelope = readRepositoryV2({ format: 'starmap.world-repository-v2', formatVersion: 2, identity,
      baseline: { sourceVersion: 1, sourceDigest: repositoryStateDigest(state), coverage: 'baselineOnly', state, receipts }, history: [], state }, options.policy)
    const sourceDigest = repositoryStateDigest({ state, receipts })
    return freezeCopy({ format: 'starmap.repository-upgrade-preview', formatVersion: 1,
      executable: false, commands: [], sourceDigest, previewDigest: repositoryStateDigest({ sourceDigest, envelope }),
      envelope, limitations: ['legacy-edit-bodies-unavailable', 'no-database-conversion', 'no-media-or-app-switch'] })
  } finally {
    try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }
  }
}

/** Revalidate the exact source and selected new identity; never executes it. */
export function revalidateRepositoryUpgrade(sourceFile, preview, options = {}) {
  validateJson(preview)
  shape(preview, ['format', 'formatVersion', 'executable', 'commands', 'sourceDigest', 'previewDigest', 'envelope', 'limitations'])
  const current = previewRepositoryUpgrade(sourceFile, preview.envelope.identity, options)
  if (repositoryStateDigest(current) !== repositoryStateDigest(preview)) fail('E_UPGRADE_STALE')
  return current
}
