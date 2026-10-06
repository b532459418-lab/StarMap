/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBaseline } from '../derive/baseline.ts'
import { deriveTimeQueryContext } from '../derive/timeQueryContext.ts'
import { queryCollection } from '../../worldgraph/collection.ts'
import { queryOriginalAdjacency, queryStoreLayer } from '../../worldgraph/store/query.ts'
import { resolveName } from '../../worldgraph/localizedText.ts'
import { classifyStoredDates } from '../../worldgraph/store/query.ts'
import { bridgeV2, BRIDGE, bridgeRowId } from './storeBridge.ts'
import { identityKey, readBridgeManifest } from './storeBridgeIdentity.ts'
import { projectBridgeCompatibility, projectBridgeOriginalRoutes, restoreBridgeV2 } from './storeBridgeProjection.ts'
import { BRIDGE_NOW, publicBridgeFixture, syntheticBridgeFixture } from './storeBridge.fixture.ts'
import { sequentialUuids } from './v2.fixture.ts'
import { readV2 } from './v2Reader.ts'
import { validateV2Files, type V2Files } from './v2Schema.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { officialLayers } from '../../worldgraph/layers.ts'

const bridge = (files: V2Files) => bridgeV2(files, { now: BRIDGE_NOW, allocateId: sequentialUuids() })
const entry = (doc: ReturnType<typeof bridge>, sourceId: string, recordId: string) => doc.store.entries.find(e => e.source.sourceId === sourceId && e.source.recordId === recordId)!
for (const [name, fixture] of [['public', publicBridgeFixture], ['synthetic', syntheticBridgeFixture]] as const) {
  test(`${name}: exact five-file JSON restoration and Canonical preservation`, () => {
    const files = fixture(); assert.deepEqual(validateV2Files(files), [])
    const before = structuredClone(files), document = bridge(files)
    assert.deepEqual(restoreBridgeV2(document), before)
    assert.deepEqual(projectBridgeCompatibility(document, BRIDGE_NOW).canonical, readV2(before))
    assert.deepEqual(files, before)
  })
  test(`${name}: full six-module baseline, map/Collection/Journey compatibility`, () => {
    const files = fixture(), expected = deriveAppDataFromCanonical(readV2(files), { now: BRIDGE_NOW })
    const actual = projectBridgeCompatibility(bridge(files), BRIDGE_NOW)
    assert.deepEqual(actual.baseline, buildBaseline(expected, { now: BRIDGE_NOW }))
    assert.deepEqual(actual.timeContext, deriveTimeQueryContext(readV2(files)))
    assert.deepEqual(projectBridgeOriginalRoutes(bridge(files)), actual.timeContext.originalRoutes)
    for (const locale of ['zh-Hans', 'en']) for (const layer of officialLayers) {
      assert.deepEqual(queryCollection(actual.app.worldGraph.worldGraphSnapshot, layer.id, locale), queryCollection(expected.worldGraph.worldGraphSnapshot, layer.id, locale))
    }
  })
}
test('raw IDs collide across travel/planned/wish without merging, repeated place visits stay separate', () => {
  const document = bridge(syntheticBridgeFixture())
  const rows = [BRIDGE.travel, BRIDGE.planned, BRIDGE.wish].map(s => entry(document, s, 'collision'))
  assert.equal(new Set(rows.map(e => e.id)).size, 3)
  assert.equal(new Set(rows.map(e => e.entityId)).size, 1)
  assert.notEqual(entry(document, BRIDGE.travel, 'repeat').id, rows[0].id)
  assert.equal(rows[0].source.sourceId, BRIDGE.travel)
  assert.equal(rows[2].extensions!.extra && (rows[2].extensions!.extra as Record<string, unknown>).source, 'travel-map:planned')
})
test('identity ledger survives rename/reordering/rerun and retains absent IDs', () => {
  const files = syntheticBridgeFixture(), first = bridge(files)
  files.travel.records.reverse(); files.places.places.reverse(); files.places.places[0].names.en = 'Renamed neutral place'
  const next = bridgeV2(files, { now: BRIDGE_NOW, manifest: first.manifest, allocateId: () => { throw new Error('no new identities') } })
  assert.deepEqual(next.manifest, first.manifest)
  const removed = files.travel.records.pop()!
  const absent = bridgeV2(files, { now: BRIDGE_NOW, manifest: next.manifest, allocateId: () => { throw new Error('no allocation') } })
  files.travel.records.push(removed)
  const returned = bridgeV2(files, { now: BRIDGE_NOW, manifest: absent.manifest, allocateId: () => { throw new Error('no allocation') } })
  assert.equal(entry(returned, BRIDGE.travel, removed.id).id, entry(first, BRIDGE.travel, removed.id).id)
})
test('locations retain zero, omission, null, record override and missing place coordinates', () => {
  const files = syntheticBridgeFixture(), document = bridge(files), restored = restoreBridgeV2(document)
  assert.deepEqual(restored.travel.records.slice(0, 3), files.travel.records.slice(0, 3))
  assert.equal(Object.hasOwn(restored.travel.records[2], 'lat'), false)
  const middle = entry(document, BRIDGE.travel, 'middle')
  assert.equal(document.store.anchors.some(a => a.entityId === middle.entityId && a.kind === 'location'), false)
})
test('partial, invalid, reversed and missing dates remain raw evidence, without injected visit dates', () => {
  const document = bridge(syntheticBridgeFixture())
  for (const id of ['repeat', 'uncertain', 'no-date']) {
    const e = entry(document, BRIDGE.travel, id)
    const raw = (e.fields.date as { raw: Record<string, unknown> }).raw
    if (id === 'repeat') assert.deepEqual(raw, { startDate: '2025', endDate: '2025-08', year: 2025 })
    if (id === 'no-date') assert.deepEqual(raw, {})
    assert.notEqual(raw.startDate, BRIDGE_NOW)
    assert.ok(classifyStoredDates(e.fields.date as never))
  }
})
test('empty country container remains evidence; only nonempty visit creates Entry', () => {
  const files = syntheticBridgeFixture(), document = bridge(files)
  assert.equal(document.store.evidence.length, 2)
  const visits = document.store.entries.filter(e => e.source.sourceId === BRIDGE.country)
  assert.equal(visits.length, 1)
  assert.equal(visits[0].source.recordId, files.editorState.addedCountries[0].placeId)
  assert.equal(document.store.entities.some(e => e.id === files.editorState.addedCountries[1].placeId), true)
})
test('management rows include hidden/coordinate-less records and leave unused catalog entities present', () => {
  const files = syntheticBridgeFixture(), document = bridge(files)
  assert.equal(queryStoreLayer(document.store, BRIDGE.footprint).length, files.travel.records.filter(r => r.status !== 'planned').length + 1)
  const unused = files.places.places.find(p => !document.store.entries.some(e => e.entityId === p.id))!
  assert.ok(document.store.entities.some(e => e.id === unused.id))
  const hidden = document.store.viewStates.find(v => v.layerId === BRIDGE.footprint)!.hiddenEntryIds
  assert.ok(hidden.includes(entry(document, BRIDGE.travel, 'middle').id))
})
test('original adjacency uses full source order: excluded middle never creates A to C', () => {
  const document = bridge(syntheticBridgeFixture()), sequence = document.store.sequences[0]
  const pairs = queryOriginalAdjacency(document.store, sequence.id, sequence.entryIds)
  assert.deepEqual(pairs.map(p => [p.from.source.recordId, p.to.source.recordId]), [['collision', 'middle'], ['middle', 'end']])
  const visible = sequence.entryIds.filter(id => id !== entry(document, BRIDGE.travel, 'middle').id)
  assert.deepEqual(queryOriginalAdjacency(document.store, sequence.id, visible), [])
})
test('same-place consecutive visits preserve their original predecessor instead of collapsing it', () => {
  const files = syntheticBridgeFixture(); files.travel.records[1].placeId = files.travel.records[0].placeId
  const document = bridge(files), seq = document.store.sequences[0]
  const nonzeroPairs = queryOriginalAdjacency(document.store, seq.id, seq.entryIds).filter(p => p.from.entityId !== p.to.entityId)
  assert.deepEqual(nonzeroPairs.map(p => [p.from.source.recordId, p.to.source.recordId]), [['middle', 'end']])
})
test('multilingual names retain original language and fallback without auto-translation', () => {
  const files = publicBridgeFixture(), document = bridge(files)
  for (const p of files.places.places) {
    const e = document.store.entities.find(e => e.id === p.id)!
    assert.deepEqual(e.title.names, p.names)
    for (const locale of ['zh-Hans', 'en', 'ja']) assert.equal(resolveName(e.title, locale), resolveName(p, locale))
  }
  assert.ok(document.store.entities.filter(e => e.typeId === 'bridge:journey').every(e => Object.keys(e.title.names).length === 0))
})
test('media metadata/variants/title/hidden/order/cover preserve references without reading media bytes', () => {
  const files = syntheticBridgeFixture(), document = bridge(files)
  assert.deepEqual(restoreBridgeV2(document).media, files.media)
  assert.deepEqual(restoreBridgeV2(document).editorState, files.editorState)
  assert.equal(document.store.assets.length, 2)
  assert.equal(document.store.entities.filter(e => e.typeId === 'bridge:media').length, 2)
})
test('projection reconstructs from Store fields instead of retaining an original input blob', () => {
  const document = structuredClone(bridge(syntheticBridgeFixture()))
  const row = entry(document, BRIDGE.travel, 'middle')
  ;(row.fields as Record<string, unknown>).note = 'Changed synthetic note'
  assert.equal(restoreBridgeV2(document).travel.records[1].notes, 'Changed synthetic note')
})
for (const namespace of [BRIDGE.travel, BRIDGE.wish, BRIDGE.media, BRIDGE.country]) test(`${namespace}: same-source collision rejects whole bridge before ID allocation`, () => {
  const files = syntheticBridgeFixture()
  if (namespace === BRIDGE.travel) files.travel.records.push(structuredClone(files.travel.records[0]))
  if (namespace === BRIDGE.wish) files.wantToGo.items.push(structuredClone(files.wantToGo.items[0]))
  if (namespace === BRIDGE.media) files.media.items.push(structuredClone(files.media.items[0]))
  if (namespace === BRIDGE.country) files.editorState.addedCountries.push(structuredClone(files.editorState.addedCountries[0]))
  let allocations = 0
  assert.throws(() => bridgeV2(files, { now: BRIDGE_NOW, allocateId: () => { allocations++; return sequentialUuids()() } }), /E_BRIDGE_SOURCE_COLLISION/)
  assert.equal(allocations, 0)
})
test('invalid V2 reference fails closed without public fallback or partial result', () => {
  const files = publicBridgeFixture(); files.travel.records[0].placeId = sequentialUuids()()
  assert.throws(() => bridge(files), /E_BRIDGE_V2_INVALID/)
})
test('non-JSON/getter input rejected without executing it', () => {
  const files = publicBridgeFixture(); let reads = 0
  Object.defineProperty(files.travel.records[0], 'custom', { enumerable: true, get() { reads++; return 'sensitive' } })
  assert.throws(() => bridge(files), /E_JSON/); assert.equal(reads, 0)
})
test('malformed/duplicate ledger and allocated place ID collisions reject', () => {
  const files = publicBridgeFixture(), document = bridge(files)
  assert.throws(() => readBridgeManifest({ ...document.manifest, version: 2 }), /E_BRIDGE_MANIFEST/)
  assert.throws(() => readBridgeManifest({ ...document.manifest, identities: [document.manifest.identities[0], document.manifest.identities[0]] }), /E_BRIDGE_ID_COLLISION/)
  assert.throws(() => bridgeV2(files, { now: BRIDGE_NOW, allocateId: () => files.places.places[0].id }), /E_BRIDGE_ID_COLLISION/)
  assert.throws(() => bridgeV2(files, { now: BRIDGE_NOW, allocateId: () => 'not-a-uuid' }), /E_UUID7/)
})
test('serialized bridge and ledger restore without the original input; missing ordered fact rejects', () => {
  const document = JSON.parse(JSON.stringify(bridge(syntheticBridgeFixture())))
  assert.deepEqual(restoreBridgeV2(document), syntheticBridgeFixture())
  const metadata = document.store.sources.find((s: { id: string }) => s.id === BRIDGE.metadata)
  metadata.extensions.order.travel.pop()
  assert.throws(() => restoreBridgeV2(document), /E_BRIDGE_UNCONSUMED/)
})
test('ledger substitution and unsupported bridge version reject', () => {
  const document = structuredClone(bridge(publicBridgeFixture()))
  const id = document.manifest.identities[0].id
  ;(document.manifest.identities[0] as { id: string }).id = sequentialUuids(Date.UTC(2030, 0, 1))()
  assert.notEqual(document.manifest.identities[0].id, id)
  assert.throws(() => restoreBridgeV2(document), /E_BRIDGE_MANIFEST_MISMATCH/)
  assert.throws(() => restoreBridgeV2({ ...document, version: 2 } as never), /E_BRIDGE_VERSION/)
})
test('corrupt but referentially valid original sequence rejects, rather than connecting different visits', () => {
  const document = structuredClone(bridge(syntheticBridgeFixture()))
  const seq = document.store.sequences[0]
  ;(seq.entryIds as string[]).reverse()
  assert.throws(() => restoreBridgeV2(document), /E_BRIDGE_DERIVATIVE/)
})
test('mismatched derived date anchor rejects rather than disguising altered date evidence', () => {
  const document = structuredClone(bridge(syntheticBridgeFixture())), row = entry(document, BRIDGE.travel, 'middle')
  ;(row.fields as Record<string, unknown>).date = { raw: { startDate: '2030' } }
  assert.throws(() => restoreBridgeV2(document), /E_BRIDGE_DERIVATIVE/)
})
test('deep immutability and source ownership prevent caller alias mutation', () => {
  const files = syntheticBridgeFixture(), document = bridge(files)
  files.travel.records[0].notes = 'Changed outside'
  assert.equal(restoreBridgeV2(document).travel.records[0].notes, '')
  assert.throws(() => { (document.store.entries as unknown[]).pop() }, TypeError)
  assert.throws(() => { (document.manifest.identities as unknown[]).pop() }, TypeError)
  assert.ok(document.manifest.identities.every(row => typeof identityKey(row) === 'string'))
  assert.ok(document.store.sequences.every(s => s.id === bridgeRowId('journey-sequence', s.source.recordId)))
})
