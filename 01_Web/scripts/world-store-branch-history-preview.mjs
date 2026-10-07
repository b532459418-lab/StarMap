/** Experimental, read-only comparison of validated v1/v2/v3 archives.
 * Complete supported logs are replayed before comparison. Fingerprints prove
 * consistency, not authorship. No decisions, commands, new IDs or writes. */
import { freezeCopy, jsonKey, STORE_TABLES, validateJson } from '../src/worldgraph/store/schema.ts'
import { identityKey } from '../src/data/canonical/storeBridgeIdentity.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { operationIdentityKey } from './world-store-branch-contract.mjs'
import { readRepositoryArchive, branchSourceReference } from './world-store-branch-snapshot.mjs'

const equal = (a, b) => a === undefined || b === undefined ? a === b : jsonKey(a) === jsonKey(b)
const retiredKey = row => jsonKey([row.table, row.id])
const branchKey = identity => jsonKey([identity.libraryId, identity.branchId])
const fail = code => { throw new RepositoryError(code) }

function historyIndex(archive) {
  const operations = new Map(), branches = new Map(), checkpoints = [], legacy = new Map()
  const checkpoint = (identity, state, historyDigest) => {
    const stateDigest = digest(state)
    checkpoints.push({ key: jsonKey([identity, state.revision, stateDigest, historyDigest]), identity,
      repositoryRevision: state.revision, stateDigest, historyDigest, state })
  }
  function visit(value) {
    if (value.formatVersion === 1) {
      legacy.set(digest(value), { archiveDigest: digest(value), receiptCount: value.receipts.length, stateDigest: digest(value.state) })
      return
    }
    if (value.formatVersion === 3) visit(value.sourceArchive)
    else legacy.set(digest(value.baseline), { archiveDigest: digest(value.baseline), receiptCount: value.baseline.receipts.length, stateDigest: digest(value.baseline.state) })
    const identity = value.formatVersion === 2 ? value.identity : value.descriptor.identity
    let prefix = digest(value.formatVersion === 2 ? { identity, baseline: value.baseline }
      : { descriptor: value.descriptor, creation: value.creation, markerDigest: value.markerDigest })
    const key = branchKey(identity), previous = branches.get(key)
    const origin = { identity, originDigest: prefix }
    if (previous && !equal(previous, origin)) fail('E_BRANCH_HISTORY_NAMESPACE')
    branches.set(key, origin)
    checkpoint(identity, value.formatVersion === 2 ? value.baseline.state : value.sourceArchive.state, prefix)
    for (const row of value.history) {
      const operation = { identity, operationId: row.operationId, requestDigest: row.requestDigest,
        beforeDigest: row.beforeDigest, afterDigest: row.afterDigest }
      const key = operationIdentityKey(identity, row.operationId), previous = operations.get(key)
      if (previous && !equal(previous, operation)) fail('E_BRANCH_HISTORY_NAMESPACE')
      operations.set(key, operation)
      prefix = digest({ prefix, operation })
      checkpoint(identity, row.after, prefix)
    }
  }
  visit(archive)
  return { operations, branches, checkpoints, legacy }
}

function compareHistory(target, source, conflicts) {
  const operations = { identical: [], incomingOnly: [], targetOnly: [], conflicting: [] }
  for (const [key, incoming] of source.operations) {
    const current = target.operations.get(key)
    if (!current) operations.incomingOnly.push(incoming)
    else if (equal(current, incoming)) operations.identical.push(incoming)
    else {
      operations.conflicting.push({ current, incoming })
      conflicts.push({ kind: 'operation-identity', identity: incoming.identity, operationId: incoming.operationId,
        currentDigest: current.requestDigest, incomingDigest: incoming.requestDigest })
    }
  }
  for (const [key, current] of target.operations) if (!source.operations.has(key)) operations.targetOnly.push(current)
  for (const [key, incoming] of source.branches) {
    const current = target.branches.get(key)
    if (current && current.identity.genesisId !== incoming.identity.genesisId) conflicts.push({ kind: 'branch-genesis', current: current.identity, incoming: incoming.identity })
    else if (current && current.originDigest !== incoming.originDigest) conflicts.push({ kind: 'branch-origin', identity: incoming.identity,
      currentDigest: current.originDigest, incomingDigest: incoming.originDigest })
  }
  const legacy = { identical: [], incomingOnly: [], targetOnly: [], crossPackageDeduplication: false, editBodies: 'unavailable' }
  for (const [key, row] of source.legacy) (target.legacy.has(key) ? legacy.identical : legacy.incomingOnly).push(row)
  for (const [key, row] of target.legacy) if (!source.legacy.has(key)) legacy.targetOnly.push(row)
  return { operations, legacy }
}

function commonCheckpoint(target, source, sameFamily) {
  if (!sameFamily) return undefined
  const sourceKeys = new Map(source.checkpoints.map(row => [row.key, row]))
  // Both traversals are oldest-to-newest on a single validated ancestry chain.
  // Select the latest exact shared branch/state checkpoint; equal numeric
  // revisions, names, or just equal current facts are never ancestry evidence.
  return target.checkpoints.findLast(row => sourceKeys.has(row.key))
}

function compareState(target, incoming, base, conflicts) {
  const tables = {}, targetRetired = new Set(target.retired.map(retiredKey)), incomingRetired = new Set(incoming.retired.map(retiredKey))
  for (const table of STORE_TABLES) {
    const before = new Map(target.world[table].map(row => [row.id, row])), imported = new Map(incoming.world[table].map(row => [row.id, row]))
    const original = new Map((base?.world[table] ?? []).map(row => [row.id, row]))
    const summary = { identical: [], incomingAdded: [], incomingChanged: [], targetOnly: [], targetChanged: [], bothChanged: [], incomingDeleted: [], targetDeleted: [] }
    for (const id of new Set([...before.keys(), ...imported.keys(), ...original.keys()])) {
      const current = before.get(id), row = imported.get(id), initial = original.get(id)
      const retired = retiredKey({ table, id })
      if (current && row && equal(current, row)) summary.identical.push(id)
      else if (base) {
        const localChanged = !equal(current, initial), foreignChanged = !equal(row, initial)
        if (localChanged && foreignChanged) summary.bothChanged.push(id)
        else if (foreignChanged) (initial ? summary.incomingChanged : summary.incomingAdded).push(id)
        else if (localChanged) summary.targetChanged.push(id)
      } else if (!current && row) summary.incomingAdded.push(id)
      else if (current && !row) summary.targetOnly.push(id)
      else if (current && row) summary.bothChanged.push(id)
      if (row && current && !equal(current, row) && (!base || (!equal(current, initial) && !equal(row, initial)))) {
        conflicts.push({ kind: 'record', table, id, currentDigest: digest(current), incomingDigest: digest(row), baseDigest: initial ? digest(initial) : null })
      }
      if (row && targetRetired.has(retired)) {
        summary.targetDeleted.push(id); conflicts.push({ kind: 'target-retired', table, id })
      }
      if (current && incomingRetired.has(retired)) {
        summary.incomingDeleted.push(id); conflicts.push({ kind: 'incoming-retired', table, id,
          targetChangedSinceBase: base ? !equal(current, initial) : null })
      }
    }
    tables[table] = summary
  }
  const targetEntries = new Map(target.world.entries.map(row => [jsonKey([row.entityId, row.layerId, row.source.sourceId, row.source.recordId]), row]))
  for (const row of incoming.world.entries) {
    const current = targetEntries.get(jsonKey([row.entityId, row.layerId, row.source.sourceId, row.source.recordId]))
    if (current && current.id !== row.id) conflicts.push({ kind: 'entry-source', currentId: current.id, incomingId: row.id })
  }
  const targetMappings = new Map(target.identities.identities.map(row => [identityKey(row), row]))
  const allocated = new Map(target.identities.identities.map(row => [row.id, row]))
  const identityAdditions = []
  const targetEntities = new Map(target.world.entities.map(row => [row.id, row])), entries = new Map(target.world.entries.map(row => [row.id, row]))
  for (const row of incoming.identities.identities) {
    const current = targetMappings.get(identityKey(row)), sameId = allocated.get(row.id)
    if (current && current.id !== row.id) conflicts.push({ kind: 'identity-record', current, incoming: row })
    if (sameId && identityKey(sameId) !== identityKey(row)) conflicts.push({ kind: 'identity-id', current: sameId, incoming: row })
    if (!current) identityAdditions.push(row)
    const actual = row.kind === 'entry' ? entries.get(row.id) : targetEntities.get(row.id)
    if ((row.kind === 'entry' ? targetEntities.has(row.id) : entries.has(row.id)) || (actual &&
      (actual.source.sourceId !== row.sourceId || actual.source.recordId !== row.recordId || (row.kind !== 'entry' && actual.typeId !== `bridge:${row.kind}`)))) conflicts.push({ kind: 'identity-target-row', id: row.id })
  }
  const currentProposals = new Map(target.proposals.map(row => [row.id, row]))
  const proposals = { identical: [], incomingAdded: [], changed: [], targetOnly: [] }, proposalIds = new Set(incoming.proposals.map(row => row.id))
  for (const row of incoming.proposals) {
    const current = currentProposals.get(row.id)
    if (!current) proposals.incomingAdded.push(row.id)
    else if (equal(current, row)) proposals.identical.push(row.id)
    else {
      proposals.changed.push(row.id)
      conflicts.push({ kind: current.status === 'accepted' && row.status !== 'accepted' ? 'accepted-proposal-regression' : 'proposal',
        id: row.id, currentStatus: current.status, incomingStatus: row.status, currentDigest: digest(current), incomingDigest: digest(row) })
    }
  }
  for (const row of target.proposals) if (!proposalIds.has(row.id)) proposals.targetOnly.push(row.id)
  const tombstones = { identical: [], incomingOnly: [], targetOnly: [] }
  for (const row of incoming.retired) (targetRetired.has(retiredKey(row)) ? tombstones.identical : tombstones.incomingOnly).push(row)
  for (const row of target.retired) if (!incomingRetired.has(retiredKey(row))) tombstones.targetOnly.push(row)
  return { tables, identityAdditions, proposals, tombstones }
}

export function previewRepositoryBranchHistory(targetInput, sourceInput, policy = {}) {
  validateJson(policy)
  policy = freezeCopy(policy)
  const target = readRepositoryArchive(targetInput, policy), source = readRepositoryArchive(sourceInput, policy)
  const targetRef = branchSourceReference(target), sourceRef = branchSourceReference(source)
  const conflicts = [], targetHistory = historyIndex(target), sourceHistory = historyIndex(source)
  const known = targetRef.identityStatus === 'known' && sourceRef.identityStatus === 'known'
  const sameFamily = known && targetRef.identity.libraryId === sourceRef.identity.libraryId
  if (known && !sameFamily) conflicts.push({ kind: 'library-family', current: targetRef.identity.libraryId, incoming: sourceRef.identity.libraryId })
  const history = compareHistory(targetHistory, sourceHistory, conflicts), common = commonCheckpoint(targetHistory, sourceHistory, sameFamily)
  const state = compareState(target.state, source.state, common?.state, conflicts)
  const classification = conflicts.length ? 'conflict' : targetRef.archiveDigest === sourceRef.archiveDigest ? 'identical-archive'
    : !known ? 'identity-insufficient' : !common ? 'ancestry-unproven' : 'review-required'
  const raw = { format: 'starmap.repository-branch-history-preview', formatVersion: 1, target: targetRef, source: sourceRef,
    policyDigest: digest(policy), classification, executable: false, commands: [], decisions: [],
    commonBase: common ? { identity: common.identity, repositoryRevision: common.repositoryRevision, stateDigest: common.stateDigest, historyDigest: common.historyDigest } : null,
    ...state, ...history, conflicts, missingIncomingRecordsAreDeletions: false, foreignReceiptsBecomeLocal: false,
    combinedStateValidated: false, confirmationRequirements: ['explicit-decisions', 'merged-state-validation', 'locked-freshness-check', 'atomic-import-archive-and-receipt'] }
  return freezeCopy({ ...raw, previewDigest: digest(raw) })
}

/** Whole-report equality only. No reservation for any future transaction. */
export function assertRepositoryBranchHistoryCurrent(report, target, source, policy = {}) {
  validateJson(report)
  const current = previewRepositoryBranchHistory(target, source, policy)
  if (!equal(report, current)) fail('E_BRANCH_HISTORY_PREVIEW_STALE')
  return current
}
