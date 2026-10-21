/** The personal build carries only what its pages can show (batch 7, review S3, the author's option A; 3C-5B spec §2.4:
 * the filter works on the read model).
 *
 * `vite build --mode personal` writes the read model of the private library as a data file next to the bundle and
 * copies the private media. `filterReadModelForPersonalBuild` takes the hidden content out first. Only the build calls
 * it (scripts/local-editor-plugin.mjs): the dev server keeps everything, because the editor needs the hidden entries to
 * restore or delete them for good.
 *
 * What is hidden comes from the official hidden scopes (./officialDefinitions.ts VIEW_SCOPES): a Want to Go entry with
 * a hidden item in `wantToGoHidden`, and the members of `hiddenCountries`, `hiddenCities`, `hiddenMedia` and
 * `hiddenDroneMedia` (view items, and the raw ids of unresolved list elements).
 *
 * What goes is batch 7's table (the derivation and the Core adapters decide what a page shows), in rows:
 * - Want to Go entries that are hidden. The map, the cards and Collection without the editor never show them.
 * - Footprint entries (official role 'footprint') in a hidden city or in any city of a hidden country: derive drops
 *   them before countries, cities, Journey days and routes are formed. Planned records stay: they reach the Want to Go
 *   layer whatever the editor hides.
 * - Media entities that are hidden themselves (their asset is in a hidden media scope), or that belong to a hidden
 *   city or to a city of a hidden country, with their assets.
 * - Added countries of hidden countries: their evidence row and their visit entry.
 * - Places: a hidden country or city, and every place only removed content referred to (with the country of a removed
 *   city), unless something kept still refers to it (a kept entry, media entity or added country, or a kept place's
 *   part-of country). Places nothing referred to in the first place stay as they are.
 * - Journeys whose every member went: their sequence goes by selectReadModel, the journey entity after it (its source
 *   record is the journey's id).
 * - References: selectReadModel drops every row that refers to a removed row (anchors, relations, view items and
 *   settings, sequence members). On top of that, as the V2 filter did with the editor state: the country order without
 *   hidden countries, each map scope (city, media and drone order) without the keys of dropped places and without the
 *   elements that went, a key whose list the filter emptied, covers of dropped cities, and the order item of a removed
 *   added country.
 * - The four hidden scopes become empty: everything they named is gone or no longer has an effect.
 *
 * Kept rows are the input's own (except the rewritten sequences): visible entries keep every field, a visible asset's
 * `originalFileName` included (a separate decision). Rows the official view does not read are not touched unless they
 * refer to a removed row. Without anything hidden the model comes back with the same JSON text.
 *
 * `mediaFiles` lists the files under `media/user/` that the kept media entities' assets refer to (`src` and every
 * variant), as POSIX paths relative to `media/user/`, sorted; URLs outside `/media/user/` and paths that leave it are
 * skipped.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import type { AssetReference, Evidence, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import { readReadModel } from '../../worldgraph/readModel/check.ts'
import { selectReadModel } from '../../worldgraph/readModel/select.ts'
import type { ReadModel, ReadModelRow, ReadModelTable } from '../../worldgraph/readModel/types.ts'
import { OFFICIAL, UNRESOLVED_KEY_PREFIX, V2_SOURCES, VIEW_SCOPES, mapListScope } from './officialDefinitions.ts'
import { officialEntryRole } from './projectCanonical.ts'

export interface PersonalBuildReadModel {
  readonly model: ReadModel
  /** Files under `media/user/` the kept media refer to, relative POSIX paths, sorted. */
  readonly mediaFiles: readonly string[]
}

/** The scopes the build empties. */
export const PERSONAL_BUILD_CLEARED_SCOPES: readonly string[] = Object.freeze([
  VIEW_SCOPES.hiddenCountries, VIEW_SCOPES.hiddenCities, VIEW_SCOPES.hiddenMedia, VIEW_SCOPES.hiddenDroneMedia,
])

const MEDIA_PREFIX = '/media/user/'
const PAGE_ORIGIN = 'http://starmap.invalid'

/**
 * A media URL → its path relative to `media/user/` as the page requests it and the dev server resolves it (the URL's
 * path, percent-decoded), or undefined: another origin, outside `/media/user/`, or a segment that is empty, `.`, `..`
 * or holds a backslash or NUL.
 */
export function mediaFileOf(src: unknown): string | undefined {
  if (typeof src !== 'string') return undefined
  let pathname: string
  try {
    const url = new URL(src, PAGE_ORIGIN)
    if (url.origin !== PAGE_ORIGIN) return undefined
    pathname = decodeURIComponent(url.pathname)
  } catch { return undefined }
  if (!pathname.startsWith(MEDIA_PREFIX)) return undefined
  const relative = pathname.slice(MEDIA_PREFIX.length)
  const segments = relative.split('/')
  if (!relative || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) return undefined
  return relative
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const srcOf = (value: unknown): unknown => (plain(value) ? value.src : undefined)
const mediaUrlsOf = (attributes: Record<string, unknown>): unknown[] => {
  const variants = plain(attributes.variants) ? attributes.variants : {}
  return [attributes.src, srcOf(variants.thumb), srcOf(variants.preview), srcOf(variants.original)]
}
/** The raw id an unresolved list element keeps, or undefined for any other setting. */
const unresolvedIdOf = (setting: ViewSetting): string | undefined => {
  if (!setting.key.startsWith(UNRESOLVED_KEY_PREFIX) || !plain(setting.value)) return undefined
  return typeof setting.value.id === 'string' ? setting.value.id : undefined
}
const group = <T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = groups.get(key)
    if (list) list.push(row); else groups.set(key, [row])
  }
  return groups
}

/** The personal build's part of `model` and the media files it refers to (see the file header). */
export function filterReadModelForPersonalBuild(input: unknown): PersonalBuildReadModel {
  const model = readReadModel(input)
  const items = group(model.viewItems, (item) => item.scope)
  const settings = group(model.viewSettings, (setting) => setting.scope)
  /** The ids a list scope names: its items' targets and its unresolved elements' raw ids. */
  const membersOf = (scope: string): Set<string> => new Set([
    ...(items.get(scope) ?? []).map((item) => item.itemId),
    ...(settings.get(scope) ?? []).map(unresolvedIdOf).filter((id): id is string => id !== undefined),
  ])

  // Places and the projection's part-of rule: a place's country is the first part-of relation (by id) to a place.
  const places = new Map(model.entities.filter((entity) => entity.typeId === OFFICIAL.place).map((entity) => [entity.id, entity] as const))
  const parentOf = new Map<string, string>()
  for (const relation of model.relations) {
    if (relation.typeId === OFFICIAL.partOf && places.has(relation.toEntityId) && !parentOf.has(relation.fromEntityId)) parentOf.set(relation.fromEntityId, relation.toEntityId)
  }
  const isCity = (id: string) => places.get(id)?.fields.subtype === 'city'
  const countryOf = (id: string): string | undefined => (isCity(id) ? parentOf.get(id) : id)

  const hiddenCountries = membersOf(VIEW_SCOPES.hiddenCountries)
  const hiddenCities = membersOf(VIEW_SCOPES.hiddenCities)
  const hiddenMedia = new Set([...membersOf(VIEW_SCOPES.hiddenMedia), ...membersOf(VIEW_SCOPES.hiddenDroneMedia)])
  const inHiddenPlace = (id: string) => {
    const country = countryOf(id)
    return hiddenCities.has(id) || (country !== undefined && hiddenCountries.has(country))
  }
  // A Want to Go entry is hidden as the projection reads it: the first item of the scope (by id) for that entry.
  const wishHidden = new Map<string, boolean>()
  for (const item of items.get(VIEW_SCOPES.wantToGoHidden) ?? []) if (!wishHidden.has(item.itemId)) wishHidden.set(item.itemId, item.hidden)

  const removedEntry = (entry: LayerEntry): boolean => {
    const role = officialEntryRole(entry)
    if (role === 'footprint') return inHiddenPlace(entry.entityId)
    if (role === 'countryVisit') return hiddenCountries.has(entry.entityId)
    if (role === 'wish') return wishHidden.get(entry.id) === true
    return false
  }
  const addedCountries = (model.evidence as readonly Evidence[]).filter((evidence) => evidence.sourceId === V2_SOURCES.countryVisit)
  const removedAddedCountry = (evidence: Evidence) => hiddenCountries.has(evidence.recordId)
  const mediaEntities = (model.entities as readonly StoreEntity[]).filter((entity) => entity.typeId === OFFICIAL.media)
  const placeOfMedia = (entity: StoreEntity) => (typeof entity.fields.place === 'string' ? entity.fields.place : undefined)
  const assetOfMedia = (entity: StoreEntity) => (typeof entity.fields.asset === 'string' ? entity.fields.asset : undefined)
  const removedMediaEntity = (entity: StoreEntity) => {
    const asset = assetOfMedia(entity), place = placeOfMedia(entity)
    return (asset !== undefined && hiddenMedia.has(asset)) || (place !== undefined && inHiddenPlace(place))
  }

  const removedEntries = new Set(model.entries.filter(removedEntry).map((entry) => entry.id))
  const removedEvidence = new Set(addedCountries.filter(removedAddedCountry).map((evidence) => evidence.id))
  const removedMedia = mediaEntities.filter(removedMediaEntity)
  const removedMediaEntities = new Set(removedMedia.map((entity) => entity.id))
  const removedAssets = new Set(removedMedia.map(assetOfMedia).filter((id): id is string => id !== undefined))

  // Places: candidates are the hidden ones and those removed content referred to (with a city's country).
  const candidates = new Set([...hiddenCountries, ...hiddenCities])
  const keptRefs = new Set<string>()
  const addWithCountry = (target: Set<string>, placeId: string | undefined) => {
    if (placeId === undefined) return
    target.add(placeId)
    const parent = isCity(placeId) ? parentOf.get(placeId) : undefined
    if (parent !== undefined) target.add(parent)
  }
  for (const entry of model.entries) addWithCountry(removedEntries.has(entry.id) ? candidates : keptRefs, entry.entityId)
  for (const entity of mediaEntities) addWithCountry(removedMediaEntities.has(entity.id) ? candidates : keptRefs, placeOfMedia(entity))
  for (const evidence of addedCountries) addWithCountry(removedEvidence.has(evidence.id) ? candidates : keptRefs, evidence.recordId)
  // A kept place keeps its country (a city must point at an existing country).
  for (const id of places.keys()) {
    const parent = parentOf.get(id)
    if (!candidates.has(id) && parent !== undefined) keptRefs.add(parent)
  }
  const removedPlaces = new Set([...candidates].filter((id) => !keptRefs.has(id) && places.has(id)))

  // The editor state's references (the V2 filter's rules on its lists and maps).
  const dropsCountry = (id: string) => removedPlaces.has(id) || hiddenCountries.has(id)
  const dropsCity = (id: string) => removedPlaces.has(id) || inHiddenPlace(id)
  const droppedItems = new Set<string>()
  const droppedSettings = new Set<string>()
  const dropElements = (scope: string, drop: (id: string) => boolean) => {
    for (const item of items.get(scope) ?? []) if (drop(item.itemId)) droppedItems.add(item.id)
    for (const setting of settings.get(scope) ?? []) {
      const raw = unresolvedIdOf(setting)
      if (raw !== undefined && drop(raw)) droppedSettings.add(setting.id)
    }
  }
  const dropScope = (scope: string) => {
    for (const item of items.get(scope) ?? []) droppedItems.add(item.id)
    for (const setting of settings.get(scope) ?? []) droppedSettings.add(setting.id)
  }
  for (const scope of PERSONAL_BUILD_CLEARED_SCOPES) dropScope(scope)
  dropElements(VIEW_SCOPES.countryOrder, dropsCountry)
  dropElements(VIEW_SCOPES.addedCountryOrder, (id) => hiddenCountries.has(id))
  const maps: readonly [scope: string, dropKey: (id: string) => boolean, dropElement: (id: string) => boolean][] = [
    [VIEW_SCOPES.cityOrderByCountry, dropsCountry, dropsCity],
    [VIEW_SCOPES.mediaOrderByCity, dropsCity, (id) => removedAssets.has(id)],
    [VIEW_SCOPES.droneOrderByCity, dropsCity, (id) => removedAssets.has(id)],
  ]
  for (const [scope, dropKey, dropElement] of maps) {
    for (const setting of settings.get(scope) ?? []) {
      if (setting.key.startsWith(UNRESOLVED_KEY_PREFIX)) continue
      const listScope = mapListScope(scope, setting.key)
      const elements = [...(items.get(listScope) ?? []).map((item) => item.itemId), ...(settings.get(listScope) ?? []).map(unresolvedIdOf).filter((id) => id !== undefined)]
      // A key goes with its place, and when the filter emptied its list (a list that was empty stays).
      if (dropKey(setting.key) || (elements.length > 0 && elements.every(dropElement))) { droppedSettings.add(setting.id); dropScope(listScope) }
      else dropElements(listScope, dropElement)
    }
  }
  for (const setting of settings.get(VIEW_SCOPES.coverMediaByCity) ?? []) {
    const cover = setting.ref?.table === 'assets' ? setting.ref.id : typeof setting.value === 'string' ? setting.value : undefined
    if (dropsCity(setting.key) || (cover !== undefined && removedAssets.has(cover))) droppedSettings.add(setting.id)
  }

  const keep = (table: ReadModelTable, row: ReadModelRow): boolean => {
    switch (table) {
      case 'entities': return !removedPlaces.has(row.id) && !removedMediaEntities.has(row.id)
      case 'assets': return !removedAssets.has(row.id)
      case 'entries': return !removedEntries.has(row.id)
      case 'evidence': return !removedEvidence.has(row.id)
      case 'viewItems': return !droppedItems.has((row as ViewItem).id)
      case 'viewSettings': return !droppedSettings.has((row as ViewSetting).id)
      default: return true
    }
  }
  let selected = selectReadModel(model, keep)
  // Journeys whose sequences all went (their members were removed): the journey entity goes too.
  const sequenced = new Set(model.sequences.map((sequence) => sequence.entityId))
  const stillSequenced = new Set(selected.sequences.map((sequence) => sequence.entityId))
  const orphanJourneys = new Set(selected.entities.filter((entity) => entity.typeId === OFFICIAL.journey && sequenced.has(entity.id) && !stillSequenced.has(entity.id)).map((entity) => entity.id))
  if (orphanJourneys.size > 0) selected = selectReadModel(selected, (table, row) => table !== 'entities' || !orphanJourneys.has(row.id))

  const assets = new Map((selected.assets as readonly AssetReference[]).map((asset) => [asset.id, asset] as const))
  const files = new Set<string>()
  for (const entity of selected.entities as readonly StoreEntity[]) {
    if (entity.typeId !== OFFICIAL.media) continue
    const asset = assets.get(assetOfMedia(entity) ?? '')
    if (!asset) continue
    for (const url of mediaUrlsOf(asset.attributes)) {
      const file = mediaFileOf(url)
      if (file !== undefined) files.add(file)
    }
  }
  return { model: selected, mediaFiles: [...files].sort() }
}
