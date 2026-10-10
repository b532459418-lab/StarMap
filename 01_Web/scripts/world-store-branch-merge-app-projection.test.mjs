/** Neutral Saved snapshots only. Projection assertions never claim host authority. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BRIDGE, bridgeV2 } from '../src/data/canonical/storeBridge.ts'
import { BRIDGE_NOW as NOW, publicBridgeFixture, syntheticBridgeFixture } from '../src/data/canonical/storeBridge.fixture.ts'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { buildBaseline, stableStringify } from '../src/data/derive/baseline.ts'
import { deriveTimeQueryContext } from '../src/data/derive/timeQueryContext.ts'
import { queryCollection } from '../src/worldgraph/collection.ts'
import { officialLayers } from '../src/worldgraph/layers.ts'
import { STORE_TABLES } from '../src/worldgraph/store/schema.ts'
import { readRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { createRepositoryV2 } from './world-store-repository-v2.mjs'
import { createRepositoryMergeSavedArchive as createSaved, readRepositoryMergeSavedArchive as readSaved,
  createRepositoryMergeStoreOperationRequest as operation, createRepositoryMergeStoreRequest as merge,
  projectRepositoryMergeStoreRequest as projectRequest, appendRepositoryMergeSavedEvent as append,
  previewRepositoryMergeStore as previewMerge } from './world-store-branch-merge-store-contract.mjs'
import { createRepositoryMergeStoreHost, previewRepositoryMergeStoreCreation, createRepositoryMergeStore,
  openRepositoryMergeStore } from './world-store-branch-merge-store.mjs'
import { createRepositoryMergeBackupHost, previewRepositoryMergeBackup, backupRepositoryMergeStore,
  previewRepositoryMergeBackupRestore, restoreRepositoryMergeBackup } from './world-store-branch-merge-backup.mjs'
import { projectRepositoryMergeSavedApp as project } from './world-store-branch-merge-app-projection.mjs'

const build = files => bridgeV2(files, { now: NOW, allocateId: sequentialUuids() })
function native(document) {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0,
    world: document.store, identities: document.manifest, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: 'synthetic-app-family', branchId: 'native', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function saved(document, name = 'local') {
  const source = native(document), incoming = previewRepositoryArchive(source)
  const binding = { hostId: 'synthetic-app-host', locationDigest: 'a'.repeat(64) }
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1,
    identity: { libraryId: source.identity.libraryId, branchId: name, genesisId: name + '-initial' },
    origin: { kind: 'fork', source: incoming.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name,
    requestDigest: digest({ operationId: 'create-' + name, previewDigest: incoming.previewDigest, binding }),
    previewDigest: incoming.previewDigest, policyDigest: digest({}) }
  return createSaved({ format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation,
    markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] })
}
function commands(current, id, rows, additions) {
  return operation({ id, expectedRevision: current.projection.state.revision,
    action: { kind: 'commands', commands: rows }, ...(additions ? { identities: additions } : {}) }, current)
}
function change(current, id, rows) {
  const request = commands(current, id, rows)
  return append(current, request, projectRequest(request, current).expectedReceipt)
}
function update(current, table, rowId, mutation, id = 'edit-' + table) {
  const old = current.projection.state.world[table].find(row => row.id === rowId), value = mutation(structuredClone(old))
  return change(current, id, [{ op: 'update', table, id: rowId, expectedRevision: old.revision,
    value: { ...value, revision: old.revision + 1 } }])
}
function note(current, id, text) {
  const row = current.projection.state.world.entries.find(entry => entry.source.sourceId === BRIDGE.travel)
  return update(current, 'entries', row.id, value => ({ ...value, fields: { ...value.fields, note: text } }), id)
}
function mergeRequest(target, source, id) {
  const choices = previewMerge(target, source).catalogue.items.map(row => ({ itemId: row.itemId,
    choice: row.allowedChoices.includes('source') ? 'source' : 'target' }))
  return merge(id, target, source, choices)
}
function merged(target, source, id = 'merge') {
  const request = mergeRequest(target, source, id)
  return append(target, request, projectRequest(request, target).expectedReceipt)
}
const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
const profileRefuses = action => assert.throws(action, error => error.code === 'E_APP_PROJECTION_PROFILE' || error.code?.startsWith('E_BRIDGE_'))
const publicFiles = publicBridgeFixture(), syntheticFiles = syntheticBridgeFixture()
const publicDocument = build(publicFiles), syntheticDocument = build(syntheticFiles)
const publicSaved = saved(publicDocument), syntheticSaved = saved(syntheticDocument)
// Closed independent oracle from the existing six-module V2 derive API. This
// checks every data export and every original helper result; no generic
// function/Map stripping can make an accidental omission appear correct.
const helperNames = {
  travelAtlas: ['getCitiesForCountry', 'shouldHideCityFromNavigation', 'countryIdOfCity'],
  editorState: ['orderBySavedIds'], mediaCatalog: ['getMediaSource', 'getCityPhotos', 'getCityCoverPhoto'],
  droneMedia: ['getDroneMediaForCity', 'hasDroneMedia'], wantToGo: ['wantToGoConvertBlockReason', 'plannedConvertBlockReason'], worldGraph: [],
}
const jsonData = value => JSON.parse(JSON.stringify(value))
function expectedAppDto(app) {
  assert.deepEqual(Object.keys(app), Object.keys(helperNames))
  return Object.fromEntries(Object.entries(app).map(([module, exports]) => {
    assert.deepEqual(Object.keys(exports).filter(key => typeof exports[key] === 'function').sort(), [...helperNames[module]].sort())
    return [module, Object.fromEntries(Object.entries(exports).map(([name, value]) => {
      if (helperNames[module].includes(name)) {
        const descriptor = module === 'editorState'
          ? { kind: 'static-helper-reference', module: 'src/data/derive/editorState.ts', export: 'orderBySavedIds', callable: false }
          : { kind: 'helper-evaluation-reference', evaluatedIn: `baseline.modules.${module}.${name}`, callable: false }
        return [name, descriptor]
      }
      if (value instanceof Map) {
        assert.equal(module, 'wantToGo'); assert.ok(['wantToGoItemById', 'plannedRecordById'].includes(name))
        return [name, { kind: 'map-entries', entries: jsonData([...value.entries()]) }]
      }
      return [name, jsonData(value)]
    }))]
  }))
}
function parity(current, files, now = NOW) {
  const result = project(current, { now }), canonical = readV2(files), expected = deriveAppDataFromCanonical(canonical, { now })
  assert.deepEqual(result.canonical, canonical)
  assert.deepEqual(result.app, expectedAppDto(expected))
  assert.equal(stableStringify(result.baseline), stableStringify(buildBaseline(expected, { now })))
  assert.deepEqual(result.timeContext, deriveTimeQueryContext(canonical))
  assert.deepEqual(result.originalRoutes, deriveTimeQueryContext(canonical).originalRoutes)
  return result
}
function frozen(value) {
  if (!value || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value)); for (const nested of Object.values(value)) frozen(nested)
}

test('public Saved has independent Canonical, six-module, baseline and original-route parity', () => { parity(publicSaved, publicFiles) })
test('synthetic Saved has independent Canonical, six-module, baseline and original-route parity', () => { parity(syntheticSaved, syntheticFiles) })
test('both locales retain every official Collection query', () => {
  const result = project(syntheticSaved, { now: NOW }), expected = deriveAppDataFromCanonical(readV2(syntheticFiles), { now: NOW })
  for (const locale of ['zh-Hans', 'en']) for (const layer of officialLayers)
    assert.deepEqual(queryCollection(result.app.worldGraph.worldGraphSnapshot, layer.id, locale),
      queryCollection(expected.worldGraph.worldGraphSnapshot, layer.id, locale))
})
test('opaque overlapping IDs, partial dates, malformed dates and source extensions survive', () => {
  const { canonical } = parity(syntheticSaved, syntheticFiles)
  assert.deepEqual(canonical.travel.records, readV2(syntheticFiles).travel.records)
  assert.deepEqual(canonical.wantToGo, readV2(syntheticFiles).wantToGo)
  assert.equal(canonical.travel.records.filter(row => row.id === 'collision').length, 2)
  assert.deepEqual(canonical.travel.records.find(row => row.id === 'repeat').custom, { flags: [false, 0, ''], recordId: 'opaque-preserved' })
})
test('zero/null/omitted coordinates and hidden management rows are preserved', () => {
  const result = parity(syntheticSaved, syntheticFiles)
  assert.equal(result.canonical.travel.records[0].lat, 0)
  assert.equal(result.canonical.travel.records[1].lat, null)
  assert.equal(Object.hasOwn(syntheticFiles.travel.records[2], 'lat'), false)
  const original = syntheticSaved.projection.state.world.entries.find(row => row.source.sourceId === BRIDGE.travel && row.source.recordId === 'end')
  assert.equal(Object.hasOwn(original.extensions.extra, 'lat'), false)
  assert.equal(result.canonical.travel.records[2].lat, readV2(syntheticFiles).travel.records[2].lat)
  assert.equal(syntheticSaved.projection.state.world.anchors.some(row => row.kind === 'location'
    && row.entityId === syntheticFiles.travel.records[1].placeId), false)
  assert.equal(result.canonical.wantToGo.items[0].hidden, true)
  assert.deepEqual(result.canonical.editorState.hiddenCityIds, syntheticFiles.editorState.hiddenCityIds)
})
test('photo/drone source metadata, orders and empty country containers remain exact', () => {
  const { canonical } = parity(syntheticSaved, syntheticFiles)
  assert.deepEqual(canonical.media, readV2(syntheticFiles).media)
  assert.deepEqual(canonical.editorState, readV2(syntheticFiles).editorState)
  assert.equal(canonical.editorState.addedCountries[1].visitedDate, '')
})
test('envelope is deeply frozen, digest-bound and expressly inactive without local approval', () => {
  const before = structuredClone(syntheticSaved), result = project(syntheticSaved, { now: NOW })
  frozen(result); assert.deepEqual(syntheticSaved, before)
  assert.equal(result.format, 'starmap.repository-merge-app-projection'); assert.equal(result.formatVersion, 1)
  assert.equal(result.savedDigest, syntheticSaved.savedDigest); assert.equal(result.stateDigest, digest(syntheticSaved.projection.state))
  assert.equal(result.policyDigest, digest({})); assert.equal(result.now, NOW)
  assert.equal(result.coverage.profile, 'bridge-v2-compatible')
  assert.equal(result.readOnly, true); assert.equal(result.appActivated, false); assert.equal(result.executable, false)
  assert.equal(result.persisted, false); assert.equal(result.newLocalApprovalIssued, false); assert.equal(result.foreignReceiptsBecomeLocal, false)
  assert.deepEqual(result.commands, [])
  const raw = { ...result }; delete raw.projectionEnvelopeDigest
  assert.equal(result.projectionEnvelopeDigest, digest(raw))
  assert.equal(Object.hasOwn(result, 'receipt'), false)
})
test('injected now controls output deterministically without changing Saved', () => {
  const later = '2028-02-01T00:00:00.000Z', one = parity(syntheticSaved, syntheticFiles, later), two = project(syntheticSaved, { now: later })
  assert.deepEqual(one, two); assert.equal(one.savedDigest, syntheticSaved.savedDigest)
  assert.notEqual(one.projectionEnvelopeDigest, project(syntheticSaved, { now: NOW }).projectionEnvelopeDigest)
})
test('current committed note edit is displayed instead of the old imported baseline', () => {
  const current = note(syntheticSaved, 'note-current', 'Current committed note'), files = structuredClone(syntheticFiles)
  files.travel.records[0].notes = 'Current committed note'
  const result = parity(current, files)
  assert.equal(current.baseArchive.sourceArchive.state.world.entries[0].fields.note, '')
  assert.equal(result.repositoryMetadata.repositoryRevision, 1); assert.equal(result.repositoryMetadata.worldRevision, 1)
  assert.deepEqual(result.repositoryMetadata.identities, current.projection.state.identities)
  assert.deepEqual(result.repositoryMetadata.retired, current.projection.state.retired)
})
test('valid entity name edit updates App names while preserving identity and source ordering', () => {
  const place = syntheticFiles.places.places.find(row => row.subtype === 'city'), current = update(syntheticSaved, 'entities', place.id,
    row => ({ ...row, title: { ...row.title, names: { ...row.title.names, en: 'Renamed neutral city' } } }))
  const files = structuredClone(syntheticFiles); files.places.places.find(row => row.id === place.id).names.en = 'Renamed neutral city'
  const result = parity(current, files); assert.deepEqual(result.repositoryMetadata.identities, syntheticSaved.projection.state.identities)
})
test('coherent hidden edit updates required view cache and retains source facts', () => {
  const state = syntheticSaved.projection.state, row = state.world.entries.find(item => item.source.recordId === 'collision' && item.source.sourceId === BRIDGE.travel)
  const view = state.world.viewStates.find(item => item.layerId === row.layerId)
  const current = change(syntheticSaved, 'hide', [
    { op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, hidden: true } } },
    { op: 'update', table: 'viewStates', id: view.id, expectedRevision: view.revision,
      value: { ...view, revision: view.revision + 1, hiddenEntryIds: view.orderedEntryIds.filter(id => id === row.id || view.hiddenEntryIds.includes(id)) } },
  ])
  const files = structuredClone(syntheticFiles); files.travel.records[0].hiddenFromHome = true
  parity(current, files)
})
test('DTO retains all eleven declared helper references and both full ordered lookup maps', () => {
  const result = project(syntheticSaved, { now: NOW }), expected = deriveAppDataFromCanonical(readV2(syntheticFiles), { now: NOW })
  assert.deepEqual(result.app, expectedAppDto(expected))
  for (const [module, names] of Object.entries(helperNames)) for (const name of names) {
    assert.equal(typeof expected[module][name], 'function'); assert.equal(result.app[module][name].callable, false)
    if (module !== 'editorState') assert.deepEqual(result.baseline.modules[module][name], jsonData(buildBaseline(expected, { now: NOW }).modules[module][name]))
  }
  for (const name of ['wantToGoItemById', 'plannedRecordById']) {
    assert.deepEqual(result.app.wantToGo[name].entries, jsonData([...expected.wantToGo[name]]))
    assert.ok(result.app.wantToGo[name].entries.length > 0)
  }
  assert.equal(result.dataRepresentation.format, 'starmap.app-data-dto'); assert.equal(result.dataRepresentation.callable, false)
  assert.equal(result.app.worldGraph.worldGraphSessionNow, NOW)
})
test('coherent partial date edit preserves exact raw evidence and updates the time anchor', () => {
  const world = syntheticSaved.projection.state.world, row = world.entries.find(item => item.source.recordId === 'repeat')
  const anchor = world.anchors.find(item => item.kind === 'time' && item.source.sourceId === row.source.sourceId && item.source.recordId === row.source.recordId)
  const date = { raw: { ...row.fields.date.raw, startDate: '2024' } }
  const current = change(syntheticSaved, 'partial-date', [
    { op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, date } } },
    { op: 'update', table: 'anchors', id: anchor.id, expectedRevision: anchor.revision, value: { ...anchor, revision: anchor.revision + 1, date } },
  ])
  const files = structuredClone(syntheticFiles); files.travel.records.find(item => item.id === 'repeat').start_date = '2024'
  parity(current, files)
})
test('edit/merge/edit/merge keeps current data and complete Saved receipt provenance', () => {
  const incoming = note(saved(syntheticDocument, 'incoming'), 'incoming-edit', 'Incoming note')
  const first = merged(note(syntheticSaved, 'local-edit', 'Local note'), incoming, 'merge-one')
  const final = merged(note(first, 'local-later', 'Later local'), note(incoming, 'incoming-later', 'Final incoming'), 'merge-two')
  const files = structuredClone(syntheticFiles); files.travel.records[0].notes = 'Final incoming'
  const result = parity(final, files)
  assert.equal(final.events.length, 4); assert.equal(result.savedDigest, final.savedDigest)
  assert.deepEqual(final.events[3].storeRequest.sourceArchive.events.map(row => row.receipt.operationId), ['incoming-edit', 'incoming-later'])
})
test('pending proposal stays metadata, never a displayed fact or implicit approval', () => {
  const row = syntheticSaved.projection.state.world.entries[0], proposal = { id: 'pending-app', status: 'pending', sourceId: BRIDGE.travel,
    evidenceIds: [], createdAt: NOW, baseRevision: 0, reason: 'Synthetic proposed note', commands: [{ op: 'update', table: 'entries', id: row.id,
      expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'Unapproved' } } }] }
  const request = operation({ id: 'stage-app', expectedRevision: 0, action: { kind: 'stage-proposal', proposal } }, syntheticSaved)
  const current = append(syntheticSaved, request, projectRequest(request, syntheticSaved).expectedReceipt), result = parity(current, syntheticFiles)
  assert.deepEqual(result.repositoryMetadata.proposals, current.projection.state.proposals)
  assert.equal(result.repositoryMetadata.proposals[0].status, 'pending'); assert.equal(result.newLocalApprovalIssued, false)
})
test('row revisions and entry clocks stay explicit metadata without resetting Saved facts', () => {
  const clock = '2026-10-07T01:02:03.000Z', row = syntheticSaved.projection.state.world.entries[0]
  const current = update(syntheticSaved, 'entries', row.id, value => ({ ...value, updatedAt: clock })), result = parity(current, syntheticFiles)
  assert.deepEqual(result.repositoryMetadata.entryClocks, current.projection.state.world.entries.map(item => ({ id: item.id,
    createdAt: item.createdAt, updatedAt: item.updatedAt })))
  assert.deepEqual(result.repositoryMetadata.rowRevisions, Object.fromEntries(STORE_TABLES.map(table => [table,
    current.projection.state.world[table].map(item => ({ id: item.id, revision: item.revision }))])))
  assert.equal(current.projection.state.world.entries[0].updatedAt, clock)
})
test('removed unused source remains a permanent tombstone in projection metadata', () => {
  const extra = { id: 'native:removed-source', revision: 0, title: { names: { en: 'Temporary neutral source' } }, origin: 'user' }
  const first = change(syntheticSaved, 'create-then-retire', [{ op: 'create', table: 'sources', value: extra }])
  const current = change(first, 'retire-source', [{ op: 'remove', table: 'sources', id: extra.id, expectedRevision: 0 }])
  const result = parity(current, syntheticFiles)
  assert.deepEqual(result.repositoryMetadata.retired, [{ table: 'sources', id: extra.id }])
  assert.equal(result.repositoryMetadata.repositoryRevision, 2)
})
test('absent allocated ID is retained and never reallocated by projection', () => {
  const addition = { kind: 'entry', sourceId: BRIDGE.travel, recordId: 'absent-native-record', id: '01900000-0000-7000-8000-000000009999' }
  const row = syntheticSaved.projection.state.world.entries[0]
  const request = commands(syntheticSaved, 'identity-tombstone', [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
    value: { ...row, revision: row.revision + 1 } }], [addition])
  const current = append(syntheticSaved, request, projectRequest(request, syntheticSaved).expectedReceipt), result = parity(current, syntheticFiles)
  assert.deepEqual(result.repositoryMetadata.identities.identities.find(item => item.id === addition.id), addition)
  assert.equal(result.canonical.travel.records.some(row => row.id === addition.recordId), false)
})

const rejectionCases = [
  ['additional source', current => change(current, 'extra-source', [{ op: 'create', table: 'sources', value: { id: 'native:source', revision: 0, title: { names: { en: 'Native' } }, origin: 'user' } }])],
  ['additional entity type', current => change(current, 'extra-type', [{ op: 'create', table: 'entityTypes', value: { id: 'native:type', revision: 0, title: { names: { en: 'Native type' } }, schemaVersion: 1, fields: [] } }])],
  ['additional layer', current => change(current, 'extra-layer', [{ op: 'create', table: 'layers', value: { id: 'native:layer', revision: 0, title: { names: { en: 'Native layer' } }, schemaVersion: 1, acceptedEntityTypes: ['bridge:place'], entryFields: [] } }])],
  ['additional relation type', current => change(current, 'extra-relation-type', [{ op: 'create', table: 'relationTypes', value: { id: 'native:relation', revision: 0, title: { names: { en: 'Native relation' } }, schemaVersion: 1, fromTypes: ['bridge:place'], toTypes: ['bridge:place'], fields: [] } }])],
  ['additional relation', current => change(current, 'extra-relation', [{ op: 'create', table: 'relations', value: { ...current.projection.state.world.relations[0], id: 'extra-relation', source: { sourceId: BRIDGE.place, recordId: 'native-relation', evidenceIds: [] } } }])],
  ['additional location anchor', current => change(current, 'extra-anchor', [{ op: 'create', table: 'anchors', value: { ...current.projection.state.world.anchors.find(row => row.kind === 'location'), id: 'extra-anchor' } }])],
  ['changed anchor precision', current => {
    const row = current.projection.state.world.anchors.find(item => item.kind === 'location')
    return update(current, 'anchors', row.id, item => ({ ...item, precision: 'exact' }))
  }],
  ['additional evidence', current => change(current, 'extra-evidence', [{ op: 'create', table: 'evidence', value: { id: 'native-evidence', revision: 0, sourceId: BRIDGE.travel, recordId: 'native-proof', attributes: { citation: 'Neutral proof' } } }])],
  ['additional view state', current => change(current, 'extra-view', [{ op: 'create', table: 'viewStates', value: { ...current.projection.state.world.viewStates[0], id: 'native-view' } }])],
  ['reordered nested view IDs', current => update(current, 'viewStates', current.projection.state.world.viewStates[0].id, row => ({ ...row, orderedEntryIds: [...row.orderedEntryIds].reverse() }))],
  ['incoherent hidden cache', current => {
    const row = current.projection.state.world.entries.find(item => item.source.recordId === 'collision' && item.source.sourceId === BRIDGE.travel)
    return update(current, 'entries', row.id, item => ({ ...item, fields: { ...item.fields, hidden: true } }))
  }],
  ['changed entity visibility', current => update(current, 'entities', current.projection.state.world.entities[0].id, row => ({ ...row, visibility: 'public' }))],
  ['changed date key order', current => {
    const row = current.projection.state.world.entries.find(item => item.source.recordId === 'repeat')
    return update(current, 'entries', row.id, item => ({ ...item, extensions: { ...item.extensions, dateKeys: [...item.extensions.dateKeys].reverse() } }))
  }],
]
for (const [name, mutate] of rejectionCases) test('valid Repository commit refuses unsupported ' + name, () => {
  const current = mutate(syntheticSaved)
  assert.deepEqual(readSaved(current), current); assert.equal(current.events.length, 1)
  profileRefuses(() => project(current, { now: NOW }))
})
const initialProfileCases = [
  ['changed source title', world => { world.sources.find(row => row.id === BRIDGE.travel).title.names.en = 'Changed source' }],
  ['changed source origin', world => { world.sources.find(row => row.id === BRIDGE.travel).origin = 'user' }],
  ['changed entity field schema', world => { world.entityTypes.find(row => row.id === 'bridge:place').fields.push({ key: 'nativeExtra', kind: 'text' }) }],
  ['changed layer field schema', world => { world.layers.find(row => row.id === BRIDGE.footprint).entryFields.push({ key: 'nativeExtra', kind: 'text' }) }],
  ['inconsistent country evidence', world => { world.evidence[0].attributes.visitedDate = '2023' }],
  ['additional entity field', world => {
    world.entityTypes.find(row => row.id === 'bridge:place').fields.push({ key: 'nativeExtra', kind: 'text' })
    world.entities[0].fields.nativeExtra = 'Not represented'
  }],
]
for (const [name, mutate] of initialProfileCases) test('valid initial Repository refuses unsupported ' + name, () => {
  const document = structuredClone(syntheticDocument); mutate(document.store)
  const current = saved(document, 'initial-extra')
  assert.deepEqual(readSaved(current), current); assert.equal(current.events.length, 0)
  profileRefuses(() => project(current, { now: NOW }))
})

test('accepted proposal review is a valid repository fact but unsupported App coverage', () => {
  const row = syntheticSaved.projection.state.world.entries[0], proposal = { id: 'approved-app', status: 'pending', sourceId: BRIDGE.travel,
    evidenceIds: [], createdAt: NOW, baseRevision: 0, reason: 'Neutral accepted note', commands: [{ op: 'update', table: 'entries', id: row.id,
      expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'Approved' } } }] }
  const stage = operation({ id: 'stage-approved', expectedRevision: 0, action: { kind: 'stage-proposal', proposal } }, syntheticSaved)
  const pending = append(syntheticSaved, stage, projectRequest(stage, syntheticSaved).expectedReceipt)
  const accept = operation({ id: 'accept-approved', expectedRevision: 1,
    action: { kind: 'accept-proposal', proposalId: proposal.id, decision: { reviewId: 'review-app', acceptedAt: NOW } } }, pending)
  const current = append(pending, accept, projectRequest(accept, pending).expectedReceipt)
  assert.deepEqual(readSaved(current), current); assert.equal(current.projection.state.world.reviews.length, 1)
  profileRefuses(() => project(current, { now: NOW }))
})
test('keyed table row order alone does not cause false profile rejection', () => {
  const document = structuredClone(syntheticDocument)
  for (const table of STORE_TABLES) document.store[table].reverse()
  parity(saved(document, 'reordered-tables'), syntheticFiles)
})
test('multiple journey rows may reorder without changing original source adjacency', () => {
  const files = structuredClone(syntheticFiles)
  files.travel.records.push({ id: 'second-a', placeId: files.travel.records[0].placeId, start_date: '2025-04-01', journeyId: 'second-journey' },
    { id: 'second-b', placeId: files.travel.records[2].placeId, start_date: '2025-04-02', journeyId: 'second-journey' })
  const document = structuredClone(build(files)); assert.equal(document.store.sequences.length, 2)
  document.store.sequences.reverse()
  const result = parity(saved(document, 'two-journeys'), files)
  assert.ok(result.originalRoutes.some(row => row.journeyId === 'second-journey'))
})
test('represented unknown source extensions survive a current committed change', () => {
  const row = syntheticSaved.projection.state.world.entries.find(item => item.source.recordId === 'uncertain')
  const current = update(syntheticSaved, 'entries', row.id, item => ({ ...item, extensions: { ...item.extensions,
    extra: { ...item.extensions.extra, notes: null, nativePreserved: { names: ['neutral', '示例'], empty: '', zero: 0, flag: false } } } }))
  const files = structuredClone(syntheticFiles)
  files.travel.records.find(item => item.id === 'uncertain').nativePreserved = { names: ['neutral', '示例'], empty: '', zero: 0, flag: false }
  parity(current, files)
})
test('shadowed recognized source field cannot be silently overwritten by projection', () => {
  const row = syntheticSaved.projection.state.world.entries.find(item => item.source.recordId === 'collision' && item.source.sourceId === BRIDGE.travel)
  const current = update(syntheticSaved, 'entries', row.id, item => ({ ...item, extensions: { ...item.extensions,
    extra: { ...item.extensions.extra, notes: 'Shadowed source note' } } }))
  assert.deepEqual(readSaved(current), current)
  profileRefuses(() => project(current, { now: NOW }))
})
test('tampered Saved digest and altered historical receipt are rejected before profile presentation', () => {
  const wrongDigest = structuredClone(syntheticSaved); wrongDigest.savedDigest = '0'.repeat(64)
  refuses(() => project(wrongDigest, { now: NOW }))
  const historical = structuredClone(note(syntheticSaved, 'history', 'History')); historical.events[0].receipt.operationId = 'forged'
  refuses(() => project(historical, { now: NOW }))
  const raw = { ...historical }; delete raw.savedDigest
  historical.savedDigest = digest(raw)
  assert.equal(historical.savedDigest, digest(raw))
  refuses(() => project(historical, { now: NOW }), 'E_MERGE_STORE_RECEIPT')
})
test('descriptor-safe preflight rejects getters and cycles without calling hostile code', () => {
  let called = false
  const getter = Object.defineProperty({}, 'format', { enumerable: true, get() { called = true; throw new Error('getter called') } })
  refuses(() => project(getter, { now: NOW })); assert.equal(called, false)
  const cycle = {}; cycle.self = cycle; refuses(() => project(cycle, { now: NOW }))
})
test('invalid or absent now and undersized node/byte/depth budgets reject bounded projection', () => {
  for (const now of [undefined, '2026-10-05', 'invalid', null]) refuses(() => project(syntheticSaved, { now }))
  for (const limits of [{ maxNodes: 1 }, { maxBytes: 32 }, { maxDepth: 2 }]) refuses(() => project(syntheticSaved, { now: NOW, limits }))
})
test('one source-fitting budget covers Saved replay and every derived representation together', () => {
  const amount = inspectRepositoryMergeArchiveInputs([syntheticSaved, { now: NOW }, {}]), limits = { maxNodes: Math.ceil(amount.nodes * 1.1) }
  assert.ok(amount.nodes < limits.maxNodes)
  assert.deepEqual(readSaved(syntheticSaved, {}, limits), syntheticSaved)
  refuses(() => project(syntheticSaved, { now: NOW, limits }), 'E_MERGE_STORE_DERIVED_BUDGET')
})

test('actual SQLite Saved v1 then backup/restore v2, later edit and merge project current facts and preserve receipts', async t => {
  const parent = realpathSync(tmpdir()), lab = await mkdtemp(path.join(parent, 'starmap-merge-store-')), stores = []
  t.after(async () => {
    for (const store of stores.reverse()) { try { store.close() } catch { /* Already explicitly closed. */ } }
    assert.equal(path.dirname(path.resolve(lab)), parent); assert.ok(path.basename(lab).startsWith('starmap-merge-store-'))
    await rm(lab, { recursive: true, force: true })
  })
  const storeHost = createRepositoryMergeStoreHost({ sandboxRoot: lab, hostId: 'synthetic-app', authorize: () => true })
  const backupHost = createRepositoryMergeBackupHost({ sandboxRoot: lab, hostId: 'synthetic-backup', authorize: () => true })
  const origin = path.join(lab, 'native'), target = path.join(lab, 'target'), source = path.join(lab, 'source')
  await mkdir(origin); createRepositoryV2(path.join(origin, 'world.sqlite'), native(syntheticDocument)).close()
  for (const [root, id] of [[target, 'create-target'], [source, 'create-source']])
    createRepositoryMergeStore(origin, root, previewRepositoryMergeStoreCreation(origin, { host: storeHost }), id, { host: storeHost })
  const open = root => { const store = openRepositoryMergeStore(root, { host: storeHost }); stores.push(store); return store }
  const local = open(target), incoming = open(source)
  const applyNote = (store, id, text) => {
    const current = store.snapshot(), row = current.projection.state.world.entries.find(entry => entry.source.sourceId === BRIDGE.travel)
    return store.apply(commands(current, id, [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
      value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: text } } }]))
  }
  assert.equal(applyNote(local, 'local-edit', 'Local').status, 'committed')
  assert.equal(applyNote(incoming, 'foreign-edit', 'Foreign').status, 'committed')
  local.apply(mergeRequest(local.snapshot(), incoming.snapshot(), 'merge-one'), { source })
  const files = structuredClone(syntheticFiles); files.travel.records[0].notes = 'Foreign'
  parity(local.snapshot(), files); assert.equal(local.snapshot().formatVersion, 1)
  const packageRoot = path.join(lab, 'package')
  backupRepositoryMergeStore(target, packageRoot, previewRepositoryMergeBackup(target, { host: backupHost }), 'backup-app', { host: backupHost })
  const restoredRoot = path.join(lab, 'restored'), restoreReceipt = restoreRepositoryMergeBackup(packageRoot, restoredRoot,
    previewRepositoryMergeBackupRestore(packageRoot, { host: backupHost }), 'restore-app', { host: backupHost, restoreHost: storeHost })
  const restored = open(restoredRoot), restoredSaved = restored.snapshot()
  assert.equal(restoredSaved.formatVersion, 2); parity(restoredSaved, files)
  assert.deepEqual(restored.findOperation('restore-app'), restoreReceipt)
  assert.equal(restored.findOperation('foreign-edit'), undefined)
  assert.equal(applyNote(restored, 'restored-edit', 'Restored local').status, 'committed')
  applyNote(incoming, 'foreign-later', 'New source')
  restored.apply(mergeRequest(restored.snapshot(), incoming.snapshot(), 'restored-merge'), { source })
  files.travel.records[0].notes = 'New source'
  const finalSaved = restored.snapshot(), result = parity(finalSaved, files)
  assert.equal(finalSaved.events.length, 2); assert.equal(result.savedDigest, finalSaved.savedDigest)
  assert.deepEqual(finalSaved.initialization.receipt, restoreReceipt)
  assert.equal(restored.findOperation('foreign-later'), undefined)
  assert.equal(result.newLocalApprovalIssued, false); assert.equal(result.persisted, false)
})
