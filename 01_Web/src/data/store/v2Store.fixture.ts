/// <reference types="node" />
/** Test helpers for the V2 -> formal store migration and projection. Only tracked
 * neutral sample data, frozen neutral fixtures and invented values. Not imported by
 * the App. */
import { readFileSync } from 'node:fs'
import { type FormalState, emptyFormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { type ChangeSet, applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { migratedCanonical, MIGRATED_CANONICAL_NAMES, v2SpaceCanonical, type V2SpaceCanonicalName } from '../canonical/frozen.fixture.ts'
import { publicBridgeFixture, syntheticBridgeFixture } from '../canonical/storeBridge.fixture.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import type { V2Files } from '../canonical/v2Schema.ts'
import { OFFICIAL_POLICY } from './officialDefinitions.ts'
import { type MigrateV2Options, migrateV2 } from './migrateV2.ts'

export const NOW = '2026-10-13T00:00:00.000Z'
const PLACES_GENERATED_AT = '2026-09-01T00:00:00.000Z'

/** V2-space frozen canonicals that are valid V2 files. `countryOfCity` is not: its
 * editor state hides a city id that is not in its place registry. */
const V2_SPACE_VALID: readonly V2SpaceCanonicalName[] = ['sample', 'personal', 'nameInconsistency', 'recordCoordinates']

/** The neutral synthetic G2 bridge data plus every edge case the 3C-1b spec lists. */
export function edgeCaseFixture(): V2Files {
  const files = syntheticBridgeFixture()
  const cities = files.places.places.filter(p => p.subtype === 'city'), [a, b] = cities
  const countries = files.places.places.filter(p => p.subtype === 'country')
  const visited = files.editorState.addedCountries[0].placeId
  // A planned record and a want-to-go item with the same raw id stay two entries.
  files.travel.records.push({ id: 'shared-id', placeId: a.id, start_date: '2027-03', status: 'planned', trip_title: 'Synthetic plan', journeyId: 'planned-journey' } as V2Files['travel']['records'][number])
  files.wantToGo.items.push({ id: 'shared-id', placeId: a.id, addedAt: '2026-02-30', hidden: false })
  // Explicit hiddenFromHome false, and a blank journey id that groups nothing.
  files.travel.records.push({ id: 'shown', placeId: b.id, start_date: '2025-03-01', hiddenFromHome: false, journeyId: '  ', notes: 'Synthetic shown' } as V2Files['travel']['records'][number])
  // A country with a visit date is also hidden.
  files.editorState.hiddenCountryIds = [visited]
  // The cover points at a hidden media item (already hidden by the G2 fixture); another cover and
  // list elements point at media without a file, and one list repeats an id.
  files.editorState.coverMediaByCity = { ...files.editorState.coverMediaByCity, [b.id]: 'synthetic-missing-cover' }
  files.editorState.hiddenMediaIds = ['synthetic-photo', 'synthetic-built-in']
  files.editorState.mediaOrderByCity = { [a.id]: ['synthetic-photo', 'synthetic-missing', 'synthetic-photo'], [b.id]: [] }
  files.editorState.countryOrder = [...files.editorState.countryOrder, files.editorState.countryOrder[0]]
  // Empty order lists.
  files.editorState.cityOrderByCountry = { ...files.editorState.cityOrderByCountry, [countries[countries.length - 1].id]: [] }
  files.editorState.droneOrderByCity = { ...files.editorState.droneOrderByCity, [a.id]: [] }
  // Titles the store cannot hold stay verbatim; an empty externalIds object stays.
  b.names = { ...b.names, 'not a tag!': 'Synthetic' }
  a.originalLanguage = 'fr'
  cities[cities.length - 1].externalIds = {}
  files.media.items[1] = { ...files.media.items[1], title: { names: { en: 'Synthetic flight' }, originalLanguage: 'de' } }
  // Display without an overview target, with a region substring and place lists.
  delete files.travel.display.overviewTarget
  files.travel.display.regionIncludes = ['Synthetic']
  files.travel.display.homeHiddenCountryIds = [countries[0].id]
  files.travel.display.originCountryIds = [countries[0].id]
  files.travel.display.regionCountryIds = [countries[1].id]
  // Approximate location.
  countries[1].location = { ...countries[1].location!, approximate: true }
  return files
}

/** The same edge data with every editor and display list empty. */
export function emptyListsFixture(): V2Files {
  const files = edgeCaseFixture()
  const e = files.editorState
  e.countryOrder = []; e.hiddenCountryIds = []; e.hiddenCityIds = []; e.hiddenMediaIds = []; e.hiddenDroneMediaIds = []
  e.cityOrderByCountry = {}; e.mediaOrderByCity = {}; e.coverMediaByCity = {}; e.droneOrderByCity = {}
  delete e.updatedAt
  files.travel.display.regionIncludes = []
  return files
}

const migratedFilesFixture = (): V2Files =>
  JSON.parse(readFileSync(new URL('../v2write/fixtures/migrated-files.json', import.meta.url), 'utf8')) as V2Files

/** Every V2 input of the round-trip tests: [name, fresh copy]. */
export function migrationInputs(): readonly (readonly [string, () => V2Files])[] {
  return [
    ['public sample (src/data/v2-sample)', publicBridgeFixture],
    ['G2 synthetic (storeBridge.fixture)', syntheticBridgeFixture],
    ['3C-1b edge cases', edgeCaseFixture],
    ['3C-1b empty lists', emptyListsFixture],
    ['v2write/fixtures/migrated-files.json', migratedFilesFixture],
    ...MIGRATED_CANONICAL_NAMES.map(name => [`canonical/fixtures/migrated-canonical.json ${name}`, () => {
      const { canonical, fileMeta } = migratedCanonical(name)
      return serializeV2(canonical, { ...fileMeta, placesGeneratedAt: PLACES_GENERATED_AT })
    }] as const),
    ...V2_SPACE_VALID.map(name => [`canonical/fixtures/v2-space-canonical.json ${name}`, () => serializeV2(v2SpaceCanonical(name), { placesGeneratedAt: PLACES_GENERATED_AT })] as const),
  ]
}

export interface Migrated {
  readonly result: Extract<ReturnType<typeof migrateV2>, { ok: true }>
  readonly changeSet: ChangeSet
  readonly state: FormalState
}
/** Allocated ids start in 2030: the frozen fixtures' place ids come from sequentialUuids()
 * with its default 2026 epoch, and an allocator must never hand out a place id. */
export const allocatorFrom = (year = 2030) => sequentialUuids(Date.UTC(year, 0, 1))
/** migrateV2 -> planCommands on an empty store -> applyChangeSet. */
export function migrateIntoEmptyStore(files: V2Files, options: Partial<MigrateV2Options> = {}): Migrated {
  const result = migrateV2(files, { now: NOW, allocateId: allocatorFrom(), ...options })
  if (!result.ok) throw new Error(`migration refused: ${JSON.stringify(result.report.problems)}`)
  const empty = emptyFormalState()
  const changeSet = planCommands(memoryReader(empty), result.commands, { baseRevision: 0, now: NOW, policy: OFFICIAL_POLICY })
  return { result, changeSet, state: applyChangeSet(empty, changeSet) }
}
