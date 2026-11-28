import { isCalendarDate } from '../../../worldgraph/timeFilter.ts'
import { positionBetween } from '../../../worldgraph/store/position.ts'
import type { FormalLayer } from '../../../worldgraph/store/formal.ts'
import type { JsonValue, LayerEntry, StoreEntity } from '../../../worldgraph/store/types.ts'
import {
  commonFields, defaultLayerId, interestEntityDefinition, interestHiddenScope, interestKindOf, interestLayerDefinition, interestLayerOrder,
  interestPlaceSubtype, interestPrefix, interestTemplates, interestTypeId, isInterestKind, isInterestLayer, wikidataItemId,
  wikidataSource, type InterestKind, type InterestWriteResult,
} from '../../interest/templates.ts'
import { orderedInterestLayers } from '../../interest/read.ts'
import { OFFICIAL } from '../../store/officialDefinitions.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import { sourceRef, viewItemRow, viewSettingRow } from '../../store/v2RecordRows.ts'
import { fail } from '../errors.ts'
import { commandBatch, viewRowId } from './batch.ts'
import { referencesOf, userSource } from './places.ts'
import type { NativeWrite, NativeWriteContext } from './routes.ts'

type Input = Record<string, unknown>
type Fields = Record<string, JsonValue>
const invalid = (field: string) => fail('E_REQUEST_INVALID', { reason: `无效的兴趣收藏字段（${field}）。` })
function input(value: unknown, field: string): Input {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(field)
  return value as Input
}
function text(value: unknown, field: string, limit = 250): string {
  if (typeof value !== 'string' || value.length > limit) return invalid(field)
  return value.trim()
}
function required(value: unknown, field: string, limit?: number): string {
  return text(value, field, limit) || invalid(field)
}
const names = (name: string) => ({ names: { en: name, 'zh-Hans': name } })
const nameOf = (row: StoreEntity) => row.title.names['zh-Hans'] || row.title.names.en || Object.values(row.title.names)[0] || row.id

function current<T extends { id: string; revision: number }>(value: unknown, find: (id: string) => T | undefined): T {
  const version = input(value, 'revision')
  const row = find(required(version.id, 'id'))
  if (!row || row.revision !== version.revision) return fail('E_STALE')
  return row
}

function safeUrl(value: string, field: string): string {
  let url: URL
  try { url = new URL(value) } catch { return invalid(field) }
  if (url.protocol !== 'https:' || url.username || url.password) return invalid(field)
  return url.href
}

function planWrite(reader: OfficialReader, value: unknown, ctx: NativeWriteContext) {
  const request = input(value, 'request')
  const batch = commandBatch()
  const now = ctx.now.toISOString()
  const entity = (id: string) => reader.index.get('entities', id) as StoreEntity | undefined
  const entry = (id: string) => reader.index.get('entries', id) as LayerEntry | undefined
  const layer = (id: string) => reader.index.get('layers', id) as FormalLayer | undefined
  const finish = (result: InterestWriteResult) => ({ commands: batch.commands(), result })
  const addType = (kind: InterestKind) => {
    if (!reader.index.get('entityTypes', interestTypeId(kind))) batch.create('entityTypes', interestEntityDefinition(kind))
  }
  const kindFor = (row: StoreEntity | undefined): InterestKind => (row && interestKindOf(row.typeId)) || invalid('entity')
  const layerFor = (id: string, kind: InterestKind) => {
    const known = layer(id)
    if (known && isInterestLayer(id) && known.acceptedEntityTypes[0] === interestTypeId(kind)) return known
    if (known || id !== defaultLayerId(kind)) return invalid('layer')
    addType(kind)
    const created = interestLayerDefinition(kind, id)
    batch.create('layers', created)
    return created
  }
  const points = new Map<string, string>()
  const placeFrom = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value === 'string') {
      if (entity(value)?.typeId !== OFFICIAL.place) fail('E_UNKNOWN_PLACE_REF')
      return value
    }
    const row = input(value, 'place')
    const name = required(row.name, 'place.name')
    const { lat, lng } = row
    if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90
      || typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180) return invalid('place.coordinates')
    const key = JSON.stringify([name, lat, lng])
    const pending = points.get(key)
    if (pending) return pending
    const existing = reader.index.entitiesOfType(OFFICIAL.place).find((candidate) => (
      candidate.fields.subtype === interestPlaceSubtype && nameOf(candidate) === name
      && reader.index.anchorsOf(candidate.id).some((anchor) => anchor.kind === 'location' && anchor.lat === lat && anchor.lng === lng)
    ))
    if (existing) return existing.id
    const id = ctx.newId(), anchorId = ctx.newId()
    batch.create('entities', {
      id, revision: 0, typeId: OFFICIAL.place, title: names(name), fields: { subtype: interestPlaceSubtype },
      visibility: 'private', source: userSource(id),
    })
    batch.create('anchors', {
      id: anchorId, revision: 0, entityId: id, kind: 'location', lat, lng, precision: 'exact',
      visibility: 'private', source: userSource(anchorId),
    })
    points.set(key, id)
    return id
  }
  const objectFields = (row: Input, kind: InterestKind): Fields => {
    const details = input(row.details, 'details')
    const fields: Fields = {}
    for (const definition of [...interestTemplates[kind].fields, ...commonFields]) {
      if (details[definition.key] === undefined) continue
      const content = text(details[definition.key], definition.key, 2000)
      if (!content) continue
      if (definition.kind === 'date' && !isCalendarDate(content)) return invalid(definition.key)
      fields[definition.key] = definition.kind === 'url' ? safeUrl(content, definition.key) : content
    }
    if (kind !== 'movie') {
      const placeId = placeFrom(row.place)
      if (placeId) fields.placeId = placeId
    }
    return fields
  }
  const activityFields = (value: unknown, kind: InterestKind): Fields => {
    const row = input(value, 'activity')
    const status = row.status
    if (status !== 'saved' && status !== 'planned' && status !== 'done') return invalid('status')
    const fields: Fields = { status }
    if (row.date !== undefined) {
      if (!isCalendarDate(row.date)) return invalid('date')
      fields.date = row.date
    }
    if (row.rating !== undefined) {
      if (typeof row.rating !== 'number' || !Number.isFinite(row.rating) || row.rating < 0 || row.rating > 5) return invalid('rating')
      fields.rating = row.rating
    }
    for (const key of kind === 'race' ? ['note', 'finish'] : ['note']) {
      const content = row[key] === undefined ? '' : text(row[key], key, 2000)
      if (content) fields[key] = content
    }
    const placeId = placeFrom(row.place)
    if (placeId) fields[interestTemplates[kind].placeField] = placeId
    return fields
  }
  const addActivity = (id: string, selectedLayer: FormalLayer, kind: InterestKind, value: unknown) => {
    const entryId = ctx.newId()
    batch.create('entries', {
      id: entryId, revision: 0, entityId: id, layerId: selectedLayer.id, fields: activityFields(value, kind),
      source: userSource(entryId), createdAt: now, updatedAt: now,
    })
    return finish({ id: entryId, entityId: id })
  }

  switch (request.op) {
    case 'create-layer': {
      if (!isInterestKind(request.kind)) return invalid('kind')
      const id = interestPrefix + 'layer:' + ctx.newId()
      addType(request.kind)
      batch.create('layers', interestLayerDefinition(request.kind, id, required(request.name, 'name', 80)))
      return finish({ id })
    }
    case 'rename-layer': {
      const row = current(request.layer, layer)
      if (!isInterestLayer(row.id)) return invalid('layer')
      batch.update('layers', row, { ...row, title: names(required(request.name, 'name', 80)) })
      return finish({ id: row.id })
    }
    case 'order-layers': {
      const { scope, key } = interestLayerOrder
      const setting = reader.viewSetting(scope, key)
      const currentIds = orderedInterestLayers(reader.index.model.layers, setting?.value).map(({ id }) => id)
      const { baseline, ids } = request
      if (!Array.isArray(baseline) || JSON.stringify(baseline) !== JSON.stringify(currentIds)) return fail('E_STALE')
      const allowed = new Set(currentIds)
      if (!Array.isArray(ids) || ids.length !== allowed.size || new Set(ids).size !== allowed.size
        || ids.some((id) => typeof id !== 'string' || !allowed.has(id))) return invalid('layers')
      const row = viewSettingRow(scope, setting?.id ?? viewRowId(scope, ctx.newId), key, { value: ids })
      if (setting) batch.update('viewSettings', setting, row)
      else batch.create('viewSettings', row)
      return finish({ id: row.id })
    }
    case 'add': {
      const kind = request.kind
      if (!isInterestKind(kind)) return invalid('kind')
      const row = input(request.object, 'object')
      const selectedLayer = layerFor(required(request.layerId, 'layer'), kind)
      let externalKey: string | undefined
      if (row.imported !== undefined) {
        const imported = input(row.imported, 'imported')
        if (typeof imported.key !== 'string' || !/^wikidata:Q[1-9]\d{0,14}$/.test(imported.key)) return invalid('source')
        externalKey = imported.key
        const existing = reader.index.entitiesOfType(interestTypeId(kind)).find((candidate) => candidate.fields.externalKey === externalKey)
        if (existing) {
          const existingEntry = reader.index.entriesOfEntity(existing.id).find((candidate) => candidate.layerId === selectedLayer.id)
          if (existingEntry) return finish({ id: existingEntry.id, entityId: existing.id, existingMatch: true })
          return addActivity(existing.id, selectedLayer, kind, request.activity)
        }
      }
      const id = ctx.newId()
      const title = names(required(row.title, 'title'))
      const fields = objectFields(row, kind)
      if (externalKey) {
        const sourceId = externalKey.slice('wikidata:'.length)
        if (typeof fields.sourceUrl !== 'string' || wikidataItemId(fields.sourceUrl) !== sourceId) return invalid('sourceUrl')
        fields.externalKey = externalKey
        // The host records the time it accepted the imported metadata.
        fields.retrievedAt = now
        if (!reader.index.get('sources', wikidataSource)) {
          batch.create('sources', { id: wikidataSource, revision: 0, title: names('Wikidata'), origin: 'import' })
        }
      }
      batch.create('entities', {
        id, revision: 0, typeId: interestTypeId(kind), title, fields, visibility: 'private',
        source: externalKey ? sourceRef(wikidataSource, externalKey) : userSource(id),
      })
      return addActivity(id, selectedLayer, kind, request.activity)
    }
    case 'edit-object': {
      const existing = current(request.entity, entity)
      const kind = kindFor(existing)
      const row = input(request.object, 'object')
      const fields = objectFields(row, kind)
      for (const key of ['externalKey', 'retrievedAt']) if (Object.hasOwn(existing.fields, key)) fields[key] = existing.fields[key]
      batch.update('entities', existing, { ...existing, title: names(required(row.title, 'title')), fields })
      return finish({ id: existing.id })
    }
    case 'add-activity': {
      const existing = current(request.entity, entity)
      const kind = kindFor(existing)
      return addActivity(existing.id, layerFor(required(request.layerId, 'layer'), kind), kind, request.activity)
    }
    case 'edit-activity':
    case 'hide':
    case 'restore':
    case 'remove-activity': {
      const existing = current(request.entry, entry)
      if (!isInterestLayer(existing.layerId)) return invalid('entry')
      const kind = kindFor(entity(existing.entityId))
      const hidden = reader.viewItem(interestHiddenScope, 'entries', existing.id)
      if (request.op === 'edit-activity') {
        batch.update('entries', existing, { ...existing, updatedAt: now, fields: activityFields(request.activity, kind) })
      } else if (request.op === 'hide') {
        if (!hidden) batch.create('viewItems', viewItemRow(
          interestHiddenScope, viewRowId(interestHiddenScope, ctx.newId), { table: 'entries', id: existing.id }, positionBetween(), true, existing.layerId,
        ))
      } else {
        if (hidden) batch.remove('viewItems', hidden)
        if (request.op === 'remove-activity') batch.remove('entries', existing)
      }
      return finish({ id: existing.id, entityId: existing.entityId })
    }
    case 'remove-object': {
      const existing = current(request.entity, entity)
      kindFor(existing)
      if (reader.index.entriesOfEntity(existing.id).length) {
        return fail('E_REQUEST_INVALID', { reason: '此对象仍有个人记录。请先移除对应记录。' })
      }
      batch.remove('entities', existing)
      return finish({ id: existing.id })
    }
    case 'remove-place': {
      const existing = current(request.place, entity)
      if (existing.typeId !== OFFICIAL.place || existing.fields.subtype !== interestPlaceSubtype) return invalid('place')
      const refs = referencesOf(reader)('entities', existing.id).filter((ref) => ref.fromTable !== 'anchors')
      if (refs.length) {
        const references = refs.map((ref) => {
          const activity = ref.fromTable === 'entries' ? entry(ref.fromId) : undefined
          const object = entity(activity?.entityId ?? ref.fromId)
          return {
            id: ref.fromId, table: ref.fromTable, field: ref.field,
            ...(object ? { title: nameOf(object) } : {}),
            ...(typeof activity?.fields.date === 'string' ? { date: activity.fields.date } : {}),
          }
        })
        return fail('E_INTEREST_PLACE_IN_USE', { references })
      }
      for (const anchor of reader.index.anchorsOf(existing.id)) batch.remove('anchors', anchor)
      batch.remove('entities', existing)
      return finish({ id: existing.id })
    }
    default: return invalid('action')
  }
}

export const interestWrite = Object.freeze<NativeWrite>({ status: 200, plan: planWrite })
