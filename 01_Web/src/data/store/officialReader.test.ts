/// <reference types="node" />
/** The official reader (3C-5 C1) answers as the official view: on every migration input, over the plain index and over
 * the live index, its places, countries, cities, want-to-go items and editor lists equal the projection's. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readModelOf } from '../../worldgraph/readModel/build.ts'
import { liveReadModelIndex } from '../../worldgraph/readModel/liveIndex.ts'
import { indexReadModel } from '../../worldgraph/readModel/lookup.ts'
import { officialReader } from './officialReader.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { migrateIntoEmptyStore, migrationInputs } from './v2Store.fixture.ts'

for (const [name, files] of migrationInputs()) test(`the official reader answers as the official view: ${name}`, () => {
  const { state } = migrateIntoEmptyStore(files())
  const model = readModelOf(state, { origin: 'local' })
  const view = projectStoreToCanonical(state, { source: 'local' }).canonical
  for (const [label, index] of [['index', indexReadModel(model)], ['live index', liveReadModelIndex(model)]] as const) {
    const reader = officialReader(index)
    for (const place of view.places) assert.deepEqual(reader.place(place.id), place, `${label}: place ${place.id}`)
    assert.equal(reader.place('synthetic-missing'), undefined)
    assert.deepEqual(reader.countries(), view.places.filter((place) => place.subtype === 'country'), `${label}: countries`)
    for (const country of view.places.filter((place) => place.subtype === 'country')) {
      assert.deepEqual(reader.citiesOf(country.id), view.places.filter((place) => place.subtype === 'city' && place.partOf === country.id), `${label}: cities of ${country.id}`)
    }
    for (const item of view.wantToGo.items) {
      assert.deepEqual(reader.wish(item.id)?.item, item, `${label}: want-to-go ${item.id}`)
      assert.ok(reader.wishesOn(item.placeId).some((wish) => wish.item.id === item.id))
    }
    assert.equal(reader.wish('synthetic-missing'), undefined)
    const { schemaVersion, addedCountries, updatedAt, ...lists } = view.editorState as unknown as Record<string, unknown>
    void schemaVersion; void addedCountries; void updatedAt
    // The editor lists only: the file header fields (schemaVersion, updatedAt, …) are not lists.
    const expected = Object.fromEntries(Object.entries(lists).filter(([key]) => Array.isArray(lists[key]) || (typeof lists[key] === 'object' && lists[key] !== null)))
    assert.deepEqual(reader.editorLists(), expected, `${label}: editor lists`)
    // 3C-5 C2: records, their order and journeys; added countries.
    assert.deepEqual(reader.recordsInOrder().map((record) => record.record), view.travel.records, `${label}: records`)
    for (const record of view.travel.records) {
      assert.deepEqual(reader.recordById(record.id)?.record, view.travel.records.find((candidate) => candidate.id === record.id), `${label}: record ${record.id}`)
      assert.ok(reader.recordsOn(record.placeId).some((found) => found.record.id === record.id))
      // A visited record's journey comes from a sequence (a planned record keeps its journeyId as a verbatim V2 value).
      if (record.status !== 'planned' && typeof record.journeyId === 'string' && record.journeyId.trim()) assert.ok(reader.journeyMembers(record.journeyId).some((found) => found.record.id === record.id), `${label}: member of ${record.journeyId}`)
    }
    for (const title of new Set(view.travel.records.map((record) => record.trip_title).filter((title) => typeof title === 'string'))) {
      assert.deepEqual(reader.visitedTitled(title as string).map((found) => found.record.id).sort(),
        view.travel.records.filter((record) => record.trip_title === title && record.status !== 'planned' && reader.recordById(record.id)?.planned === false).map((record) => record.id).sort(), `${label}: titled ${title}`)
    }
    assert.deepEqual(reader.addedCountries().map((country) => country.value), view.editorState.addedCountries, `${label}: added countries`)
    // The light queries of the country order.
    assert.deepEqual(reader.visitsInOrder().map((visit) => [visit.placeId, visit.planned, visit.start_date, visit.end_date]),
      view.travel.records.map((record) => [record.placeId, record.status === 'planned' && reader.recordById(record.id)!.planned, record.start_date, record.end_date]), `${label}: visits`)
    for (const place of view.places) assert.equal(reader.countryOf(place.id), place.subtype === 'country' ? place.id : place.partOf, `${label}: country of ${place.id}`)
  }
})
