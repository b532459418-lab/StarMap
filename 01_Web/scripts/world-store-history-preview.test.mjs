import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorldRepository } from './world-store-repository.mjs'
import { backupWorldRepository } from './world-store-backup.mjs'
import { previewWorldHistoryImport, assertWorldHistoryPreviewCurrent } from './world-store-history-preview.mjs'
import { fixture as frozenFixture, entry, id, seed, createRequest, stageRequest, acceptRequest } from './world-store-repository.fixture.mjs'

const code = wanted => error => error.code === wanted
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = () => structuredClone(frozenFixture())
function setup(t, incomingSeed = seed(), targetSeed = seed()) {
  const base = path.resolve(tmpdir()), root = mkdtempSync(path.join(base, 'starmap-history-synthetic-'))
  const targetFile = path.join(root, 'target.sqlite'), sourceFile = path.join(root, 'source.sqlite')
  const target = createWorldRepository(targetFile, targetSeed), source = createWorldRepository(sourceFile, incomingSeed)
  t.after(() => {
    target.close(); source.close()
    assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-history-synthetic-'))
    rmSync(root, { recursive: true, force: true })
  })
  function backup(name = 'incoming', libraryId = 'synthetic:source') {
    const directory = path.join(root, name), result = backupWorldRepository(sourceFile, directory)
    return { directory, binding: { libraryId, backupSha256: result.manifest.database.sha256 } }
  }
  function preview(packageInfo) { return previewWorldHistoryImport(target.snapshot(), packageInfo.directory, packageInfo.binding) }
  return { root, targetFile, sourceFile, target, source, backup, preview }
}
const addMapping = (idValue, recordId, kind = 'entry') => ({ world: fixture(), identities: { format: 'starmap.v2-store-identities', version: 1, identities: [{ kind, sourceId: 'test:manual', recordId, id: idValue }] } })

test('identical snapshot reports no writes, commands or deletions and returns immutable detached results', t => {
  const p = setup(t), packet = p.backup(), before = p.target.snapshot(), fileHashes = [p.targetFile, p.sourceFile, path.join(packet.directory, 'world.sqlite')].map(file => digest(readFileSync(file)))
  const result = p.preview(packet)
  assert.equal(result.classification, 'identical'); assert.equal(result.executable, false); assert.deepEqual(result.commands, []); assert.equal(result.missingIncomingRecordsAreDeletions, false)
  assert.equal(result.ordinaryMergeCompatible, true); assert.ok(Object.isFrozen(result.tables.entries.identical)); assert.ok(Object.isFrozen(result.source.receiptNamespace))
  assert.deepEqual(p.target.snapshot(), before); assert.deepEqual([p.targetFile, p.sourceFile, path.join(packet.directory, 'world.sqlite')].map(file => digest(readFileSync(file))), fileHashes)
  assert.deepEqual(readdirSync(packet.directory).sort(), ['complete.json', 'world.sqlite'])
})
test('new revision-zero records can be classified for ordinary merge while preview never executes it', t => {
  const world = fixture(); world.entries = [...world.entries, entry(70)]
  const p = setup(t, { world }), result = p.preview(p.backup())
  assert.equal(result.classification, 'fresh-only'); assert.equal(result.ordinaryMergeCompatible, true); assert.deepEqual(result.tables.entries.added, [id(70)]); assert.equal(p.target.snapshot().world.entries.length, 3)
})
test('missing source records remain local-only and are never inferred as deletion', t => {
  const targetWorld = fixture(); targetWorld.entries = [...targetWorld.entries, entry(70)]
  const p = setup(t, seed(), { world: targetWorld }), result = p.preview(p.backup())
  assert.equal(result.classification, 'identical'); assert.deepEqual(result.tables.entries.localOnly, [id(70)]); assert.equal(result.missingIncomingRecordsAreDeletions, false); assert.equal(p.target.snapshot().world.entries.length, 4)
})
for (const revision of [0, 4]) test(`same ID different content/revision (${revision}) reports conflict without choosing a winner`, t => {
  const world = fixture(); world.entries = world.entries.map(row => row.id === id(10) ? { ...row, revision, fields: { ...row.fields, note: 'Synthetic changed content' } } : row)
  world.revision = revision
  const p = setup(t, { world }), result = p.preview(p.backup()), conflict = result.conflicts.find(row => row.kind === 'record' && row.id === id(10))
  assert.equal(result.classification, 'conflict'); assert.equal(conflict.currentRevision, 0); assert.equal(conflict.incomingRevision, revision); assert.equal(result.ordinaryMergeCompatible, false); assert.deepEqual(result.commands, [])
  assert.ok(!JSON.stringify(result).includes('Synthetic changed content'))
})
test('same content with only a revision difference is still a conflict', t => {
  const world = fixture(); world.entries = world.entries.map(row => ({ ...row, revision: 2 })); world.revision = 2
  const p = setup(t, { world }), result = p.preview(p.backup())
  assert.equal(result.tables.entries.changed.length, 3); assert.equal(result.classification, 'conflict')
})
test('new row with nonzero revision is preserved in the source and requires history intake', t => {
  const world = fixture(); world.entries = [...world.entries, { ...entry(70), revision: 4 }]; world.revision = 4
  const p = setup(t, { world }), result = p.preview(p.backup())
  assert.equal(result.classification, 'history-required'); assert.ok(result.historyRequirements.some(row => row.kind === 'row-revisions' && row.count === 1))
  assert.equal(p.source.snapshot().world.entries.find(row => row.id === id(70)).revision, 4); assert.equal(p.target.snapshot().revision, 0)
})
test('accepted foreign candidate/review/commit receipts are reported without being locally accepted again', t => {
  const p = setup(t); p.source.apply(stageRequest()); p.source.apply(acceptRequest())
  const result = p.preview(p.backup()), target = p.target.snapshot()
  assert.equal(result.classification, 'history-required'); assert.deepEqual(result.proposals.added, ['synthetic-proposal'])
  for (const kind of ['foreign-commit-receipts', 'foreign-world-revision', 'proposal-history', 'review-history']) assert.ok(result.historyRequirements.some(row => row.kind === kind))
  assert.equal(result.source.foreignReceiptCount, 2); assert.equal(result.source.foreignReceiptsLocation, 'verified-backup-package'); assert.equal(result.source.fullEditHistoryAvailable, false)
  assert.equal(target.world.reviews.length, 0); assert.equal(target.proposals.length, 0); assert.equal(p.target.findOperation('accept'), undefined)
})
for (const status of ['pending', 'rejected']) test(`foreign ${status} candidate stays outside target facts`, t => {
  const p = setup(t); p.source.apply(stageRequest())
  if (status === 'rejected') p.source.apply({ id: 'reject', expectedRevision: 1, action: { kind: 'reject-proposal', proposalId: 'synthetic-proposal' } })
  const result = p.preview(p.backup())
  assert.equal(result.classification, 'history-required'); assert.equal(p.target.snapshot().world.entries.length, 3); assert.deepEqual(result.tables.reviews.added, [])
})
test('same proposal ID with different status reports an explicit conflict', t => {
  const p = setup(t); p.target.apply(stageRequest()); p.source.apply(stageRequest()); p.source.apply(acceptRequest())
  const result = p.preview(p.backup()), conflict = result.conflicts.find(row => row.kind === 'proposal')
  assert.equal(conflict.currentStatus, 'pending'); assert.equal(conflict.incomingStatus, 'accepted'); assert.equal(result.classification, 'conflict')
})
test('source-record identity mapped to another UUID is never remapped automatically', t => {
  const p = setup(t, addMapping(id(61), 'tombstone'), addMapping(id(60), 'tombstone')), result = p.preview(p.backup())
  assert.equal(result.classification, 'conflict'); assert.ok(result.conflicts.some(row => row.kind === 'identity-record')); assert.deepEqual(result.commands, [])
})
test('one UUID mapped to another source record is an identity conflict', t => {
  const p = setup(t, addMapping(id(60), 'second'), addMapping(id(60), 'first')), result = p.preview(p.backup())
  assert.ok(result.conflicts.some(row => row.kind === 'identity-id')); assert.equal(result.classification, 'conflict')
})
test('incoming unused identity cannot steal a live target entity ID', t => {
  const world = fixture(); world.entities = [...world.entities, { ...world.entities[0], id: id(60), source: { sourceId: 'test:manual', recordId: 'entity-60', evidenceIds: [] } }]
  const p = setup(t, addMapping(id(60), 'unused-entry'), { world }), result = p.preview(p.backup())
  assert.ok(result.conflicts.some(row => row.kind === 'identity-target-row')); assert.equal(result.classification, 'conflict')
})
test('new nonconflicting ledger tombstone is counted and remains separate from facts', t => {
  const p = setup(t, addMapping(id(60), 'unused-entry')), result = p.preview(p.backup())
  assert.equal(result.classification, 'fresh-only'); assert.equal(result.identityAdditions.length, 1); assert.equal(result.tables.entries.added.length, 0); assert.equal(p.target.snapshot().identities.identities.length, 0)
})
test('target retired ID blocks incoming live record even when ordinary row comparison shows an addition', t => {
  const world = fixture(); world.entries = [...world.entries, entry(60)]
  const p = setup(t, { world }); p.target.apply({ ...createRequest(), identities: [] }); p.target.apply({ id: 'delete', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
  const result = p.preview(p.backup()); assert.ok(result.conflicts.some(row => row.kind === 'target-retired')); assert.equal(result.classification, 'conflict')
})
test('incoming retired ID does not silently remove a live target record', t => {
  const p = setup(t); p.target.apply(createRequest()); p.source.apply(createRequest()); p.source.apply({ id: 'delete', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
  const result = p.preview(p.backup()); assert.ok(result.conflicts.some(row => row.kind === 'incoming-retired')); assert.equal(p.target.snapshot().world.entries.length, 4)
})
test('retired foreign history absent from target requires preservation rather than discard', t => {
  const p = setup(t); p.source.apply(createRequest()); p.source.apply({ id: 'delete', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
  const result = p.preview(p.backup()); assert.equal(result.classification, 'history-required'); assert.ok(result.historyRequirements.some(row => row.kind === 'retired-history')); assert.equal(p.target.snapshot().retired.length, 0)
})
test('equal facts from a foreign committed repository still require receipt provenance', t => {
  const p = setup(t); p.target.apply(createRequest()); p.source.apply(createRequest())
  const result = p.preview(p.backup()); assert.equal(result.tables.entries.changed.length, 0); assert.equal(result.tables.entries.added.length, 0)
  assert.equal(result.classification, 'history-required'); assert.equal(result.source.foreignReceiptCount, 1); assert.equal(p.target.snapshot().revision, 1)
})
test('same operation IDs in two source libraries remain in distinct provenance namespaces', t => {
  const p = setup(t); p.source.apply(createRequest()); const a = p.backup('a', 'library:a'), b = { ...a, binding: { ...a.binding, libraryId: 'library:b' } }
  const first = p.preview(a), second = p.preview(b)
  assert.notDeepEqual(first.source.receiptNamespace, second.source.receiptNamespace); assert.notEqual(first.previewId, second.previewId); assert.equal(p.target.findOperation('create'), undefined)
})
test('preview binds exact backup bytes; changed host source association is rejected', t => {
  const p = setup(t), packet = p.backup()
  assert.throws(() => previewWorldHistoryImport(p.target.snapshot(), packet.directory, { ...packet.binding, backupSha256: '0'.repeat(64) }), code('E_HISTORY_SOURCE_CHANGED'))
})
test('target changes and report tampering require a new preview', t => {
  const p = setup(t), packet = p.backup(), result = p.preview(packet)
  assert.deepEqual(assertWorldHistoryPreviewCurrent(result, p.target.snapshot(), packet.directory, packet.binding), result)
  assert.throws(() => assertWorldHistoryPreviewCurrent({ ...result, executable: true }, p.target.snapshot(), packet.directory, packet.binding), code('E_HISTORY_PREVIEW_STALE'))
  p.target.apply(createRequest()); assert.throws(() => assertWorldHistoryPreviewCurrent(result, p.target.snapshot(), packet.directory, packet.binding), code('E_HISTORY_PREVIEW_STALE'))
})
test('same numeric target version with another state hash also invalidates preview', t => {
  const p = setup(t), packet = p.backup(), result = p.preview(packet), other = structuredClone(p.target.snapshot())
  other.world.entries[0].fields.note = 'Synthetic alternate branch'
  assert.throws(() => assertWorldHistoryPreviewCurrent(result, other, packet.directory, packet.binding), code('E_HISTORY_PREVIEW_STALE'))
})
test('current backup corruption is refused during preview freshness check', t => {
  const p = setup(t), packet = p.backup(), result = p.preview(packet)
  writeFileSync(path.join(packet.directory, 'complete.json'), '{')
  assert.throws(() => assertWorldHistoryPreviewCurrent(result, p.target.snapshot(), packet.directory, packet.binding), code('E_BACKUP_MANIFEST'))
})
test('unknown fields and getter-bearing provenance are rejected without executing getters', t => {
  const p = setup(t), packet = p.backup(); let calls = 0
  const binding = { backupSha256: packet.binding.backupSha256, get libraryId() { calls++; return 'unsafe' } }
  assert.throws(() => previewWorldHistoryImport(p.target.snapshot(), packet.directory, binding), code('E_JSON')); assert.equal(calls, 0)
  assert.throws(() => previewWorldHistoryImport(p.target.snapshot(), packet.directory, { ...packet.binding, authorized: true }), code('E_SHAPE'))
})
for (const revision of [0, 3]) test(`different entry IDs for the same scoped source record conflict even with revision ${revision}`, t => {
  const world = fixture(); world.entries = world.entries.filter(row => row.id !== id(10)); world.entries.push({ ...entry(70), source: { sourceId: 'test:manual', recordId: 'record-10', evidenceIds: [] }, revision })
  world.sequences = []; world.viewStates = []; world.revision = revision
  const p = setup(t, { world }), result = p.preview(p.backup())
  assert.equal(result.classification, 'conflict'); assert.ok(result.conflicts.some(row => row.kind === 'entry-source' && row.currentId === id(10) && row.incomingId === id(70)))
})
test('re-associating the same package with another host library label invalidates the report', t => {
  const p = setup(t), packet = p.backup(), result = p.preview(packet)
  assert.throws(() => assertWorldHistoryPreviewCurrent(result, p.target.snapshot(), packet.directory, { ...packet.binding, libraryId: 'synthetic:other-library' }), code('E_HISTORY_PREVIEW_STALE'))
})
test('JSON object key order does not change a semantic target binding', t => {
  const p = setup(t), packet = p.backup(), result = p.preview(packet), state = p.target.snapshot()
  const reordered = Object.fromEntries(Object.entries(state).reverse())
  assert.deepEqual(assertWorldHistoryPreviewCurrent(result, reordered, packet.directory, packet.binding), result)
})
