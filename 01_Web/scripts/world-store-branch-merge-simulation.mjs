/** Pure hypothetical single local transaction. Does not allocate, persist,
 * reserve a lock or issue Commands/receipts. Host authorization is still absent. */
import { freezeCopy, jsonKey, STORE_TABLES, StoreError, validateJson } from '../src/worldgraph/store/schema.ts'
import { identityKey } from '../src/data/canonical/storeBridgeIdentity.ts'
import { readRepositoryState, RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { assertRepositoryBranchMergePlanCurrent } from './world-store-branch-merge-plan.mjs'

const equal = (a, b) => a === undefined || b === undefined ? a === b : jsonKey(a) === jsonKey(b)
const content = row => { const value = { ...row }; delete value.revision; return value }

export function simulateRepositoryBranchMerge(plan, report, targetInput, sourceInput, policy = {}) {
  const current = assertRepositoryBranchMergePlanCurrent(plan, report, targetInput, sourceInput, policy)
  const target = readRepositoryArchive(targetInput, policy).state, source = readRepositoryArchive(sourceInput, policy).state
  return simulateValidatedRepositoryBranchMerge(current, target, source, policy)
}

/** Pure combination kernel; no claimed caller validation is persisted. */
export function simulateValidatedRepositoryBranchMerge(current, target, source, policy = {}) {
  const candidate = structuredClone(target), decisions = new Map(current.decisions.map(row => [row.itemId, row.choice]))
  const retired = new Map(candidate.retired.map(row => [jsonKey([row.table, row.id]), row]))
  const rows = new Map(STORE_TABLES.map(table => [table, new Map(candidate.world[table].map(row => [row.id, row]))]))
  const sourceRows = new Map(STORE_TABLES.map(table => [table, new Map(source.world[table].map(row => [row.id, row]))]))
  const identities = new Map(candidate.identities.identities.map(row => [identityKey(row), row]))
  const sourceIdentities = new Map(source.identities.identities.map(row => [identityKey(row), row]))
  const proposals = new Map(candidate.proposals.map(row => [row.id, row])), sourceProposals = new Map(source.proposals.map(row => [row.id, row]))
  const adopted = []
  const archiveItem = current.items.find(row => row.domain === 'archive')
  const archiveSelection = archiveItem ? decisions.get(archiveItem.itemId) : 'identical'
  for (const item of current.items) {
    if (decisions.get(item.itemId) !== 'source') continue
    adopted.push(item.itemId)
    if (item.domain === 'record') {
      const index = rows.get(item.table), incoming = sourceRows.get(item.table).get(item.id), previous = index.get(item.id)
      if (incoming) {
        // Foreign row revisions are not local clocks. Only model an ordinary
        // create/update step, preserving all source fields and canonical IDs.
        index.set(item.id, { ...structuredClone(incoming), revision: previous
          ? equal(content(previous), content(incoming)) ? previous.revision : previous.revision + 1 : 0 })
      } else index.delete(item.id)
      if (item.source.retired) retired.set(jsonKey([item.table, item.id]), { table: item.table, id: item.id })
    } else if (item.domain === 'identity') identities.set(item.key, structuredClone(sourceIdentities.get(item.key)))
    else if (item.domain === 'proposal') proposals.set(item.id, structuredClone(sourceProposals.get(item.id)))
  }
  for (const table of STORE_TABLES) candidate.world[table] = [...rows.get(table).values()]
  candidate.identities.identities = [...identities.values()]
  candidate.proposals = [...proposals.values()]; candidate.retired = [...retired.values()]
  const worldChanged = !equal(candidate.world, target.world)
  if (worldChanged) candidate.world.revision = target.world.revision + 1
  if (!equal(candidate, target) || archiveSelection === 'source') candidate.revision = target.revision + 1
  let stateValidation, validated = null
  try {
    validated = readRepositoryState(candidate, policy)
    stateValidation = { valid: true, code: null, path: null }
  } catch (error) {
    if (!(error instanceof StoreError || error instanceof RepositoryError)) throw error
    stateValidation = { valid: false, code: error.code, path: error instanceof StoreError ? error.path : null }
  }
  if (archiveSelection === 'target' && adopted.some(itemId => itemId !== archiveItem.itemId)) {
    stateValidation = { valid: false, code: 'E_BRANCH_MERGE_ARCHIVE_REQUIRED', path: null }; validated = null
  }
  const complete = current.status === 'decided' && stateValidation.valid
  const raw = { format: 'starmap.repository-branch-merge-simulation', formatVersion: 1,
    planDigest: current.planDigest, previewDigest: current.previewDigest,
    target: current.target, source: current.source, policyDigest: current.policyDigest,
    status: current.status === 'blocked' ? 'blocked' : !stateValidation.valid ? 'invalid' : current.pending.length ? 'incomplete' : 'validated',
    stateValidation, combinedStateValidated: complete, decisionsComplete: current.decisionsComplete,
    pending: current.pending, blockingConflicts: current.blockingConflicts, blockingReasons: current.blockingReasons,
    candidate: validated, candidateDigest: validated ? digest(validated) : null, adopted, archiveSelection,
    revisionModel: 'hypothetical-local-single-step', persisted: false, executable: false, commands: [],
    foreignReceiptsBecomeLocal: false, newLocalApprovalIssued: false,
    confirmationRequirements: ['host-authorization', 'locked-freshness-check', 'atomic-import-archive-and-receipt'] }
  return freezeCopy({ ...raw, simulationDigest: digest(raw) })
}

/** No reservation: a future host must recheck under its own write lock. */
export function assertRepositoryBranchMergeSimulationCurrent(value, plan, report, target, source, policy = {}) {
  validateJson(value)
  const current = simulateRepositoryBranchMerge(plan, report, target, source, policy)
  if (!equal(value, current)) throw new RepositoryError('E_BRANCH_MERGE_SIMULATION_STALE')
  return current
}
