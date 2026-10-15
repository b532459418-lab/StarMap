/**
 * The personal build carries only what its pages can show (batch 7, review S3, the author's option A).
 *
 * `vite build --mode personal` inlines the five V2 files into the private-data virtual module and copies the private
 * media next to the bundle. Before this, hidden countries, cities, Want to Go entries, photos and drone media, with
 * their file names and coordinates, all went along. `filterForPersonalBuild` removes them first. Only the build calls
 * it (local-editor-plugin.mjs, `command === 'build' && profile === 'personal'`): the dev server keeps serving
 * everything, because the editor needs the hidden entries to restore or delete them for good.
 *
 * What is hidden (the editor's two kinds of hiding):
 * - a Want to Go entry with `hidden: true`;
 * - editor state: `hiddenCountryIds`, `hiddenCityIds`, `hiddenMediaIds`, `hiddenDroneMediaIds`.
 *
 * What goes, and why (the derivation in src/data/canonical/derive.ts and the Core adapters decides what a page shows):
 * - Want to Go entries with `hidden: true`. The map, the cards and Collection without the editor never show them.
 * - Visited records (status other than `planned`) in a hidden city, or in any city of a hidden country: derive drops
 *   them before countries, cities, Journey days and routes are formed. Planned records stay: they reach the Want to
 *   Go layer whatever the editor hides.
 * - Media items that are hidden themselves, or that belong to a hidden city or to a city of a hidden country: photos
 *   and drone media are shown only from the card of a city that is on the map, and those cities never are.
 * - `addedCountries` entries of hidden countries (derive leaves them out of the country list).
 * - Places: a hidden country or city, and every place only removed content referred to (with the country of a removed
 *   city), unless something kept still refers to it (a kept record, Want to Go entry, media item or added country, or a
 *   kept city's `partOf`). Places nothing referred to in the first place stay as they are.
 * - References to anything removed: ids in `countryOrder`, `cityOrderByCountry` (keys and values), `mediaOrderByCity`,
 *   `coverMediaByCity`, `droneOrderByCity` and the display lists of the travel file; entries of the editor state that
 *   belong to a hidden country or city. A list or map entry that the filter emptied is dropped.
 * - The four hidden lists become empty: everything they named is gone or no longer has an effect.
 *
 * Visible entries keep every field, including ones the pages never read (for example a visible photo's
 * `originalFileName`); that is a separate decision.
 *
 * The result passes `validateV2Files` whenever the input does. The input must pass it: invalid files throw
 * `V2FilesInvalidError`, so a build never inlines files it could not filter. A file that is missing (undefined) stays
 * missing. Without anything hidden, the five values come back unchanged (the same JSON text).
 *
 * `mediaFiles` lists the files under `media/user/` that the kept media items refer to (`src` and every variant), as
 * POSIX paths relative to `media/user/`, sorted; URLs outside `/media/user/` and paths that leave it are skipped.
 */

import { completeV2Files, V2FilesInvalidError } from '../src/data/canonical/canonicalForInputs.ts'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'

const MEDIA_PREFIX = '/media/user/'
const PAGE_ORIGIN = 'http://starmap.invalid'

/**
 * A media URL → its path relative to `media/user/` as the page requests it and the dev server resolves it (the URL's
 * path, percent-decoded), or undefined: another origin, outside `/media/user/`, or a segment that is empty, `.`, `..`
 * or holds a backslash or NUL.
 */
export const mediaFileOf = (src) => {
  if (typeof src !== 'string') return undefined
  let pathname
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

const mediaUrlsOf = (item) => [item.src, item.variants?.thumb?.src, item.variants?.preview?.src, item.variants?.original?.src]

/** `array` without the entries `drop` names; the same array when nothing goes. */
const without = (array, drop) => {
  const kept = array.filter((value) => !drop(value))
  return kept.length === array.length ? array : kept
}

/** A record keyed by place id: keys `dropKey` names go, values pass through `mapValue` (undefined drops the key). */
const filterKeyed = (record, dropKey, mapValue) => {
  const result = {}
  let changed = false
  for (const [key, value] of Object.entries(record)) {
    const next = dropKey(key) ? undefined : mapValue(value)
    if (next === undefined) { changed = true; continue }
    if (next !== value) changed = true
    result[key] = next
  }
  return changed ? result : record
}

/** A list value of a keyed record: filtered, and dropped when the filter emptied it. */
const filteredList = (list, drop) => {
  const kept = without(list, drop)
  return kept.length === 0 && list.length > 0 ? undefined : kept
}

export function filterForPersonalBuild(v2Files) {
  const inputs = v2Files ?? {}
  const files = completeV2Files(inputs)
  const problems = validateV2Files(files)
  if (problems.length > 0) throw new V2FilesInvalidError(problems)
  const { places: placesFile, travel, wantToGo, editorState: state, media } = files

  const placeById = new Map(placesFile.places.map((place) => [place.id, place]))
  const countryOf = (placeId) => {
    const place = placeById.get(placeId)
    return place?.subtype === 'city' ? place.partOf : placeId
  }
  const hiddenCountries = new Set(state.hiddenCountryIds)
  const hiddenCities = new Set(state.hiddenCityIds)
  const hiddenMedia = new Set([...state.hiddenMediaIds, ...state.hiddenDroneMediaIds])
  const inHiddenPlace = (cityId) => hiddenCities.has(cityId) || hiddenCountries.has(countryOf(cityId))

  const removedRecord = (record) => record.status !== 'planned' && inHiddenPlace(record.placeId)
  const removedItem = (item) => item.hidden === true
  const removedMediaItem = (item) => hiddenMedia.has(item.id) || inHiddenPlace(item.placeId)
  const removedAddedCountry = (entry) => hiddenCountries.has(entry.placeId)

  // Places: candidates are the hidden ones and those removed content referred to (with a city's country).
  const candidates = new Set([...hiddenCountries, ...hiddenCities])
  const addWithCountry = (target, placeId) => {
    target.add(placeId)
    const place = placeById.get(placeId)
    if (place?.subtype === 'city' && place.partOf !== undefined) target.add(place.partOf)
  }
  const keptRefs = new Set()
  for (const record of travel.records) addWithCountry(removedRecord(record) ? candidates : keptRefs, record.placeId)
  for (const item of wantToGo.items) addWithCountry(removedItem(item) ? candidates : keptRefs, item.placeId)
  for (const item of media.items) addWithCountry(removedMediaItem(item) ? candidates : keptRefs, item.placeId)
  for (const entry of state.addedCountries) addWithCountry(removedAddedCountry(entry) ? candidates : keptRefs, entry.placeId)
  // A kept place keeps its country (a city must point at an existing country).
  for (const place of placesFile.places) {
    if (!candidates.has(place.id) && place.subtype === 'city' && place.partOf !== undefined) keptRefs.add(place.partOf)
  }
  const removedPlaces = new Set([...candidates].filter((id) => !keptRefs.has(id) && placeById.has(id)))
  const removedMediaIds = new Set(media.items.filter(removedMediaItem).map((item) => item.id))

  const removedPlace = (id) => removedPlaces.has(id)
  const editorDropsCountry = (id) => removedPlace(id) || hiddenCountries.has(id)
  const editorDropsCity = (id) => removedPlace(id) || hiddenCities.has(id) || hiddenCountries.has(countryOf(id))
  const removedMediaId = (id) => removedMediaIds.has(id)

  const places = without(placesFile.places, (place) => removedPlace(place.id))
  const display = travel.display
  const filteredDisplay = {
    ...display,
    homeHiddenCountryIds: without(display.homeHiddenCountryIds, removedPlace),
    originCountryIds: without(display.originCountryIds, removedPlace),
    regionCountryIds: without(display.regionCountryIds, removedPlace),
    navigationHiddenCityIds: without(display.navigationHiddenCityIds, removedPlace),
  }
  const filtered = {
    places: places === placesFile.places ? placesFile : { ...placesFile, places },
    travel: { ...travel, display: filteredDisplay, records: without(travel.records, removedRecord) },
    wantToGo: { ...wantToGo, items: without(wantToGo.items, removedItem) },
    editorState: {
      ...state,
      addedCountries: without(state.addedCountries, removedAddedCountry),
      countryOrder: without(state.countryOrder, editorDropsCountry),
      hiddenCountryIds: [],
      cityOrderByCountry: filterKeyed(state.cityOrderByCountry, editorDropsCountry, (cityIds) => filteredList(cityIds, editorDropsCity)),
      hiddenCityIds: [],
      mediaOrderByCity: filterKeyed(state.mediaOrderByCity, editorDropsCity, (ids) => filteredList(ids, removedMediaId)),
      hiddenMediaIds: [],
      coverMediaByCity: filterKeyed(state.coverMediaByCity, editorDropsCity, (id) => (removedMediaId(id) ? undefined : id)),
      droneOrderByCity: filterKeyed(state.droneOrderByCity, editorDropsCity, (ids) => filteredList(ids, removedMediaId)),
      hiddenDroneMediaIds: [],
    },
    media: { ...media, items: without(media.items, removedMediaItem) },
  }

  const mediaFiles = [...new Set(filtered.media.items.flatMap((item) => mediaUrlsOf(item).map(mediaFileOf)).filter((file) => file !== undefined))].sort()
  const result = Object.fromEntries(V2_FILE_KEYS.map((key) => [key, inputs[key] === undefined ? undefined : filtered[key]]))
  return { files: result, mediaFiles }
}
