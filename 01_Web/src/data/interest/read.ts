import type { ReadModel } from '../../worldgraph/readModel/types.ts'
import type { FormalLayer } from '../../worldgraph/store/formal.ts'
import type { JsonValue, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import { OFFICIAL, VIEW_SCOPES } from '../store/officialDefinitions.ts'
import { interestHiddenScope, interestKindOf, interestLayerOrder, interestTemplates, isInterestLayer, type InterestKind } from './templates.ts'

export type InterestPlace = {
  readonly entity: StoreEntity
  readonly parentId?: string
  readonly location?: { readonly lat: number; readonly lng: number }
}
export type InterestRecord = {
  readonly entity: StoreEntity
  readonly kind: InterestKind
  readonly layer: FormalLayer
  readonly entry: LayerEntry
  readonly place?: InterestPlace
  readonly hidden: boolean
}
export type InterestPin = {
  readonly id: string
  readonly title: string
  readonly kind: InterestKind
  readonly lat: number
  readonly lng: number
}
export type InterestFilters = { layer: string; status: string; query: string; location: string; date: string }
export const allInterests: InterestFilters = { layer: '', status: '', query: '', location: '', date: '' }
export const interestTitle = (row: { readonly title: StoreEntity['title'] }, zh: boolean) =>
  (zh ? row.title.names['zh-Hans'] ?? row.title.names.zh : row.title.names.en)
  ?? Object.values(row.title.names)[0] ?? ''
export const fieldText = (row: { readonly fields: StoreEntity['fields'] }, key: string) => {
  const value = row.fields[key]
  return typeof value === 'string' ? value : ''
}

export function orderedInterestLayers(rows: readonly FormalLayer[], saved: JsonValue | undefined): FormalLayer[] {
  const layers = rows.filter((layer) => isInterestLayer(layer.id) && interestKindOf(layer.acceptedEntityTypes[0]))
  if (!Array.isArray(saved)) return layers
  const byId = new Map(layers.map((layer) => [layer.id, layer]))
  const ordered: FormalLayer[] = []
  for (const id of saved) {
    if (typeof id !== 'string') continue
    const layer = byId.get(id)
    if (!layer) continue
    ordered.push(layer)
    byId.delete(id)
  }
  return [...ordered, ...byId.values()]
}

export function readInterests(model: ReadModel) {
  const order = model.viewSettings.find((row) => row.scope === interestLayerOrder.scope && row.key === interestLayerOrder.key)
  const layers = orderedInterestLayers(model.layers, order?.value)
  const layerById = new Map(layers.map((layer) => [layer.id, layer]))
  const entities = model.entities.filter((entity) => interestKindOf(entity.typeId))
  const entityById = new Map(entities.map((entity) => [entity.id, entity]))
  const hiddenPlaces = new Set(model.viewItems.filter((item) => item.hidden && item.itemTable === 'entities'
    && (item.scope === VIEW_SCOPES.hiddenCountries || item.scope === VIEW_SCOPES.homeHiddenCountries
      || item.scope.startsWith(VIEW_SCOPES.hiddenCities + '/'))).map((item) => item.itemId))
  const hiddenEntries = new Set(model.viewItems.filter((item) => item.scope === interestHiddenScope && item.hidden).map((item) => item.itemId))
  const locations = new Map<string, InterestPlace['location']>()
  for (const anchor of model.anchors) {
    if (anchor.kind !== 'location' || locations.has(anchor.entityId)) continue
    locations.set(anchor.entityId, anchor.precision === 'hidden' ? undefined : { lat: anchor.lat, lng: anchor.lng })
  }
  const parents = new Map<string, string>()
  for (const relation of model.relations) {
    if (relation.typeId === OFFICIAL.partOf && !parents.has(relation.fromEntityId)) parents.set(relation.fromEntityId, relation.toEntityId)
  }
  const places: InterestPlace[] = model.entities.filter((entity) => entity.typeId === OFFICIAL.place).map((entity) => {
    const parentId = parents.get(entity.id)
    const hidden = hiddenPlaces.has(entity.id) || (parentId !== undefined && hiddenPlaces.has(parentId))
    return { entity, parentId, location: hidden ? undefined : locations.get(entity.id) }
  })
  const placeById = new Map(places.map((place) => [place.entity.id, place]))
  const records: InterestRecord[] = []
  for (const entry of model.entries) {
    const layer = layerById.get(entry.layerId)
    const entity = entityById.get(entry.entityId)
    const kind = entity && interestKindOf(entity.typeId)
    if (!layer || !entity || !kind) continue
    const explicit = fieldText(entry, interestTemplates[kind].placeField)
    const placeId = explicit || (kind === 'movie' ? '' : fieldText(entity, 'placeId'))
    records.push({ entity, kind, layer, entry, place: placeById.get(placeId), hidden: hiddenEntries.has(entry.id) })
  }
  return { layers, entities, places, records }
}

export function filterInterests(records: readonly InterestRecord[], filters: InterestFilters) {
  const query = filters.query.trim().toLowerCase()
  return records.filter(({ layer, entry, entity, place, hidden }) => {
    if (filters.layer && layer.id !== filters.layer) return false
    if (filters.status === 'hidden' ? !hidden : filters.status && (hidden || entry.fields.status !== filters.status)) return false
    if (filters.date && !fieldText(entry, 'date').startsWith(filters.date)) return false
    if (filters.location === 'none' ? place : filters.location && place?.entity.id !== filters.location && place?.parentId !== filters.location) return false
    if (!query) return true
    return [...Object.values(entity.title.names), ...Object.values(entity.fields), fieldText(entry, 'note'),
      ...Object.values(place?.entity.title.names ?? {})].some((value) => typeof value === 'string' && value.toLowerCase().includes(query))
  })
}

/** One map entity per visible record. An unset viewing location never falls back to the film's metadata. */
export function interestPins(records: readonly InterestRecord[], zh: boolean): InterestPin[] {
  return records.flatMap(({ entity, entry, kind, place, hidden }) => !hidden && place?.location
    ? [{ id: entry.id, title: interestTitle(entity, zh), kind, ...place.location }] : [])
}
