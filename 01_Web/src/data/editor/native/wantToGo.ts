/**
 * The three want-to-go endpoints as store-native writes (3C-5 C1, design 3C-5 §3; the decisions are ../rules/, the same
 * as the V2 write functions of v2write/wantToGo.ts, retired in 3C-5 E):
 * - `POST /wanttogo`: the place by id, or by name (the country by ISO, found or created from the catalog; a city only
 *   when there is no candidate, or with `createNew`); E_WTG_EXISTS; a new entry (addedAt, note) appended to
 *   wantToGoOrder; new places appended to placeOrder.
 * - `POST /wanttogo/update`: the entry's note; the item's row in wantToGoHidden added or removed.
 * - `POST /wanttogo/delete`: every id must be hidden; the entries and their view rows go; then the places nobody refers
 *   to any more (the item's place, and a city's country), where a reference is any row of any layer (D3): an entry, an
 *   entity field, a relation (other than the place's own part-of), a view item (other than its own placeOrder row) or
 *   setting, and a cover keyed by the place.
 * New rows have the source `starmap:user` with the row's id as record id, and UUIDv7 ids (view rows `<scope>#<UUIDv7>`);
 * no V2-only value is written (design §9 change 2: no `source: 'local-editor'`). The responses are those of the V2
 * functions (the item in the shape the page knows).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import { positionBetween } from '../../../worldgraph/store/position.ts'
import type { LayerEntry, StoreAnchor } from '../../../worldgraph/store/types.ts'
import { namesOf, reconstructWantToGoItem } from '../../canonical/reconstruct.ts'
import type { CanonicalPlace, CanonicalWantToGoItem } from '../../canonical/types.ts'
import type { WantToGoItem } from '../../derive/wantToGo.ts'
import { OFFICIAL, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import { wishValueOf } from '../../store/projectCanonical.ts'
import { placeAnchor, viewItemRow, wantToGoEntry } from '../../store/v2RecordRows.ts'
import { fail } from '../errors.ts'
import { chooseCountry, requireNoCityCandidates } from '../rules/places.ts'
import {
  parseAddWantToGo, parseDeleteWantToGo, parseUpdateWantToGo, requireAllHidden, requireNotListed, wishNotFound,
} from '../rules/wantToGo.ts'
import { commandBatch, viewRowId, type CommandBatch } from './batch.ts'
import { createPlace, placeKeys, prunePlaces, referencesOf, rowOf, userSource } from './places.ts'
import { appendToOriginalOrder } from './originalOrder.ts'
import type { NativeWrite } from './routes.ts'

const S = VIEW_SCOPES
const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b)

/** The page's shape of an item: the place and its country from the reader, or the places this write creates. */
function itemV1(reader: OfficialReader, item: CanonicalWantToGoItem, created: readonly CanonicalPlace[] = []): WantToGoItem {
  const known = new Map(created.map((place) => [place.id, place] as const))
  const placeOf = (id: string | undefined) => (id === undefined ? undefined : known.get(id) ?? reader.place(id))
  const place = placeOf(item.placeId)
  const country = place?.subtype === 'city' ? placeOf(place.partOf) : undefined
  const index = new Map<string, CanonicalPlace>()
  for (const value of [place, country]) if (value) index.set(value.id, value)
  return reconstructWantToGoItem(item, index)
}

/** Every want-to-go item's entry, for its order (without a row: by creation time and id). */
const wishKeys = (reader: OfficialReader) => () =>
  reader.index.entriesOfLayer(OFFICIAL.wantToGo).filter((entry) => reader.roleOf(entry) === 'wish')
    .map((entry) => ({ id: entry.id, after: [entry.createdAt, entry.id] as const }))

// ---------------------------------------------------------------------------
// POST /wanttogo
// ---------------------------------------------------------------------------

export const addWantToGoWrite = Object.freeze<NativeWrite>({
  status: 201,
  plan(reader, input, ctx) {
    const request = parseAddWantToGo(input, ctx.now)
    const { place, createNew, note, addedAt } = request
    const batch = commandBatch()
    const created: CanonicalPlace[] = []
    let target: CanonicalPlace | undefined
    if (request.placeId !== undefined) {
      target = reader.place(request.placeId)
      if (!target) fail('E_UNKNOWN_PLACE_REF')
    }
    if (place) {
      const choice = chooseCountry(reader.countries(), place.countryCode, ctx.countryCatalog)
      let country: CanonicalPlace
      if ('found' in choice) country = choice.found
      else {
        const { code, entry } = choice.create
        country = {
          id: ctx.newId(), subtype: 'country', names: namesOf(entry.nameZh, entry.nameEn), externalIds: { iso3166Alpha2: code },
          location: { lat: entry.centerLat, lng: entry.centerLng },
        }
        created.push(country)
      }
      target = country
      if (place.kind === 'city') {
        const cities = 'found' in choice ? [country, ...reader.citiesOf(country.id)] : [country]
        requireNoCityCandidates(cities, country.id, {
          names: { zh: place.nameZh, en: place.nameEn }, matchNames: { zh: place.givenZh, en: place.nameEn }, location: place.location, createNew,
        })
        target = {
          id: ctx.newId(), subtype: 'city', names: namesOf(place.nameZh, place.nameEn), partOf: country.id,
          ...(place.location !== undefined ? { location: { lat: place.location.lat, lng: place.location.lng } } : {}),
        }
        created.push(target)
      } else if ('found' in choice && country.location === undefined && place.location !== undefined) {
        // A country without a location gets the one given (fillMissingLocation).
        const anchorId = ctx.newId()
        target = { ...country, location: { lat: place.location.lat, lng: place.location.lng } }
        created.push(target)
        batch.create('anchors', { ...placeAnchor(target, anchorId)!, source: userSource(anchorId) } satisfies StoreAnchor)
      }
    }
    const targetId = target?.id ?? fail('E_UNKNOWN_PLACE_REF')
    requireNotListed(reader.wishesOn(targetId).length > 0, targetId)

    for (const value of created) if (!reader.place(value.id)) createPlace(batch, value, ctx.newId)
    const entryId = ctx.newId()
    const now = ctx.now.toISOString()
    const { entry } = wantToGoEntry({ id: entryId, placeId: targetId, ...(note ? { note } : {}), addedAt, hidden: false }, entryId, { createdAt: now, updatedAt: now })
    batch.create('entries', { ...entry, source: userSource(entryId) } satisfies LayerEntry)
    const newPlaces = created.filter((value) => !reader.place(value.id)).map((value) => value.id)
    if (newPlaces.length) appendToOriginalOrder(reader, batch, ctx.newId, { scope: S.placeOrder, table: 'entities', keys: placeKeys(reader), added: newPlaces })
    appendToOriginalOrder(reader, batch, ctx.newId, { scope: S.wantToGoOrder, table: 'entries', keys: wishKeys(reader), added: [entryId], layerId: OFFICIAL.wantToGo })

    const item: CanonicalWantToGoItem = { id: entryId, placeId: targetId, ...(note ? { note } : {}), addedAt, hidden: false }
    return { commands: batch.commands(), result: { id: entryId, item: itemV1(reader, item, created) } }
  },
})

// ---------------------------------------------------------------------------
// POST /wanttogo/update
// ---------------------------------------------------------------------------

/** The hidden row of an entry follows the item's flag (diffV2's flag): created when hidden, removed when shown. */
function hiddenFlag(reader: OfficialReader, batch: CommandBatch, entryId: string, hidden: boolean, newId: () => string): void {
  const scope = S.wantToGoHidden
  const row = reader.viewItem(scope, 'entries', entryId)
  if (!hidden) { if (row) batch.remove('viewItems', row); return }
  const target = { table: 'entries' as const, id: entryId }
  if (row) batch.update('viewItems', row, viewItemRow(scope, row.id, target, row.position, true, OFFICIAL.wantToGo))
  else batch.create('viewItems', viewItemRow(scope, viewRowId(scope, newId), target, positionBetween(), true, OFFICIAL.wantToGo))
}

export const updateWantToGoWrite = Object.freeze<NativeWrite>({
  status: 200,
  plan(reader, input, ctx) {
    const request = parseUpdateWantToGo(input)
    const wish = reader.wish(request.id) ?? wishNotFound(request.id)
    const { entry } = wish
    const batch = commandBatch()
    const fields = { ...entry.fields }
    if (request.note) {
      if (request.note.value) fields.note = request.note.value
      else delete fields.note
    }
    const hidden = request.hidden ?? wish.item.hidden
    const next = { ...entry, fields }
    const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(entry.fields)
    if (fieldsChanged) batch.update('entries', entry, { ...next, updatedAt: later(ctx.now.toISOString(), entry.updatedAt) })
    if (fieldsChanged || hidden !== wish.item.hidden) hiddenFlag(reader, batch, entry.id, hidden, ctx.newId)
    const item = wishValueOf(next, hidden) as unknown as CanonicalWantToGoItem
    return { commands: batch.commands(), result: { item: itemV1(reader, item) } }
  },
})

// ---------------------------------------------------------------------------
// POST /wanttogo/delete
// ---------------------------------------------------------------------------

export const deleteWantToGoWrite = Object.freeze<NativeWrite>({
  status: 200,
  plan(reader, input) {
    const ids = parseDeleteWantToGo(input)
    requireAllHidden(ids, (id) => reader.wish(id)?.item.hidden === true)
    const references = referencesOf(reader)
    const batch = commandBatch()
    const candidates: string[] = []
    for (const id of ids) {
      const { entry } = reader.wish(id)!
      candidates.push(entry.entityId)
      const parent = reader.place(entry.entityId)?.partOf
      if (parent !== undefined) candidates.push(parent)
      // Its view rows (order, hidden, any other), then the entry.
      for (const ref of references('entries', entry.id)) {
        if (ref.fromTable === 'viewItems' || ref.fromTable === 'viewSettings') batch.remove(ref.fromTable, rowOf(reader, ref.fromTable, ref.fromId))
      }
      batch.remove('entries', entry)
    }
    prunePlaces(reader, batch, candidates)
    return { commands: batch.commands(), result: { deletedIds: ids } }
  },
})

