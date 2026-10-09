/** Experimental pure decisions. No authority, IO, IDs, Commands or receipts. */
import { freezeCopy, jsonKey, shape, STORE_TABLES, validateJson } from '../src/worldgraph/store/schema.ts'
import { identityKey } from '../src/data/canonical/storeBridgeIdentity.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { assertRepositoryBranchHistoryCurrent } from './world-store-branch-history-preview.mjs'

const equal = (a, b) => a === undefined || b === undefined ? a === b : jsonKey(a) === jsonKey(b)
const fail = code => { throw new RepositoryError(code) }
const summary = (row, retired = false) => ({ rowDigest: row === undefined ? null : digest(row), retired })
const content = row => { const value = { ...row }; delete value.revision; return value }
function immutableRecordReason(table, current, incoming) {
  if (!current || !incoming) return null
  if (['sources', 'evidence', 'reviews', 'entityTypes', 'layers', 'relationTypes'].includes(table)
    && !equal(content(current), content(incoming))) return 'existing-definition-is-immutable'
  if (current.source && (!incoming.source || current.source.sourceId !== incoming.source.sourceId || current.source.recordId !== incoming.source.recordId)) return 'canonical-identity-is-permanent'
  if (table === 'entities' && current.typeId !== incoming.typeId) return 'canonical-identity-is-permanent'
  if (table === 'entries' && (current.entityId !== incoming.entityId || current.layerId !== incoming.layerId || current.createdAt !== incoming.createdAt)) return 'canonical-identity-is-permanent'
  if (table === 'entries' && Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt)) return 'entry-time-cannot-regress'
  return null
}

/** Catalogue IDs are report-scoped fingerprints, never allocated record IDs. */
function catalogue(report, target, source) {
  const items = [], targetRetired = new Set(target.retired.map(row => jsonKey([row.table, row.id])))
  const sourceRetired = new Set(source.retired.map(row => jsonKey([row.table, row.id])))
  const add = (address, current, incoming, blockedReason = null) => {
    if (equal(current, incoming)) return
    items.push({ itemId: digest([report.previewDigest, address]), ...address, target: current, source: incoming,
      allowedChoices: blockedReason ? ['target', 'defer'] : ['target', 'source', 'defer'], sourceBlockedReason: blockedReason })
  }
  for (const table of STORE_TABLES) {
    const current = new Map(target.world[table].map(row => [row.id, row])), incoming = new Map(source.world[table].map(row => [row.id, row]))
    const retiredIds = [...target.retired, ...source.retired].filter(row => row.table === table).map(row => row.id)
    for (const id of [...new Set([...current.keys(), ...incoming.keys(), ...retiredIds])].sort()) {
      const key = jsonKey([table, id]), a = current.get(id), b = incoming.get(id)
      const retired = targetRetired.has(key), foreignRetired = sourceRetired.has(key)
      const reason = retired && !foreignRetired ? 'target-tombstone-is-permanent'
        : !b && !foreignRetired && (a || retired) ? 'source-absence-is-not-deletion'
          : table === 'reviews' && a && !equal(a, b) ? 'local-review-is-immutable' : immutableRecordReason(table, a, b)
      add({ domain: 'record', table, id }, summary(a, retired), summary(b, foreignRetired), reason)
    }
  }
  const currentMappings = new Map(target.identities.identities.map(row => [identityKey(row), row]))
  const incomingMappings = new Map(source.identities.identities.map(row => [identityKey(row), row]))
  const allocated = new Set(target.identities.identities.map(row => row.id))
  for (const key of [...new Set([...currentMappings.keys(), ...incomingMappings.keys()])].sort()) {
    const a = currentMappings.get(key), b = incomingMappings.get(key)
    add({ domain: 'identity', key }, summary(a), summary(b), a || (b && allocated.has(b.id)) ? 'allocated-identity-is-permanent' : null)
  }
  const currentProposals = new Map(target.proposals.map(row => [row.id, row])), incomingProposals = new Map(source.proposals.map(row => [row.id, row]))
  for (const id of [...new Set([...currentProposals.keys(), ...incomingProposals.keys()])].sort()) {
    const a = currentProposals.get(id), b = incomingProposals.get(id)
    add({ domain: 'proposal', id }, summary(a), summary(b), !b && a ? 'source-absence-is-not-deletion'
      : a?.status === 'accepted' && !equal(a, b) ? 'accepted-proposal-is-permanent'
        : a?.status === 'rejected' && !equal(a, b) ? 'rejected-proposal-is-permanent' : null)
  }
  if (report.target.archiveDigest !== report.source.archiveDigest) {
    add({ domain: 'archive', key: 'incoming-history' }, { rowDigest: report.target.archiveDigest, retired: false },
      { rowDigest: report.source.archiveDigest, retired: false })
  }
  return items
}

export function createRepositoryBranchMergePlan(report, targetInput, sourceInput, choices = [], policy = {}) {
  validateJson(choices); validateJson(policy)
  if (!Array.isArray(choices)) fail('E_BRANCH_MERGE_CHOICES')
  const preview = assertRepositoryBranchHistoryCurrent(report, targetInput, sourceInput, policy)
  const target = readRepositoryArchive(targetInput, policy), source = readRepositoryArchive(sourceInput, policy)
  return planValidatedRepositoryBranchMerge(preview, target.state, source.state, choices)
}

/** Pure kernel; callers must replay archives and reconstruct the full preview. */
export function planValidatedRepositoryBranchMerge(preview, targetState, sourceState, choices = []) {
  validateJson(choices)
  if (!Array.isArray(choices)) fail('E_BRANCH_MERGE_CHOICES')
  const items = catalogue(preview, targetState, sourceState), byId = new Map(items.map(row => [row.itemId, row]))
  const selected = new Map()
  for (const row of choices) {
    shape(row, ['itemId', 'choice'])
    const item = byId.get(row.itemId)
    if (!item || selected.has(row.itemId)) fail('E_BRANCH_MERGE_CHOICE_ID')
    if (!item.allowedChoices.includes(row.choice)) fail('E_BRANCH_MERGE_CHOICE_FORBIDDEN')
    selected.set(row.itemId, row.choice)
  }
  const decisions = items.map(item => ({ itemId: item.itemId, choice: selected.get(item.itemId) ?? 'defer', explicit: selected.has(item.itemId) }))
  const blockingConflicts = preview.conflicts.filter(row => ['operation-identity', 'branch-genesis', 'branch-origin', 'library-family',
    'identity-record', 'identity-id', 'identity-target-row', 'ambiguous-common-history'].includes(row.kind))
  const identical = preview.target.archiveDigest === preview.source.archiveDigest
  const blockingReasons = !identical && !preview.commonBase ? ['unproven-common-history'] : []
  const pending = decisions.filter(row => row.choice === 'defer').map(row => row.itemId)
  const raw = { format: 'starmap.repository-branch-merge-plan', formatVersion: 1,
    previewDigest: preview.previewDigest, target: preview.target, source: preview.source, policyDigest: preview.policyDigest,
    items, decisions, pending, blockingConflicts, blockingReasons,
    decisionsComplete: pending.length === 0, executable: false, commands: [],
    combinedStateValidated: false, foreignReceiptsBecomeLocal: false,
    status: blockingConflicts.length || blockingReasons.length ? 'blocked' : pending.length ? 'incomplete' : 'decided' }
  return freezeCopy({ ...raw, planDigest: digest(raw) })
}

/** Recompute the whole plan; fingerprints are consistency checks, not signatures. */
export function assertRepositoryBranchMergePlanCurrent(plan, report, target, source, policy = {}) {
  validateJson(plan)
  shape(plan, ['format', 'formatVersion', 'previewDigest', 'target', 'source', 'policyDigest', 'items', 'decisions', 'pending', 'blockingConflicts', 'blockingReasons', 'decisionsComplete', 'executable', 'commands', 'combinedStateValidated', 'foreignReceiptsBecomeLocal', 'status', 'planDigest'])
  if (!Array.isArray(plan.decisions)) fail('E_BRANCH_MERGE_PLAN_STALE')
  for (const row of plan.decisions) shape(row, ['itemId', 'choice', 'explicit'])
  const choices = plan.decisions.filter(row => row.explicit).map(row => ({ itemId: row.itemId, choice: row.choice }))
  const current = createRepositoryBranchMergePlan(report, target, source, choices, policy)
  if (!equal(plan, current)) fail('E_BRANCH_MERGE_PLAN_STALE')
  return current
}
