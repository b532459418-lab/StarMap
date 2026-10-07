/** Pure v1 snapshot/receipt archive. No permanent source identity exists and
 * old edit bodies cannot be reconstructed from their request fingerprints. */
import { freezeCopy, opaqueId, revision, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, readRepositoryState } from './world-store-repository.mjs'
const fail = code => { throw new RepositoryError(code) }
export function readLegacyRepositoryArchive(value, policy = {}) {
  validateJson(value)
  shape(value, ['format', 'formatVersion', 'coverage', 'editBodies', 'state', 'receipts'])
  if (value.format !== 'starmap.world-repository-legacy' || value.formatVersion !== 1) fail('E_LEGACY_ARCHIVE_VERSION')
  if (value.coverage !== 'baselineOnly' || value.editBodies !== 'unavailable') fail('E_LEGACY_ARCHIVE_COVERAGE')
  const state = readRepositoryState(value.state, policy)
  if (!Array.isArray(value.receipts) || value.receipts.length !== state.revision) fail('E_LEGACY_ARCHIVE_RECEIPTS')
  const operations = new Set()
  let previousWorldRevision = 0
  for (const [index, row] of value.receipts.entries()) {
    shape(row, ['status', 'operationId', 'requestDigest', 'repositoryRevision', 'worldRevision'])
    opaqueId(row.operationId, 'operationId')
    revision(row.repositoryRevision, 'repositoryRevision'); revision(row.worldRevision, 'worldRevision')
    if (row.status !== 'committed' || typeof row.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestDigest)
      || operations.has(row.operationId) || row.repositoryRevision !== index + 1 || row.worldRevision < previousWorldRevision
      || row.worldRevision > state.world.revision) fail('E_LEGACY_ARCHIVE_RECEIPTS')
    operations.add(row.operationId); previousWorldRevision = row.worldRevision
  }
  if (value.receipts.length && previousWorldRevision !== state.world.revision) fail('E_LEGACY_ARCHIVE_RECEIPTS')
  return freezeCopy(value)
}
