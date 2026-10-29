/** Official StarMap definitions for the formal store (3C-1b, design 3B §3.2-2).
 *
 * `src/data/store/` is the App layer, not StarMap Core: it knows what a place,
 * a footprint or a want-to-go item is, while Core (`src/worldgraph/store/`) stays
 * generic. Everything here is a constant registry entry under a fixed `starmap:*`
 * key, never content of a particular user.
 *
 * - Entity types: `starmap:place`, `starmap:journey`, `starmap:media`.
 * - Layers: `starmap:travel` (systemKey `travel`) and `starmap:want-to-go`
 *   (systemKey `want_to_go`); the host injects OFFICIAL_POLICY so no other row can
 *   claim those system keys.
 * - Relation type: `starmap:part-of` (a city is part of its country).
 * - Sources: `starmap:user` for content created after the migration; the `v2:*`
 *   import sources keep G2's namespaces, so one raw record id stays separate per
 *   source.
 *
 * Field choice: only values with product meaning (dates, notes, trip titles,
 * place subtype and country code, the media links) are formal fields. Definitions
 * may only evolve compatibly (3B §3.3), so a field that is added later costs
 * nothing, while a field added now freezes its kind. Every other V2 value stays
 * verbatim in the row's `extensions.v2`. Hiding is view state, never a field
 * (3B §3.2-3): see VIEW_SCOPES.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative
 * imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalEntityType, FormalLayer, FormalRelationType } from '../../worldgraph/store/formal.ts'
import type { JsonObject, ReadonlyTitle, SourceDefinition, StorePolicy } from '../../worldgraph/store/types.ts'
import { freezeCopy, reject } from '../../worldgraph/store/schema.ts'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../../worldgraph/layers.ts'

/** Registry keys of the official definitions. */
export const OFFICIAL = Object.freeze({
  place: 'starmap:place',
  journey: 'starmap:journey',
  media: 'starmap:media',
  travel: 'starmap:travel',
  wantToGo: 'starmap:want-to-go',
  partOf: 'starmap:part-of',
  user: 'starmap:user',
})

/** Import sources of the V2 migration (origin `import`). The ids are G2's namespaces;
 * `v2:import` carries the file-level metadata of the five files in its extensions. */
export const V2_SOURCES = Object.freeze({
  place: 'v2:place',
  travel: 'v2:travel',
  planned: 'v2:planned',
  wantToGo: 'v2:want-to-go',
  countryVisit: 'v2:country-visit',
  media: 'v2:media',
  journey: 'v2:journey',
  import: 'v2:import',
})

/** Trusted host policy for the planner: the two official layers own their system keys. */
export const OFFICIAL_POLICY: StorePolicy = freezeCopy({
  officialLayers: { [TRAVEL_LAYER_ID]: OFFICIAL.travel, [WANT_TO_GO_LAYER_ID]: OFFICIAL.wantToGo },
})

const title = (en: string, zh: string): ReadonlyTitle => ({ names: { en, 'zh-Hans': zh } })

const PLACE_TYPE: FormalEntityType = {
  id: OFFICIAL.place, revision: 0, title: title('Place', '地点'), schemaVersion: 1,
  fields: [
    // 'country' or 'city'.
    { key: 'subtype', kind: 'text', required: true },
    // ISO 3166-1 alpha-2 of a country (RFC ID-5).
    { key: 'iso3166Alpha2', kind: 'text' },
  ],
}
const JOURNEY_TYPE: FormalEntityType = {
  id: OFFICIAL.journey, revision: 0, title: title('Journey', '行程'), schemaVersion: 1, fields: [],
}
const MEDIA_TYPE: FormalEntityType = {
  id: OFFICIAL.media, revision: 0, title: title('Media', '媒体'), schemaVersion: 1,
  fields: [
    // The city the media belongs to.
    { key: 'place', kind: 'entity_ref', required: true },
    // The file reference; its attributes keep the media metadata.
    { key: 'asset', kind: 'asset_ref', required: true },
  ],
}
const PART_OF: FormalRelationType = {
  id: OFFICIAL.partOf, revision: 0, title: title('Part of', '属于'), schemaVersion: 1,
  fromTypes: [OFFICIAL.place], toTypes: [OFFICIAL.place], fields: [],
}
const TRAVEL_LAYER: FormalLayer = {
  id: OFFICIAL.travel, revision: 0, title: title('Footprints', '足迹'), schemaVersion: 1, systemKey: TRAVEL_LAYER_ID,
  acceptedEntityTypes: [OFFICIAL.place],
  entryFields: [
    // Visit dates as raw start/end/year evidence, never repaired.
    { key: 'date', kind: 'date_evidence', required: true },
    { key: 'note', kind: 'text' },
    { key: 'tripTitle', kind: 'text' },
  ],
}
const WANT_TO_GO_LAYER: FormalLayer = {
  id: OFFICIAL.wantToGo, revision: 0, title: title('Want to Go', '想去'), schemaVersion: 1, systemKey: WANT_TO_GO_LAYER_ID,
  acceptedEntityTypes: [OFFICIAL.place],
  entryFields: [
    // Planned visit dates (planned footprint records only), raw evidence.
    { key: 'date', kind: 'date_evidence' },
    // The day a want-to-go item was added.
    { key: 'addedAt', kind: 'date' },
    { key: 'note', kind: 'text' },
    { key: 'tripTitle', kind: 'text' },
  ],
}
const USER_SOURCE: SourceDefinition = { id: OFFICIAL.user, revision: 0, title: title('StarMap', 'StarMap'), origin: 'user' }

const V2_SOURCE_TITLES: Readonly<Record<string, readonly [string, string]>> = {
  [V2_SOURCES.place]: ['V2 places', 'V2 地点'],
  [V2_SOURCES.travel]: ['V2 footprint records', 'V2 足迹记录'],
  [V2_SOURCES.planned]: ['V2 planned records', 'V2 计划记录'],
  [V2_SOURCES.wantToGo]: ['V2 want-to-go items', 'V2 想去条目'],
  [V2_SOURCES.countryVisit]: ['V2 added countries', 'V2 手动添加的国家'],
  [V2_SOURCES.media]: ['V2 media', 'V2 媒体'],
  [V2_SOURCES.journey]: ['V2 journeys', 'V2 行程'],
  [V2_SOURCES.import]: ['V2 file metadata', 'V2 文件元信息'],
}

/**
 * The version of OFFICIAL_DEFINITIONS (3C-5 G). A store records the version its official definition rows have (the
 * host's `store_definitions` table, store format 4); a store of an older version opens with E_STORE_UPGRADE_REQUIRED
 * and `npm run store:upgrade` brings its rows to these (./definitionUpgrades.ts), one of a newer version opens with
 * E_STORE_TOO_NEW. Raise it with every change of OFFICIAL_DEFINITIONS, and freeze the version it replaces in
 * ./officialDefinitionHistory.fixture.ts: its test requires every version to be a compatible evolution of the one
 * before (Core's checkDefinitionChange). Version 1: the definitions of every store before 3C-5 G.
 */
export const OFFICIAL_DEFINITIONS_VERSION = 1

/** The official definition rows, in dependency order. */
export const OFFICIAL_DEFINITIONS = freezeCopy({
  sources: [USER_SOURCE],
  entityTypes: [PLACE_TYPE, JOURNEY_TYPE, MEDIA_TYPE],
  relationTypes: [PART_OF],
  layers: [TRAVEL_LAYER, WANT_TO_GO_LAYER],
})

/** Commands that create every official definition. Types come before the layers
 * and the relation type that reference them, because the planner validates each
 * command in order. Recreating identical definitions is a no-op. */
export function officialDefinitionCommands(): readonly FormalCommand[] {
  const d = OFFICIAL_DEFINITIONS
  return freezeCopy([
    ...d.sources.map(value => ({ op: 'create' as const, table: 'sources' as const, value })),
    ...d.entityTypes.map(value => ({ op: 'create' as const, table: 'entityTypes' as const, value })),
    ...d.relationTypes.map(value => ({ op: 'create' as const, table: 'relationTypes' as const, value })),
    ...d.layers.map(value => ({ op: 'create' as const, table: 'layers' as const, value })),
  ])
}

/** One `v2:*` import source row; `extensions` only for `v2:import`. */
export function v2SourceDefinition(id: string, extensions?: JsonObject): SourceDefinition {
  const names = Object.hasOwn(V2_SOURCE_TITLES, id) ? V2_SOURCE_TITLES[id] : reject('E_SOURCE', 'v2Source.id')
  return freezeCopy({ id, revision: 0, title: title(names[0], names[1]), origin: 'import', ...(extensions ? { extensions } : {}) })
}

/** Official view scopes (3B §3.2-3). One scope per V2 semantic, never merged:
 * hidden lists and order lists are separate scopes, so each V2 array is restored
 * exactly. `viewItems` carry the order (`position`) and the hidden flag.
 *
 * A *map* scope (city order, media order, drone order) holds one `viewSettings`
 * row per key (`key` = the place id, `ref` = that place), and the key's list
 * lives in `mapListScope(scope, key)`; an empty list is a key without items.
 *
 * A list element that cannot be a view item (an id that is no row of the store,
 * such as a media id without a media file, or the second copy of a repeated id)
 * is kept as a `viewSettings` row of the same scope with key
 * `${UNRESOLVED_KEY_PREFIX}<position>` and value `{ position, id }`. */
export const VIEW_SCOPES = Object.freeze({
  /** Original order of `places.places` (place entities). */
  placeOrder: 'starmap:order/places',
  /** Original order of `travel.records`, visited and planned interleaved (entries of both layers).
   * Route adjacency depends on it. */
  recordOrder: 'starmap:order/travel-records',
  /** Original order of `wantToGo.items` (want-to-go entries). */
  wantToGoOrder: 'starmap:order/want-to-go',
  /** Original order of `media.items` (assets). */
  mediaOrder: 'starmap:order/media',
  /** Original order of `editorState.addedCountries` (country entities). */
  addedCountryOrder: 'starmap:order/added-countries',
  /** `hiddenFromHome` of a footprint record: one item per record that has a boolean value. */
  recordHiddenFromHome: 'starmap:hidden/travel-home',
  /** `hidden` of a want-to-go item: one hidden item per hidden item. */
  wantToGoHidden: 'starmap:hidden/want-to-go',
  countryOrder: 'starmap:editor/country-order',
  hiddenCountries: 'starmap:editor/hidden-countries',
  cityOrderByCountry: 'starmap:editor/city-order',
  hiddenCities: 'starmap:editor/hidden-cities',
  mediaOrderByCity: 'starmap:editor/media-order',
  hiddenMedia: 'starmap:editor/hidden-media',
  /** One setting per city: `ref` to the cover asset, or the raw media id as `value`. */
  coverMediaByCity: 'starmap:editor/cover-media',
  droneOrderByCity: 'starmap:editor/drone-order',
  hiddenDroneMedia: 'starmap:editor/hidden-drone-media',
  homeHiddenCountries: 'starmap:display/home-hidden-countries',
  originCountries: 'starmap:display/origin-countries',
  regionCountries: 'starmap:display/region-countries',
  navigationHiddenCities: 'starmap:display/navigation-hidden-cities',
  /** Settings `overviewTarget` and `regionIncludes` of `travel.display`. */
  display: 'starmap:display',
})
export const UNRESOLVED_KEY_PREFIX = 'unresolved:'
export const DISPLAY_SETTING_KEYS = Object.freeze({ overviewTarget: 'overviewTarget', regionIncludes: 'regionIncludes' })
/** The list scope of one key of a map scope. */
export const mapListScope = (mapScope: string, key: string): string => `${mapScope}/${key}`
