/** G3b read-only history intake. A verified snapshot is not a full edit log.
 * Host-supplied source labels bind exact package bytes, not authorship or trust.
 * No decisions, commands, permission authority or writable repository handle. */
import { createHash } from 'node:crypto'
import { verifyWorldRepositoryBackup } from './world-store-backup.mjs'
import { readRepositoryState, RepositoryError } from './world-store-repository.mjs'
import { freezeCopy, jsonKey, opaqueId, shape, STORE_TABLES, validateJson } from '../src/worldgraph/store/schema.ts'
import { identityKey, readBridgeManifest } from '../src/data/canonical/storeBridgeIdentity.ts'
import { planStoreMerge } from '../src/worldgraph/store/conflicts.ts'
import { applyStoreCommands } from '../src/worldgraph/store/commands.ts'

const hash = value => createHash('sha256').update(jsonKey(value)).digest('hex')
const fail = code => { throw new RepositoryError(code) }
function readBinding(value) {
  validateJson(value); shape(value, ['libraryId', 'backupSha256'])
  opaqueId(value.libraryId, 'history.libraryId')
  if (typeof value.backupSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.backupSha256)) fail('E_HISTORY_BINDING')
  return freezeCopy(value)
}
const tombstoneKey = row => jsonKey([row.table, row.id])

export function previewWorldHistoryImport(targetInput, backupDirectory, sourceBinding, options = {}) {
  const target = readRepositoryState(targetInput, options.policy), binding = readBinding(sourceBinding)
  const backup = verifyWorldRepositoryBackup(backupDirectory, { policy: options.policy })
  if (binding.backupSha256 !== backup.manifest.database.sha256) fail('E_HISTORY_SOURCE_CHANGED')
  const incoming = backup.state, conflicts = [], tables = {}, historyRequirements = []
  const requireHistory = (kind, count) => { if (count) historyRequirements.push({ kind, count }) }
  const targetRetired = new Set(target.retired.map(tombstoneKey))
  for (const table of STORE_TABLES) {
    const before = new Map(target.world[table].map(row => [row.id, row])), imported = new Set(incoming.world[table].map(row => row.id))
    const summary = { identical: [], added: [], changed: [], localOnly: [] }
    for (const row of incoming.world[table]) {
      const current = before.get(row.id)
      if (!current) summary.added.push(row.id)
      else if (jsonKey(current) === jsonKey(row)) summary.identical.push(row.id)
      else {
        summary.changed.push(row.id)
        conflicts.push({ kind: 'record', table, id: row.id, currentRevision: current.revision, incomingRevision: row.revision,
          currentSha256: hash(current), incomingSha256: hash(row) })
      }
      if (targetRetired.has(tombstoneKey({ table, id: row.id }))) conflicts.push({ kind: 'target-retired', table, id: row.id })
    }
    for (const row of target.world[table]) if (!imported.has(row.id)) summary.localOnly.push(row.id)
    tables[table] = summary
  }
  for (const row of incoming.retired) if (target.world[row.table].some(value => value.id === row.id)) conflicts.push({ kind: 'incoming-retired', ...row })
  const entryKey = row => jsonKey([row.entityId, row.layerId, row.source.sourceId, row.source.recordId])
  const targetEntries = new Map(target.world.entries.map(row => [entryKey(row), row]))
  for (const row of incoming.world.entries) {
    const existing = targetEntries.get(entryKey(row))
    if (existing && existing.id !== row.id) conflicts.push({ kind: 'entry-source', currentId: existing.id, incomingId: row.id })
  }

  const targetMappings = new Map(target.identities.identities.map(row => [identityKey(row), row]))
  const targetIds = new Map(target.identities.identities.map(row => [row.id, row]))
  const identityAdditions = []
  for (const row of incoming.identities.identities) {
    const byKey = targetMappings.get(identityKey(row)), byId = targetIds.get(row.id)
    if (byKey && byKey.id !== row.id) conflicts.push({ kind: 'identity-record', sourceId: row.sourceId, recordId: row.recordId, mappingKind: row.kind, currentId: byKey.id, incomingId: row.id })
    if (byId && identityKey(byId) !== identityKey(row)) conflicts.push({ kind: 'identity-id', id: row.id })
    if (!byKey) identityAdditions.push(row)
    const entity = target.world.entities.find(value => value.id === row.id), entry = target.world.entries.find(value => value.id === row.id)
    const actual = row.kind === 'entry' ? entry : entity
    if ((row.kind === 'entry' ? entity : entry) || (actual &&
      (actual.source.sourceId !== row.sourceId || actual.source.recordId !== row.recordId || (row.kind !== 'entry' && actual.typeId !== `bridge:${row.kind}`)))) {
      conflicts.push({ kind: 'identity-target-row', id: row.id })
    }
  }
  const existingProposals = new Map(target.proposals.map(row => [row.id, row]))
  const proposals = { identical: [], added: [], changed: [] }
  for (const row of incoming.proposals) {
    const current = existingProposals.get(row.id)
    if (!current) proposals.added.push(row.id)
    else if (jsonKey(current) === jsonKey(row)) proposals.identical.push(row.id)
    else { proposals.changed.push(row.id); conflicts.push({ kind: 'proposal', id: row.id, currentStatus: current.status, incomingStatus: row.status }) }
  }
  requireHistory('foreign-commit-receipts', incoming.revision)
  requireHistory('foreign-world-revision', incoming.world.revision)
  requireHistory('row-revisions', STORE_TABLES.reduce((n, table) => n + incoming.world[table].filter(row => row.revision > 0).length, 0))
  requireHistory('proposal-history', incoming.proposals.length)
  requireHistory('review-history', incoming.world.reviews.length)
  requireHistory('retired-history', incoming.retired.length)

  let ordinaryMergeCompatible = false
  if (!conflicts.length && !historyRequirements.length) {
    try {
      const plan = planStoreMerge(target.world, incoming.world, options.policy)
      if (plan.status === 'conflict') fail('E_HISTORY_MERGE_CONFLICT')
      const world = plan.commands.length ? applyStoreCommands(target.world, plan.commands, target.world.revision, { policy: options.policy }) : target.world
      const identities = readBridgeManifest({ ...target.identities, identities: [...target.identities.identities, ...identityAdditions] })
      readRepositoryState({ ...target, world, identities }, options.policy)
      ordinaryMergeCompatible = true
    } catch (error) { conflicts.push({ kind: 'merged-state', code: error?.code ?? 'E_HISTORY_MERGED_STATE' }) }
  }
  const additions = STORE_TABLES.reduce((n, table) => n + tables[table].added.length, 0) + identityAdditions.length
  const targetBinding = { repositoryRevision: target.revision, worldRevision: target.world.revision, stateSha256: hash(target) }
  const provenance = { ...binding, repositoryRevision: incoming.revision, worldRevision: incoming.world.revision,
    stateSha256: hash(incoming), foreignReceiptCount: incoming.revision, foreignReceiptsLocation: 'verified-backup-package',
    receiptNamespace: [binding.libraryId, binding.backupSha256], evidenceKind: 'validated-current-snapshot', fullEditHistoryAvailable: false }
  const classification = conflicts.length ? 'conflict' : historyRequirements.length ? 'history-required' : additions ? 'fresh-only' : 'identical'
  return freezeCopy({ format: 'starmap.world-history-preview', formatVersion: 1, previewId: hash({ target: targetBinding, source: provenance }),
    classification, executable: false, commands: [], ordinaryMergeCompatible, target: targetBinding, source: provenance,
    tables, proposals, identityAdditions: identityAdditions.map(row => ({ ...row })), conflicts, historyRequirements,
    missingIncomingRecordsAreDeletions: false })
}

/** Recheck an entire report, not just its numeric target version. This is only
 * preview freshness; it cannot reserve a transaction for a later writer. */
export function assertWorldHistoryPreviewCurrent(report, targetInput, backupDirectory, sourceBinding, options = {}) {
  validateJson(report)
  const current = previewWorldHistoryImport(targetInput, backupDirectory, sourceBinding, options)
  if (jsonKey(report) !== jsonKey(current)) fail('E_HISTORY_PREVIEW_STALE')
  return current
}
