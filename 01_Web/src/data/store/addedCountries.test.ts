/**
 * How the official view identifies added countries (3C-5 E spec §2.6): a `starmap:travel` entry on a place whose
 * `subtype` is `country`, whatever its source, with the evidence it cites (the region). Before 3C-5 E the evidence of
 * the V2 source `v2:country-visit` was the added country and only a dated one had an entry; store format 3 gives every
 * added country its entry (../../../scripts/store-upgrade.test.mjs tests the upgrade).
 *
 * Synthetic data only: the 3C-1b edge fixture (Iceland added with a date and a region, the Faroe Islands added with an
 * empty visitedDate).
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FormalState } from '../../worldgraph/store/formal.ts'
import type { LayerEntry } from '../../worldgraph/store/types.ts'
import { readModelOf } from '../../worldgraph/readModel/build.ts'
import { indexReadModel } from '../../worldgraph/readModel/lookup.ts'
import { readV2 } from '../compat/v2/v2Reader.ts'
import { doubleRunStore } from '../editor/doubleRun.fixture.ts'
import { runNative } from '../editor/native/native.fixture.ts'
import { OFFICIAL, V2_SOURCES, VIEW_SCOPES } from './officialDefinitions.ts'
import { officialReader } from './officialReader.ts'
import { filterReadModelForPersonalBuild } from './personalBuildReadModel.ts'
import { officialEntryRole, projectStoreToCanonical } from './projectCanonical.ts'
import { edgeCaseFixture, migrateIntoEmptyStore } from './v2Store.fixture.ts'

const ICELAND = '01a0ed02-3f45-7743-8aec-d757b6c28eba'
const FAROE = '01a0ed02-3f47-772d-946a-07690eff25e1'

const canonicalOf = (state: FormalState) => projectStoreToCanonical(state, { source: 'local' }).canonical
const readerOf = (state: FormalState) => officialReader(indexReadModel(readModelOf(state, { origin: 'local' })))
const visitOn = (state: FormalState, placeId: string) => state.entries.find((entry) => entry.layerId === OFFICIAL.travel && entry.entityId === placeId)!
const withEntries = (state: FormalState, entries: readonly LayerEntry[]): FormalState => ({ ...state, entries })

test('the migration gives every added country its visit entry: a dated one its date, the others none, each citing its evidence', () => {
  const files = edgeCaseFixture()
  const { state } = migrateIntoEmptyStore(files)
  for (const placeId of [ICELAND, FAROE]) {
    const visit = visitOn(state, placeId)
    const evidence = state.evidence.find((row) => row.id === visit.source.evidenceIds[0])!
    assert.deepEqual([visit.source.sourceId, visit.source.recordId, evidence.sourceId, evidence.recordId], [V2_SOURCES.countryVisit, placeId, V2_SOURCES.countryVisit, placeId])
  }
  assert.deepEqual(visitOn(state, ICELAND).fields, { date: { raw: { startDate: '2024' } } })
  assert.deepEqual(visitOn(state, FAROE).fields, { date: { raw: {} } }, 'an empty visitedDate is no date; it stays in the evidence')
  // The official view and the reader give V2's added countries, values and order.
  const expected = readV2(files).editorState.addedCountries
  assert.deepEqual(canonicalOf(state).editorState.addedCountries, expected)
  assert.deepEqual(readerOf(state).addedCountries().map((country) => country.value), expected)
  assert.deepEqual(readerOf(state).addedCountries().map((country) => [country.placeId, country.visit.id, country.evidence.map((row) => row.id)]),
    expected.map((country) => { const visit = visitOn(state, country.placeId); return [country.placeId, visit.id, visit.source.evidenceIds] }))
})

test('the marker is the place: a travel entry on a country is a country visit whatever its source; on a city it is not', () => {
  const { state } = migrateIntoEmptyStore(edgeCaseFixture())
  const before = canonicalOf(state).editorState.addedCountries
  // Any source: a starmap:user entry on the country reads the same.
  const userSourced = withEntries(state, state.entries.map((entry) => (entry.id === visitOn(state, FAROE).id
    ? { ...entry, source: { ...entry.source, sourceId: OFFICIAL.user, recordId: entry.id } } : entry)))
  assert.deepEqual(canonicalOf(userSourced).editorState.addedCountries, before)
  const subtypeOf = (id: string) => state.entities.find((entity) => entity.id === id)?.fields.subtype
  const city = state.entities.find((entity) => entity.typeId === OFFICIAL.place && entity.fields.subtype === 'city')!
  const onCity = { ...visitOn(state, FAROE), entityId: city.id }
  assert.equal(officialEntryRole(visitOn(state, FAROE), subtypeOf), 'countryVisit')
  assert.equal(officialEntryRole(onCity, subtypeOf), undefined, 'a v2:country-visit entry on a city is no record and no added country')
  // The evidence alone is no added country any more (format 2's dateless rows: why store:upgrade gives them entries).
  const evidenceOnly = withEntries(state, state.entries.filter((entry) => entry.id !== visitOn(state, FAROE).id))
  assert.deepEqual(canonicalOf(evidenceOnly).editorState.addedCountries.map((country) => country.placeId), [ICELAND])
  assert.deepEqual(readerOf(evidenceOnly).addedCountries().map((country) => country.placeId), [ICELAND])
})

test('deleting an added country without a visit date removes its visit entry, the evidence it cites and its order row', () => {
  const files = edgeCaseFixture()
  files.editorState.hiddenCountryIds = [...files.editorState.hiddenCountryIds, FAROE]
  const store = doubleRunStore(files)
  const visit = visitOn(store.state, FAROE)
  const ordered = (state: FormalState) => state.viewItems.some((item) => item.scope === VIEW_SCOPES.addedCountryOrder && item.itemId === FAROE)
  assert.equal(ordered(store.state), true)
  const deleted = runNative(store, 'countries/delete', { ids: [FAROE] }, 1)
  assert.ok(deleted.state, JSON.stringify(deleted.error))
  assert.equal(store.state.entries.some((entry) => entry.id === visit.id), false)
  assert.equal(store.state.evidence.some((row) => visit.source.evidenceIds.includes(row.id)), false)
  assert.equal(ordered(store.state), false)
  assert.equal(canonicalOf(store.state).editorState.addedCountries.some((country) => country.placeId === FAROE), false)
})

test('the personal build: a hidden added country goes with its visit entry and the evidence it cites', () => {
  const { state } = migrateIntoEmptyStore(edgeCaseFixture())
  // The edge fixture hides Iceland, an added country with a date.
  const visit = visitOn(state, ICELAND)
  const { model } = filterReadModelForPersonalBuild(readModelOf(state, { origin: 'local' }))
  assert.equal(model.entries.some((entry) => entry.id === visit.id), false)
  assert.equal(model.evidence.some((row) => visit.source.evidenceIds.includes(row.id)), false)
  const faroe = visitOn(state, FAROE)
  assert.equal(model.entries.some((entry) => entry.id === faroe.id), true, 'a shown added country stays, without a date too')
  assert.equal(model.evidence.some((row) => faroe.source.evidenceIds.includes(row.id)), true)
})
