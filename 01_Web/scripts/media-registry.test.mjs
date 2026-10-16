/**
 * Scan against registry (3C-4c, ./media-registry.mjs): one test per row of the rule table (design v2 §3, review §8-1 to
 * §8-3, author decision 1), then the registry delta. Invented paths and contents; no file system.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyScan, pinsFor, registryDeltaOf, resolveClassification } from './media-registry.mjs'
import { pathKeyOf } from './store-media-registry.mjs'

const HARBOR = 'place-harbor', HILL = 'place-hill', RIVER = 'place-river'
const placeOfPath = (value) => (value.includes('/Hill Town/') ? HILL : value.includes('/River Town/') ? RIVER : HARBOR)
const cityFolderOf = (value) => value.split('/').slice(0, 3).join('/')
/** A scan fact of `path` with content `sha256` (its place from its folder unless given). */
const fact = (pathValue, sha256, { placeId = placeOfPath(pathValue), digest = `d-${placeId}` } = {}) => ({
  path: pathValue, pathKey: pathKeyOf(pathValue), sha256, placeId, descriptionDigest: digest, size: sha256.length, mtimeMs: 1,
  countryFolder: pathValue.split('/').slice(0, 2).join('/'), cityFolder: cityFolderOf(pathValue),
})
let seq = 0
/** A registry source. */
const source = (pathValue, sha256, recordId, state = 'present', digest = `d-${placeOfPath(pathValue)}`) => ({
  seq: ++seq, path: pathValue, pathKey: pathKeyOf(pathValue), sha256, recordId, state, descriptionDigest: digest,
})
const record = (recordId, sha256, placeId = HARBOR) => ({ recordId, assetId: `asset-${recordId}`, placeId, sha256 })
const P = (city, name) => `MediaInbox/Synthland/${city}/photos/${name}`
const classify = (input) => classifyScan({ records: [], explicit: new Set(), ...input })
const paths = (items) => items.map((item) => item.fact.path)
const settledIn = (classification) => ({
  unchanged: paths(classification.unchanged), reappeared: paths(classification.reappeared), newRecords: paths(classification.newRecords),
  moves: classification.moves.map((move) => [move.fact.path, move.recordId]), deletedSkips: paths(classification.deletedSkips),
  gone: classification.gone.map((item) => item.source.path), confirmations: classification.confirmations.map((group) => group.kinds.join('+')),
})
const NOTHING = { unchanged: [], reappeared: [], newRecords: [], moves: [], deletedSkips: [], gone: [], confirmations: [] }

test('R1 the same path with the same content: unchanged, nothing to write', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(s.path, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, unchanged: [s.path] })
  const decisions = resolveClassification(c)
  assert.deepEqual(registryDeltaOf(decisions, { created: new Map(), files: new Map(), registeredFiles: new Set(['A']), facts: [fact(s.path, 'A')],
    cache: [{ pathKey: s.pathKey, size: 1, mtimeMs: 1, sha256: 'A' }] }), { files: [], assetFiles: [], sources: [], scanCache: [] })
})

test('R2 a missing source found at its path again: present again', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'missing')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(s.path, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, reappeared: [s.path] })
})

test('R3 a file moved out of the Inbox or deleted there: its source is missing, the record stays', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [] })
  assert.deepEqual(settledIn(c), { ...NOTHING, gone: [s.path] })
  const d = resolveClassification(c)
  assert.deepEqual(registryDeltaOf(d, { created: new Map(), files: new Map(), registeredFiles: new Set(), facts: [] }).sources, [{ op: 'update', seq: s.seq, state: 'missing' }])
})

test('R4 a file replaced at its path with other content (author decision 1): a new record after confirmation; the old one stays, its source missing', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const f = fact(s.path, 'B')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [f] })
  assert.deepEqual(settledIn(c), { ...NOTHING, gone: [s.path], confirmations: ['replaced'] })
  assert.deepEqual(c.confirmations[0].entries.map((entry) => [entry.fact.path, entry.proposal.action, entry.replacing.map((item) => item.seq)]), [[s.path, 'new', [s.seq]]])
  assert.equal(resolveClassification(c).blocked, true, 'without confirmation nothing is written')
  const accepted = resolveClassification(c, { accept: true })
  assert.deepEqual(accepted.newRecords.map((item) => item.fact.path), [s.path])
  const delta = registryDeltaOf(accepted, { created: new Map([[f.pathKey, { assetId: 'a2', entityId: 'r2' }]]), files: new Map([['B', { extension: '.jpg', bytes: 1, outputs: [] }]]), registeredFiles: new Set(['A']), facts: [f] })
  assert.deepEqual(delta.sources.map((op) => [op.op, op.seq ?? op.recordId, op.state]), [['update', s.seq, 'missing'], ['add', 'r2', 'present']], 'the old source frees the path first')
})

test('R5 a file renamed in the Inbox, content unchanged: a move of the same source, no new record', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const moved = P('Harbor Town', 'a-renamed.jpg')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(moved, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, moves: [[moved, 'r1']], gone: [s.path] })
  const d = resolveClassification(c)
  assert.deepEqual(d.gone, [], 'a moved source is updated, not marked missing')
  assert.deepEqual(registryDeltaOf(d, { created: new Map(), files: new Map(), registeredFiles: new Set(), facts: [fact(moved, 'A')] }).sources,
    [{ op: 'update', seq: s.seq, path: moved, state: 'present' }])
})

test('R6 a folder renamed with its files: one move per file, each kept on its own record', () => {
  const sources = ['a', 'b', 'c'].map((name, i) => source(P('Harbor Town', `${name}.jpg`), `S${i}`, `r${i}`))
  const facts = ['a', 'b', 'c'].map((name, i) => fact(`MediaInbox/Synthland/Harbor Town renamed/photos/${name}.jpg`, `S${i}`, { placeId: HARBOR }))
  const c = classify({ sources, records: sources.map((s, i) => record(`r${i}`, `S${i}`)), facts })
  assert.deepEqual(c.moves.map((move) => [move.fact.path, move.anchor.source.seq]), facts.map((f, i) => [f.path, sources[i].seq]))
  assert.deepEqual([c.newRecords, c.confirmations], [[], []])
})

test('R7 a record with two sources of the same content (merged in V2) that both moved: two moves of that record', () => {
  const s1 = source(P('Harbor Town', 'a.jpg'), 'A', 'r1'), s2 = source(P('Hill Town', 'a.jpg'), 'A', 'r1')
  const n1 = 'MediaInbox/Synthland/Harbor Town/photos/x/a.jpg', n2 = 'MediaInbox/Synthland/Hill Town/photos/x/a.jpg'
  const c = classify({ sources: [s1, s2], records: [record('r1', 'A')], facts: [fact(n1, 'A'), fact(n2, 'A')] })
  assert.deepEqual(c.moves.map((move) => [move.fact.path, move.anchor.source.seq]), [[n1, s1.seq], [n2, s2.seq]], 'paired by city folder')
  assert.deepEqual([c.newRecords, c.confirmations], [[], []])
})

test('R8 content that a source missing since an earlier scan had, found at a new path: a move', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'missing')
  const back = P('Harbor Town', 'back.jpg')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(back, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, moves: [[back, 'r1']] })
})

test('R9 content of a record without any source (an orphan of the migration), found in the Inbox: the record gets that source', () => {
  const found = P('Harbor Town', 'a.jpg')
  const c = classify({ sources: [], records: [record('r1', 'A')], facts: [fact(found, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, moves: [[found, 'r1']] })
  const delta = registryDeltaOf(resolveClassification(c), { created: new Map(), files: new Map(), registeredFiles: new Set(['A']), facts: [fact(found, 'A')] })
  assert.deepEqual(delta.sources, [{ op: 'add', path: found, sha256: 'A', recordId: 'r1', state: 'present', descriptionDigest: `d-${HARBOR}` }])
})

test('R10 the same content on two records whose sources both moved: ambiguous, a proposal by file name, confirmation required', () => {
  const s1 = source(P('Harbor Town', 'one.jpg'), 'A', 'r1'), s2 = source(P('Harbor Town', 'two.jpg'), 'A', 'r2')
  const n2 = P('Hill Town', 'two.jpg'), n1 = P('Hill Town', 'one.jpg')
  const c = classify({ sources: [s1, s2], records: [record('r1', 'A'), record('r2', 'A')], facts: [fact(n1, 'A'), fact(n2, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, gone: [s1.path, s2.path], confirmations: ['ambiguous-move'] })
  assert.deepEqual(c.confirmations[0].entries.map((entry) => [entry.fact.path, entry.proposal.recordId]), [[n1, 'r1'], [n2, 'r2']])
  assert.equal(resolveClassification(c).blocked, true)
  const accepted = resolveClassification(c, { accept: true })
  assert.deepEqual(accepted.moves.map((move) => move.recordId), ['r1', 'r2'])
  assert.deepEqual(accepted.gone, [])
  // The proposal is deterministic.
  assert.deepEqual(classify({ sources: [s1, s2], records: [record('r1', 'A'), record('r2', 'A')], facts: [fact(n1, 'A'), fact(n2, 'A')] }), c)
})

test('R11 one source gone and its content at two new paths (a move and a copy): ambiguous; the same name is proposed as the move', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const copy = P('Harbor Town', 'b-copy.jpg'), moved = P('Hill Town', 'a.jpg')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(copy, 'A'), fact(moved, 'A')] })
  assert.deepEqual(c.confirmations.map((group) => group.entries.map((entry) => [entry.fact.path, entry.proposal.action])), [[[copy, 'new'], [moved, 'move']]])
  const accepted = resolveClassification(c, { accept: true })
  assert.deepEqual([accepted.moves.map((move) => move.fact.path), accepted.newRecords.map((item) => item.fact.path)], [[moved], [copy]])
})

test('R12 a new path with new content: a new record', () => {
  const f = fact(P('Harbor Town', 'new.jpg'), 'N')
  const c = classify({ sources: [], facts: [f] })
  assert.deepEqual(settledIn(c), { ...NOTHING, newRecords: [f.path] })
})

test('R13 the same content at two new paths (D2): two new records', () => {
  const f1 = fact(P('Harbor Town', 'x.jpg'), 'N'), f2 = fact(P('Hill Town', 'x.jpg'), 'N')
  const c = classify({ sources: [], facts: [f1, f2] })
  assert.deepEqual(settledIn(c), { ...NOTHING, newRecords: [f1.path, f2.path] })
  const decisions = resolveClassification(c)
  const created = new Map([[f1.pathKey, { assetId: 'a1', entityId: 'e1' }], [f2.pathKey, { assetId: 'a2', entityId: 'e2' }]])
  const delta = registryDeltaOf(decisions, { created, files: new Map([['N', { extension: '.jpg', bytes: 1, outputs: [] }]]), registeredFiles: new Set(), facts: [f1, f2] })
  assert.equal(delta.files.length, 1, 'one file for both records')
  assert.deepEqual(delta.assetFiles.map((link) => link.assetId), ['a1', 'a2'])
})

test('R14 a copy of a file whose source is still in place (D2): a new record, not a move', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const copy = P('Hill Town', 'a.jpg')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(s.path, 'A'), fact(copy, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, unchanged: [s.path], newRecords: [copy] })
})

test('R15 a deleted source’s file at its path with the same content (deletion paused, or put back): skipped, never imported again', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'deleted')
  const c = classify({ sources: [s], facts: [fact(s.path, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, deletedSkips: [s.path] })
})

test('R16 content a deleted source had, at a new path, with no other candidate (§8-1): confirmation, not a new record', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'deleted')
  const elsewhere = P('Hill Town', 'a.jpg')
  const c = classify({ sources: [s], facts: [fact(elsewhere, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, confirmations: ['deleted-content'] })
  assert.equal(resolveClassification(c).blocked, true)
  assert.deepEqual(resolveClassification(c, { accept: true }).newRecords.map((item) => item.fact.path), [elsewhere])
  // With a live anchor of that content, the anchor wins: a move, no confirmation.
  const missing = source(P('Harbor Town', 'b.jpg'), 'A', 'r2', 'missing')
  assert.deepEqual(settledIn(classify({ sources: [s, missing], records: [record('r2', 'A')], facts: [fact(elsewhere, 'A')] })).moves, [[elsewhere, 'r2']])
})

test('R17 an explicit addition is a new record even when a missing source had its content; the same content found by a scan is a move (§8-3)', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'missing')
  const uploaded = P('Harbor Town', 'a-1.jpg')
  const explicitScan = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(uploaded, 'A')], explicit: new Set([pathKeyOf(uploaded)]) })
  assert.deepEqual(settledIn(explicitScan), { ...NOTHING, newRecords: [uploaded] })
  assert.equal(explicitScan.newRecords[0].explicit, true)
  const plainScan = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(uploaded, 'A')] })
  assert.deepEqual(settledIn(plainScan), { ...NOTHING, moves: [[uploaded, 'r1']] })
})

test('R18 an explicit addition at the path of a deleted source (re-upload after a deletion): a new record, not skipped', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'deleted')
  const c = classify({ sources: [s], facts: [fact(s.path, 'A')], explicit: new Set([s.pathKey]) })
  assert.deepEqual(settledIn(c), { ...NOTHING, newRecords: [s.path] })
})

test('R19 an explicit file already registered at its path with the same content (a retry after an interruption): unchanged, never added twice', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(s.path, 'A')], explicit: new Set([s.pathKey]) })
  assert.deepEqual(settledIn(c), { ...NOTHING, unchanged: [s.path] })
})

test('R20 a file moved into another city’s folder (§8-2): a move, the record keeps its place, listed in crossCity', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const moved = P('Hill Town', 'a.jpg')
  const c = classify({ sources: [s], records: [record('r1', 'A', HARBOR)], facts: [fact(moved, 'A')] })
  assert.deepEqual(settledIn(c).moves, [[moved, 'r1']])
  assert.deepEqual(c.crossCity.map((item) => [item.fact.path, item.recordId, item.placeId, item.fact.placeId]), [[moved, 'r1', HARBOR, HILL]])
  assert.deepEqual(c.descriptionChanged, [], 'listed once, as a move into another city')
})

test('R21 a confirmed source whose sidecar description changed: listed, not applied (D1)', () => {
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(s.path, 'A', { digest: 'd-edited' })] })
  assert.deepEqual(settledIn(c), { ...NOTHING, unchanged: [s.path] })
  assert.deepEqual(c.descriptionChanged.map((item) => item.fact.path), [s.path])
})

test('R22 a path whose earlier content came back after a replacement: that source returns, the replacing one goes missing', () => {
  const old = source(P('Harbor Town', 'a.jpg'), 'A', 'r1', 'missing'), replacing = source(P('Harbor Town', 'a.jpg'), 'B', 'r2')
  const c = classify({ sources: [old, replacing], records: [record('r1', 'A'), record('r2', 'B')], facts: [fact(old.path, 'A')] })
  assert.deepEqual(settledIn(c), { ...NOTHING, reappeared: [old.path], gone: [old.path] })
  assert.deepEqual(c.gone.map((item) => item.source.seq), [replacing.seq])
  const delta = registryDeltaOf(resolveClassification(c), { created: new Map(), files: new Map(), registeredFiles: new Set(), facts: [fact(old.path, 'A')] })
  assert.deepEqual(delta.sources, [{ op: 'update', seq: replacing.seq, state: 'missing' }, { op: 'update', seq: old.seq, state: 'present' }])
})

test('R23 folder bindings: only a folder holding a file that becomes a new record needs confirming', () => {
  const pins = [{ folder: 'MediaInbox/Synthland/Hill Town', placeId: HILL }, { folder: 'MediaInbox/Synthland/Harbor Town', placeId: HARBOR }]
  const s = source(P('Harbor Town', 'a.jpg'), 'A', 'r1')
  const c = classify({ sources: [s], records: [record('r1', 'A')], facts: [fact(s.path, 'A'), fact(P('Hill Town', 'n.jpg'), 'N')] })
  assert.deepEqual(pinsFor(pins, resolveClassification(c).newRecords.map((item) => item.fact)).map((pin) => pin.folder), ['MediaInbox/Synthland/Hill Town'])
})

test('the registry delta: scan cache rows only for new or changed observations, removals for paths gone, one file row per new content', () => {
  const kept = fact(P('Harbor Town', 'a.jpg'), 'A'), changed = { ...fact(P('Harbor Town', 'b.jpg'), 'B'), mtimeMs: 2 }
  const cache = [
    { pathKey: kept.pathKey, size: kept.size, mtimeMs: 1, sha256: 'A' },
    { pathKey: changed.pathKey, size: changed.size, mtimeMs: 1, sha256: 'B' },
    { pathKey: pathKeyOf(P('Harbor Town', 'gone.jpg')), size: 1, mtimeMs: 1, sha256: 'G' },
  ]
  const delta = registryDeltaOf({ newRecords: [], moves: [], reappeared: [], gone: [] }, { created: new Map(), files: new Map(), registeredFiles: new Set(), facts: [kept, changed], cache })
  assert.deepEqual(delta.scanCache, [
    { op: 'put', path: changed.path, size: changed.size, mtimeMs: 2, sha256: 'B' },
    { op: 'remove', pathKey: pathKeyOf(P('Harbor Town', 'gone.jpg')) },
  ])
  assert.throws(() => registryDeltaOf({ newRecords: [{ fact: kept }], moves: [], reappeared: [], gone: [] }, { created: new Map(), files: new Map(), registeredFiles: new Set(), facts: [] }), /E_MEDIA_PLAN/)
})
