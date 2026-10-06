/** G2: complete validated V2 input -> isolated, read-only Store. No App switch,
 * IO, randomness, date repair, first-wins conflict handling, or private loader. */
import { emptyWorldStore, freezeCopy, readWorldStore, reject, shape, utcTimestamp, validateJson } from '../../worldgraph/store/schema.ts'
import type { JsonObject, JsonValue, LayerEntry, SourceDefinition, SourceRef, WorldStore } from '../../worldgraph/store/types.ts'
import { deriveTimeQueryContext } from '../derive/timeQueryContext.ts'
import { bridgeAllocator, type BridgeManifest } from './storeBridgeIdentity.ts'
import { readV2 } from './v2Reader.ts'
import { validateV2Files, type V2Files } from './v2Schema.ts'

export const BRIDGE = Object.freeze({
  place: 'v2:place', travel: 'v2:travel', planned: 'v2:planned', wish: 'v2:want-to-go',
  country: 'v2:country-visit', media: 'v2:media', journey: 'v2:journey', metadata: 'v2:metadata',
  footprint: 'bridge:footprints', wishlist: 'bridge:want-to-go',
})
export interface BridgeDocument {
  readonly format: 'starmap.v2-readonly-bridge'
  readonly version: 1
  readonly store: WorldStore
  readonly manifest: BridgeManifest
}
export interface BridgeOptions {
  readonly now: string
  readonly allocateId: () => string
  readonly manifest?: BridgeManifest
}
const title = (name: string) => ({ names: { en: name } })
export const bridgeSource = (sourceId: string, recordId: string): SourceRef => ({ sourceId, recordId, evidenceIds: [] })
export const bridgeRowId = (kind: string, id: string) => JSON.stringify([kind, id])
export function bridgeObject(value: unknown): JsonObject {
  validateJson(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('E_BRIDGE_SHAPE', '$.object')
  return value as JsonObject
}
export const omitBridgeKeys = (value: object, keys: readonly string[]): JsonObject =>
  bridgeObject(Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))))

/** V2's existing validator does not reject every duplicate source record. G2
 * rejects them before allocating IDs; different namespaces remain independent. */
function sourcePreflight(files: V2Files) {
  const seen = new Set<string>()
  const add = (namespace: string, id: string) => {
    opaqueSource(id)
    const key = JSON.stringify([namespace, id])
    if (seen.has(key)) reject('E_BRIDGE_SOURCE_COLLISION', '$.source')
    seen.add(key)
  }
  files.travel.records.forEach(row => add(row.status === 'planned' ? BRIDGE.planned : BRIDGE.travel, row.id))
  files.wantToGo.items.forEach(row => add(BRIDGE.wish, row.id))
  files.media.items.forEach(row => add(BRIDGE.media, row.id))
  files.editorState.addedCountries.forEach(row => add(BRIDGE.country, row.placeId))
}
function opaqueSource(id: string) {
  if (typeof id !== 'string' || !id.trim() || id.length > 512) reject('E_ID', '$.source.recordId')
}

export function bridgeV2(files: V2Files, options: BridgeOptions): BridgeDocument {
  validateJson(files); utcTimestamp(options.now, '$.now')
  shape(files, ['places', 'travel', 'wantToGo', 'editorState', 'media'])
  if (validateV2Files(files).length) reject('E_BRIDGE_V2_INVALID', '$.files')
  sourcePreflight(files)
  const data = readV2(files), allocator = bridgeAllocator(options.manifest, data.places.map(p => p.id), options.allocateId)
  const context = deriveTimeQueryContext(data)
  const store = {
    ...emptyWorldStore(),
    sources: Object.entries(BRIDGE).filter(([key]) => !['footprint', 'wishlist'].includes(key)).map(([, id]) => ({ id, revision: 0, title: title(id), origin: 'import' as const })) as SourceDefinition[],
    entityTypes: [
      { id: 'bridge:place', revision: 0, title: title('Place'), schemaVersion: 1 as const, fields: [{ key: 'subtype', kind: 'text' as const, required: true }, { key: 'parent', kind: 'entity_ref' as const }] },
      { id: 'bridge:journey', revision: 0, title: title('Journey'), schemaVersion: 1 as const, fields: [] },
      { id: 'bridge:media', revision: 0, title: title('Media'), schemaVersion: 1 as const, fields: [{ key: 'place', kind: 'entity_ref' as const, required: true }, { key: 'asset', kind: 'asset_ref' as const, required: true }] },
    ],
    layers: [BRIDGE.footprint, BRIDGE.wishlist].map(id => ({ id, revision: 0, title: title(id), schemaVersion: 1 as const, acceptedEntityTypes: ['bridge:place'], entryFields: [
      { key: 'date', kind: 'date_evidence' as const, required: true }, { key: 'note', kind: 'text' as const }, { key: 'hidden', kind: 'boolean' as const },
    ] })),
    entities: [] as WorldStore['entities'][number][], entries: [] as LayerEntry[],
    anchors: [] as WorldStore['anchors'][number][], assets: [] as WorldStore['assets'][number][],
    sequences: [] as WorldStore['sequences'][number][], evidence: [] as WorldStore['evidence'][number][],
    relationTypes: [{ id: 'bridge:part-of', revision: 0, title: title('Part of'), schemaVersion: 1 as const, fromTypes: ['bridge:place'], toTypes: ['bridge:place'], fields: [] }],
    relations: [] as WorldStore['relations'][number][], viewStates: [] as WorldStore['viewStates'][number][],
  }
  const metadata = {
    fileHeaders: {
      places: omitBridgeKeys(files.places, ['places']), travel: omitBridgeKeys(files.travel, ['records']),
      wantToGo: omitBridgeKeys(files.wantToGo, ['items']), media: omitBridgeKeys(files.media, ['items']),
    },
    editor: omitBridgeKeys(files.editorState, ['addedCountries']),
    order: {
      places: data.places.map(p => p.id), travel: files.travel.records.map(r => [r.status === 'planned' ? BRIDGE.planned : BRIDGE.travel, r.id]),
      wish: data.wantToGo.items.map(r => r.id), media: data.media.items.map(r => r.id), countries: data.editorState.addedCountries.map(r => r.placeId),
    },
  }
  store.sources = store.sources.map(s => s.id === BRIDGE.metadata ? { ...s, extensions: bridgeObject(metadata) } : s)
  for (const place of data.places) {
    const source = bridgeSource(BRIDGE.place, place.id)
    store.entities.push({ id: place.id, revision: 0, typeId: 'bridge:place', title: { names: place.names, ...(place.originalLanguage !== undefined ? { originalLanguage: place.originalLanguage } : {}) }, fields: { subtype: place.subtype, ...(place.partOf !== undefined ? { parent: place.partOf } : {}) }, source, visibility: 'private', extensions: { extra: omitBridgeKeys(place, ['id', 'names', 'originalLanguage', 'subtype', 'partOf', 'location']) } })
    if (place.location) store.anchors.push({ id: bridgeRowId('place-location', place.id), revision: 0, entityId: place.id, source, kind: 'location', ...place.location, precision: place.subtype === 'city' ? 'city' : 'region' })
    if (place.partOf) store.relations.push({ id: bridgeRowId('part-of', place.id), revision: 0, typeId: 'bridge:part-of', fromEntityId: place.id, toEntityId: place.partOf, fields: {}, source })
  }
  function entry(sourceId: string, recordId: string, entityId: string, raw: JsonObject, note: JsonValue | undefined, hidden: boolean | undefined, extra: JsonObject, dateKeys: readonly string[]) {
    const id = allocator.get('entry', sourceId, recordId), source = bridgeSource(sourceId, recordId)
    const date = { raw }, fields: JsonObject = { date, ...(note !== undefined ? { note } : {}), ...(hidden !== undefined ? { hidden } : {}) }
    store.entries.push({ id, revision: 0, entityId, layerId: sourceId === BRIDGE.wish || sourceId === BRIDGE.planned ? BRIDGE.wishlist : BRIDGE.footprint, fields, source, createdAt: options.now, updatedAt: options.now, extensions: { extra, dateKeys } })
    store.anchors.push({ id: bridgeRowId('entry-date', id), revision: 0, entityId, source, kind: 'time', precision: 'exact', date })
  }
  for (const record of files.travel.records) {
    const raw: Record<string, JsonValue> = {}
    for (const [key, target] of [['start_date', 'startDate'], ['end_date', 'endDate'], ['year', 'year']]) if (Object.hasOwn(record, key)) raw[target] = bridgeObject(record)[key]
    const note = typeof record.notes === 'string' ? record.notes : undefined
    const hidden = typeof record.hiddenFromHome === 'boolean' ? record.hiddenFromHome : undefined
    entry(record.status === 'planned' ? BRIDGE.planned : BRIDGE.travel, record.id, record.placeId, raw, note, hidden, omitBridgeKeys(record, ['id', 'placeId', 'start_date', 'end_date', 'year', ...(note !== undefined ? ['notes'] : []), ...(hidden !== undefined ? ['hiddenFromHome'] : [])]), Object.keys(raw))
  }
  for (const item of data.wantToGo.items) entry(BRIDGE.wish, item.id, item.placeId, { startDate: item.addedAt }, item.note, item.hidden, omitBridgeKeys(item, ['id', 'placeId', 'addedAt', 'note', 'hidden']), ['startDate'])
  for (const country of data.editorState.addedCountries) {
    // Even empty containers remain as source evidence, without a fake visit.
    store.evidence.push({ id: bridgeRowId('country-container', country.placeId), revision: 0, sourceId: BRIDGE.country, recordId: country.placeId, attributes: bridgeObject(country) })
    if (country.visitedDate !== undefined && country.visitedDate !== null && country.visitedDate !== '') entry(BRIDGE.country, country.placeId, country.placeId, { startDate: country.visitedDate }, undefined, undefined, omitBridgeKeys(country, ['placeId', 'visitedDate']), ['startDate'])
  }
  for (const item of data.media.items) {
    const assetId = bridgeRowId('media-asset', item.id), source = bridgeSource(BRIDGE.media, item.id)
    store.assets.push({ id: assetId, revision: 0, source, attributes: omitBridgeKeys(item, ['id', 'placeId', 'title']) })
    store.entities.push({ id: allocator.get('media', BRIDGE.media, item.id), revision: 0, typeId: 'bridge:media', title: item.title ?? { names: {} }, fields: { place: item.placeId, asset: assetId }, source, visibility: 'private', extensions: { hasTitle: Object.hasOwn(item, 'title') } })
  }
  const journeys = new Map<string, typeof data.travel.records>()
  for (const record of data.travel.records) {
    if (record.status === 'planned' || typeof record.journeyId !== 'string' || !record.journeyId.trim()) continue
    const group = journeys.get(record.journeyId) ?? []; group.push(record); journeys.set(record.journeyId, group)
  }
  for (const [recordId, records] of journeys) {
    const id = allocator.get('journey', BRIDGE.journey, recordId), source = bridgeSource(BRIDGE.journey, recordId)
    store.entities.push({ id, revision: 0, typeId: 'bridge:journey', title: { names: {} }, fields: {}, source, visibility: 'private' })
    const ordered = [...records].sort((a, b) => `${a.start_date}-${a.id}`.localeCompare(`${b.start_date}-${b.id}`))
    store.sequences.push({ id: bridgeRowId('journey-sequence', recordId), revision: 0, entityId: id, source, entryIds: ordered.map(r => allocator.get('entry', BRIDGE.travel, r.id)) })
  }
  for (const layerId of [BRIDGE.footprint, BRIDGE.wishlist]) {
    const entries = store.entries.filter(e => e.layerId === layerId)
    const hiddenEntryIds = entries.filter(e => {
      const kind = e.source.sourceId === BRIDGE.wish ? 'want-to-go' : e.source.sourceId === BRIDGE.planned ? 'planned' : e.source.sourceId === BRIDGE.country ? 'country-visit' : 'travel'
      return context.records.some(r => r.sourceKind === kind && r.recordId === e.source.recordId && !r.browsable)
    }).map(e => e.id)
    store.viewStates.push({ id: bridgeRowId('view', layerId), revision: 0, layerId, orderedEntryIds: entries.map(e => e.id), hiddenEntryIds })
  }
  return freezeCopy({ format: 'starmap.v2-readonly-bridge', version: 1, store: readWorldStore(store), manifest: allocator.finish() })
}
