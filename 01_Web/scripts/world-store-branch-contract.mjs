/** Experimental branch metadata contract, independent of repository envelopes.
 * Descriptor version 1 is NOT repository logical v1/v2 or SQLite storage v3.
 * No IDs are minted, paths resolved, archives opened, or writes authorized here.
 * A future host must persist this in an explicit new logical format and verify
 * actual source/archive bytes plus canonical location before using these checks.
 */
import { freezeCopy, jsonKey, opaqueId, reject, revision, shape, validateJson } from '../src/worldgraph/store/schema.ts'

function identity(value, path) {
  shape(value, ['libraryId', 'branchId', 'genesisId'], undefined, path)
  for (const key of ['libraryId', 'branchId', 'genesisId']) opaqueId(value[key], path + '.' + key)
}
function digest(value, path) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) reject('E_BRANCH_DIGEST', path)
}
function binding(value, path) {
  shape(value, ['hostId', 'locationDigest'], undefined, path)
  opaqueId(value.hostId, path + '.hostId')
  digest(value.locationDigest, path + '.locationDigest')
}
function source(value, path) {
  shape(value, ['repositoryFormatVersion', 'identityStatus', 'identity', 'snapshotDigest', 'repositoryRevision', 'archiveDigest'], undefined, path)
  digest(value.snapshotDigest, path + '.snapshotDigest')
  digest(value.archiveDigest, path + '.archiveDigest')
  revision(value.repositoryRevision, path + '.repositoryRevision')
  if (value.repositoryFormatVersion === 1) {
    // Legacy labels/file names are not permanent source identity evidence.
    if (value.identityStatus !== 'unknown' || value.identity !== null) reject('E_BRANCH_SOURCE_IDENTITY', path)
  } else if (value.repositoryFormatVersion === 2) {
    if (value.identityStatus !== 'known') reject('E_BRANCH_SOURCE_IDENTITY', path)
    identity(value.identity, path + '.identity')
  } else reject('E_BRANCH_SOURCE_VERSION', path)
}

/** Exact source references only; does not attest a complete ancestry chain,
 * host-generated identity, archive availability, or history replay correctness. */
export function readBranchDescriptor(value) {
  validateJson(value)
  shape(value, ['format', 'formatVersion', 'identity', 'origin', 'binding'])
  if (value.format !== 'starmap.repository-branch' || value.formatVersion !== 1) reject('E_BRANCH_VERSION', '$')
  identity(value.identity, '$.identity')
  binding(value.binding, '$.binding')
  shape(value.origin, ['kind', 'source'], undefined, '$.origin')
  const origin = value.origin
  if (origin.kind === 'new') {
    if (origin.source !== null) reject('E_BRANCH_ORIGIN', '$.origin.source')
  } else if (origin.kind === 'fork' || origin.kind === 'upgrade') {
    source(origin.source, '$.origin.source')
    if (origin.kind === 'upgrade') {
      if (origin.source.identityStatus !== 'unknown') reject('E_BRANCH_ORIGIN', '$.origin')
    } else {
      if (origin.source.identityStatus !== 'known') reject('E_BRANCH_ORIGIN', '$.origin')
      const parent = origin.source.identity
      if (parent.libraryId !== value.identity.libraryId || parent.branchId === value.identity.branchId || parent.genesisId === value.identity.genesisId) reject('E_BRANCH_PARENT', '$.origin.source.identity')
    }
  } else reject('E_BRANCH_ORIGIN', '$.origin.kind')
  return freezeCopy(value)
}

/** Host must supply a reference computed from the actual, validated source.
 * An unknown legacy identity permits exact-snapshot matching only. */
export function assertBranchSource(descriptor, observedSource) {
  const branch = readBranchDescriptor(descriptor)
  validateJson(observedSource)
  source(observedSource, '$.observedSource')
  if (branch.origin.source === null || jsonKey(branch.origin.source) !== jsonKey(observedSource)) reject('E_BRANCH_SOURCE_CHANGED', '$.observedSource')
}

/** Consistency guard, not an OS authorization boundary. The future host owns
 * realpath/case/symlink handling; a raw path or caller label is not a binding. */
export function assertBranchWriteBinding(descriptor, observedBinding) {
  const branch = readBranchDescriptor(descriptor)
  validateJson(observedBinding)
  binding(observedBinding, '$.observedBinding')
  if (jsonKey(branch.binding) !== jsonKey(observedBinding)) reject('E_BRANCH_BINDING', '$.observedBinding')
}

/** JSON tuple avoids delimiter collisions; IDs stay opaque and unnormalized.
 * genesisId is validated but is not part of the operation namespace. */
export function operationIdentityKey(permanentIdentity, operationId) {
  validateJson(permanentIdentity)
  identity(permanentIdentity, '$.identity')
  opaqueId(operationId, '$.operationId')
  return JSON.stringify([permanentIdentity.libraryId, permanentIdentity.branchId, operationId])
}

/** References to archived/local operations, not committed receipts. Identical
 * repeats collapse; same namespace with a different request/genesis conflicts.
 * Supplying localIdentity rejects foreign references rather than adopting
 * a parent's operations into child discovery. No rows prove a commit here. */
export function readBranchOperationManifest(value, localIdentity) {
  validateJson(value)
  if (!Array.isArray(value)) reject('E_BRANCH_OPERATIONS', '$')
  if (localIdentity !== undefined) {
    validateJson(localIdentity)
    identity(localIdentity, '$.localIdentity')
  }
  const operations = new Map()
  for (const row of value) {
    shape(row, ['identity', 'operationId', 'requestDigest'])
    const key = operationIdentityKey(row.identity, row.operationId)
    digest(row.requestDigest, '$.requestDigest')
    if (localIdentity !== undefined && jsonKey(row.identity) !== jsonKey(localIdentity)) reject('E_BRANCH_FOREIGN_OPERATION', '$.identity')
    const previous = operations.get(key)
    if (previous && (previous.requestDigest !== row.requestDigest || previous.identity.genesisId !== row.identity.genesisId)) reject('E_BRANCH_OPERATION_CONFLICT', '$.operationId')
    if (!previous) operations.set(key, row)
  }
  return freezeCopy([...operations.values()])
}
