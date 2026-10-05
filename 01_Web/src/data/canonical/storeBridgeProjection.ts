/** G2 diagnostic compatibility projection. Rebuilds V2 from structured facts,
 * then runs the existing pure App projectors. This is NOT a new viewer or an
 * enabled App loader, and never writes the reconstructed values to disk. */
import { freezeCopy, jsonKey, readWorldStore, reject, shape, validateJson } from '../../worldgraph/store/schema.ts'
import type { JsonObject, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import type { OriginalRouteCandidate } from '../../worldgraph/timeQuery.ts'
import { buildBaseline } from '../derive/baseline.ts'
import { deriveTimeQueryContext } from '../derive/timeQueryContext.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { BRIDGE, bridgeObject, bridgeRowId, type BridgeDocument } from './storeBridge.ts'
import { identityKey, readBridgeManifest } from './storeBridgeIdentity.ts'
import { readV2 } from './v2Reader.ts'
import { validateV2Files, type V2Files } from './v2Schema.ts'

export function restoreBridgeV2(document: BridgeDocument): V2Files {
  validateJson(document)
  shape(document, ['format', 'version', 'store', 'manifest'])
  if (document.format !== 'starmap.v2-readonly-bridge' || document.version !== 1) reject('E_BRIDGE_VERSION', '$.bridge')
  const store = readWorldStore(document.store), manifest = readBridgeManifest(document.manifest)
  const ids = new Map(manifest.identities.map(row => [identityKey(row), row.id]))
  for (const row of [...store.entries, ...store.entities.filter(e => e.typeId !== 'bridge:place')]) {
    const kind = 'layerId' in row ? 'entry' : row.typeId === 'bridge:journey' ? 'journey' : 'media'
    if (ids.get(identityKey({ kind, ...row.source })) !== row.id) reject('E_BRIDGE_MANIFEST_MISMATCH', '$.bridge')
  }
  const metadata = bridgeObject(store.sources.find(s => s.id === BRIDGE.metadata)?.extensions)
  const headers = bridgeObject(metadata.fileHeaders), order = bridgeObject(metadata.order)
  const entries = new Map(store.entries.map(e => [JSON.stringify([e.source.sourceId, e.source.recordId]), e]))
  const entities = new Map(store.entities.map(e => [e.id, e]))
  const assets = new Map(store.assets.map(e => [e.id, e]))
  const evidence = new Map(store.evidence.map(e => [e.id, e]))
  const consumedEntries = new Set<string>(), consumedEntities = new Set<string>(), consumedAssets = new Set<string>(), consumedEvidence = new Set<string>()
  function strings(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string') || new Set(value).size !== value.length) reject('E_BRIDGE_ORDER', '$.order')
    return value as string[]
  }
  function getEntry(namespace: string, id: string): LayerEntry {
    const row = entries.get(JSON.stringify([namespace, id]))
    if (!row || consumedEntries.has(row.id)) reject('E_BRIDGE_RECORD', '$.entries')
    consumedEntries.add(row.id); return row
  }
  function extra(row: StoreEntity | LayerEntry): JsonObject { return bridgeObject(row.extensions?.extra) }
  function dates(row: LayerEntry): JsonObject { return bridgeObject(bridgeObject(row.fields.date).raw) }
  const places = strings(order.places).map(id => {
    const row = entities.get(id)
    if (!row || row.typeId !== 'bridge:place' || row.source.sourceId !== BRIDGE.place || row.source.recordId !== id) reject('E_BRIDGE_RECORD', '$.places')
    consumedEntities.add(id)
    const anchor = store.anchors.find(a => a.id === bridgeRowId('place-location', id))
    return {
      ...extra(row), id, names: row.title.names,
      ...(row.title.originalLanguage !== undefined ? { originalLanguage: row.title.originalLanguage } : {}),
      subtype: row.fields.subtype, ...(row.fields.parent !== undefined ? { partOf: row.fields.parent } : {}),
      ...(anchor?.kind === 'location' ? { location: { lat: anchor.lat, lng: anchor.lng, ...(anchor.approximate !== undefined ? { approximate: anchor.approximate } : {}) } } : {}),
    }
  })
  if (!Array.isArray(order.travel)) reject('E_BRIDGE_ORDER', '$.order.travel')
  const records = order.travel.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || ![BRIDGE.travel, BRIDGE.planned].includes(pair[0] as typeof BRIDGE.travel) || typeof pair[1] !== 'string') reject('E_BRIDGE_ORDER', '$.order.travel')
    const row = getEntry(pair[0] as string, pair[1]), raw = dates(row)
    const result: JsonObject = {
      ...extra(row), id: row.source.recordId, placeId: row.entityId,
      ...Object.fromEntries([['startDate', 'start_date'], ['endDate', 'end_date'], ['year', 'year']].filter(([key]) => Object.hasOwn(raw, key)).map(([key, target]) => [target, raw[key]])),
      ...(row.fields.note !== undefined ? { notes: row.fields.note } : {}),
      ...(row.fields.hidden !== undefined ? { hiddenFromHome: row.fields.hidden } : {}),
    }
    if ((result.status === 'planned') !== (pair[0] === BRIDGE.planned)) reject('E_BRIDGE_SOURCE_COLLISION', '$.record.status')
    return result
  })
  const items = strings(order.wish).map(id => {
    const row = getEntry(BRIDGE.wish, id)
    return { ...extra(row), id, placeId: row.entityId, addedAt: dates(row).startDate, hidden: row.fields.hidden, ...(row.fields.note !== undefined ? { note: row.fields.note } : {}) }
  })
  const addedCountries = strings(order.countries).map(id => {
    const proof = evidence.get(bridgeRowId('country-container', id))
    if (!proof || proof.sourceId !== BRIDGE.country || proof.recordId !== id) reject('E_BRIDGE_RECORD', '$.countries')
    consumedEvidence.add(proof.id)
    const visit = entries.get(JSON.stringify([BRIDGE.country, id]))
    if (!visit) return proof.attributes
    consumedEntries.add(visit.id)
    return { ...extra(visit), placeId: visit.entityId, visitedDate: dates(visit).startDate }
  })
  const mediaItems = strings(order.media).map(id => {
    const entity = store.entities.find(e => e.typeId === 'bridge:media' && e.source.sourceId === BRIDGE.media && e.source.recordId === id)
    const asset = entity && assets.get(entity.fields.asset as string)
    if (!entity || !asset || asset.source.sourceId !== BRIDGE.media || asset.source.recordId !== id) reject('E_BRIDGE_RECORD', '$.media')
    consumedEntities.add(entity.id); consumedAssets.add(asset.id)
    return { ...asset.attributes, id, placeId: entity.fields.place, ...(entity.extensions?.hasTitle === true ? { title: entity.title } : {}) }
  })
  // Every source record must be reconstructed, including hidden entries and
  // assets. A modified ledger cannot quietly omit facts from the projection.
  if (consumedEntries.size !== store.entries.length || consumedEntities.size !== store.entities.filter(e => e.typeId !== 'bridge:journey').length || consumedAssets.size !== store.assets.length || consumedEvidence.size !== store.evidence.length) reject('E_BRIDGE_UNCONSUMED', '$.bridge')
  const files = {
    places: { ...bridgeObject(headers.places), places },
    travel: { ...bridgeObject(headers.travel), records },
    wantToGo: { ...bridgeObject(headers.wantToGo), items },
    editorState: { ...bridgeObject(metadata.editor), addedCountries },
    media: { ...bridgeObject(headers.media), items: mediaItems },
  } as unknown as V2Files
  if (validateV2Files(files).length) reject('E_BRIDGE_V2_INVALID', '$.reconstructed')
  // These are derived caches, not independently editable authority. Refuse a
  // mismatched time anchor/sequence instead of silently presenting a new route.
  for (const row of store.entries) {
    const anchor = store.anchors.find(a => a.id === bridgeRowId('entry-date', row.id))
    if (!anchor || anchor.kind !== 'time' || anchor.entityId !== row.entityId || jsonKey(anchor.date) !== jsonKey(row.fields.date)) reject('E_BRIDGE_DERIVATIVE', '$.timeAnchor')
  }
  const groups = new Map<string, V2Files['travel']['records']>()
  for (const row of files.travel.records) if (row.status !== 'planned' && typeof row.journeyId === 'string' && row.journeyId.trim()) {
    const group = groups.get(row.journeyId) ?? []; group.push(row); groups.set(row.journeyId, group)
  }
  if (groups.size !== store.sequences.length || groups.size !== store.entities.filter(e => e.typeId === 'bridge:journey').length) reject('E_BRIDGE_DERIVATIVE', '$.journeys')
  for (const [journeyId, group] of groups) {
    const sequence = store.sequences.find(s => s.id === bridgeRowId('journey-sequence', journeyId))
    const entity = sequence && entities.get(sequence.entityId)
    const expected = [...group].sort((a, b) => `${a.start_date}-${a.id}`.localeCompare(`${b.start_date}-${b.id}`)).map(r => entries.get(JSON.stringify([BRIDGE.travel, r.id]))!.id)
    if (!sequence || entity?.typeId !== 'bridge:journey' || entity.source.sourceId !== BRIDGE.journey || entity.source.recordId !== journeyId || jsonKey(sequence.entryIds) !== jsonKey(expected)) reject('E_BRIDGE_DERIVATIVE', '$.sequence')
  }
  return freezeCopy(files)
}

/** Independent Store sequence projection: no filtered Snapshot and no legacy
 * route builder. Suppress only same-place pairs, retaining the next predecessor. */
export function projectBridgeOriginalRoutes(document: BridgeDocument): readonly OriginalRouteCandidate[] {
  restoreBridgeV2(document)
  const world = document.store, entities = new Map(world.entities.map(e => [e.id, e])), entries = new Map(world.entries.map(e => [e.id, e]))
  const countryName = (entityId: string) => {
    const place = entities.get(entityId)!, country = entities.get(place.fields.parent as string)
    return country?.title.names.en ?? ''
  }
  const routes: OriginalRouteCandidate[] = []
  for (const sequence of world.sequences) for (let i = 1; i < sequence.entryIds.length; i++) {
    const from = entries.get(sequence.entryIds[i - 1])!, to = entries.get(sequence.entryIds[i])!
    if (from.entityId === to.entityId) continue
    routes.push({ id: JSON.stringify(['original-route', sequence.source.recordId, from.source.recordId, to.source.recordId]), journeyId: sequence.source.recordId,
      fromRecordId: from.source.recordId, toRecordId: to.source.recordId, fromPlaceId: from.entityId, toPlaceId: to.entityId,
      kind: countryName(from.entityId) === countryName(to.entityId) ? 'main' : 'flight' })
  }
  return freezeCopy(routes)
}

export function projectBridgeCompatibility(document: BridgeDocument, now: string) {
  const canonical = freezeCopy(readV2(restoreBridgeV2(document)))
  const app = deriveAppDataFromCanonical(canonical, { now })
  return { canonical, app, baseline: buildBaseline(app, { now }), timeContext: deriveTimeQueryContext(canonical) }
}
