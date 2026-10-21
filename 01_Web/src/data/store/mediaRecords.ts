/** Store-native writes of media records (3C-4c, design v2 §3 step 4 and §4): the commands that create and remove media
 * records directly, without a V2 write function or diffV2ToCommands. The read model does not change: the V2 view is
 * still projected (projectStoreToCanonical), and these rows project exactly like migrated ones.
 *
 * A record is a `starmap:media` entity (its city and its asset) and an asset (the media metadata). New records get
 * UUIDv7 ids for both and the source `starmap:user` with their own id as the record id (design v2 §1): the projection
 * then gives the asset id as the V2 media id. Migrated records keep `v2:media` and their old ids. Inbox paths and file
 * contents are not part of a record: they live in the host's media registry.
 *
 * - createMediaRecordCommands: assets and entities, each record's row at the end of the original media order, and for an
 *   explicit addition (an upload, a task's file) its row at the end of its city's photo or drone order (what
 *   the V2 import did, removed in 3C-4d). The covers (`isCover`) of the cities whose photos change follow markCovers.
 * - removeMediaRecordCommands: every view row and setting that refers to the asset (orders, hidden lists, covers), then
 *   the entity and the asset (both tombstoned for good), and the covers of its city again.
 * - rereadMediaRecordCommands (「重新读取说明」, design v2 §5): the entity's city and title and the asset's described
 *   keys follow the description the Inbox gives now; ids, hidden lists, orders, cover flags and files stay.
 * Positions: a row appended after the last element; when no key fits (E_POSITION), the scope is renumbered with
 * listPositions in the same batch (`renumbered` names it).
 *
 * Pure: the reader is bound to one read transaction by the host; `allocateId` is injected.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalRow, FormalTable, ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { StoreError, jsonKey, reject } from '../../worldgraph/store/primitives.ts'
import type { AssetReference, JsonObject, JsonValue, StoreEntity } from '../../worldgraph/store/types.ts'
import type { CanonicalMediaItem } from '../canonical/types.ts'
import { markCovers } from '../v2media/importPlan.ts'
import type { DiffReader } from './diffV2.ts'
import { OFFICIAL, UNRESOLVED_KEY_PREFIX, VIEW_SCOPES, mapListScope } from './officialDefinitions.ts'
import { fitsStoreTitle, listPositions, sourceRef, unresolvedSetting, viewItemRow, viewSettingRow, without } from './v2RecordRows.ts'

/** One record to create. */
export interface NewMediaRecord {
  readonly assetId: string
  readonly entityId: string
  /** The media item the scan resolves for the file (its kind, city, files, dimensions and sidecar values); `id` is ignored. */
  readonly item: CanonicalMediaItem
  /** An explicit addition: also appended to its city's photo or drone order. */
  readonly appendToCityOrder?: boolean
}
export interface MediaRecordsPlan {
  readonly commands: readonly FormalCommand[]
  /** Scopes renumbered in this batch. */
  readonly renumbered: readonly string[]
}
export interface MediaRecordsContext {
  readonly reader: DiffReader
  /** Fresh lowercase UUIDv7 for new view rows and settings. */
  readonly allocateId: () => string
}

type Json = Record<string, JsonValue>
const plain = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const isPosition = (error: unknown) => error instanceof StoreError && error.code === 'E_POSITION'
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const remove = (table: FormalTable, row: FormalRow): FormalCommand => ({ op: 'remove', table, id: row.id, expectedRevision: row.revision })

/** The asset of a new record: the item's metadata (every key but id, city and title) with its cover flag. */
export function mediaAssetRow(record: NewMediaRecord, isCover: boolean): AssetReference {
  const attributes = without(record.item, ['id', 'placeId', 'title'])
  return { id: record.assetId, revision: 0, source: sourceRef(OFFICIAL.user, record.assetId), attributes: { ...attributes, isCover } as JsonObject }
}

/** The `starmap:media` entity of a new record: its city and asset; a title the store cannot hold stays verbatim in extensions. */
export function mediaEntityRow(record: NewMediaRecord): StoreEntity {
  const { placeId, title } = record.item
  const fits = title !== undefined && fitsStoreTitle(title)
  return {
    id: record.entityId, revision: 0, typeId: OFFICIAL.media, title: fits ? title : { names: {} },
    fields: { place: placeId, asset: record.assetId }, source: sourceRef(OFFICIAL.user, record.entityId), visibility: 'private',
    ...(title !== undefined && !fits ? { extensions: { v2: { title: title as unknown as JsonValue } } } : {}),
  } satisfies StoreEntity
}

/** The photo or drone order a record's kind belongs to (V2: mediaOrderByCity / droneOrderByCity). */
const cityOrderScopeOf = (kind: string) => (kind === 'photo' ? VIEW_SCOPES.mediaOrderByCity : VIEW_SCOPES.droneOrderByCity)

/** The elements of a list scope by position: view items and unresolved settings. */
function listElements(reader: DiffReader, scope: string): { row: ViewItem | ViewSetting; position: string; item: boolean }[] {
  const rows = reader.viewScope(scope)
  const elements: { row: ViewItem | ViewSetting; position: string; item: boolean }[] = rows.items.map(row => ({ row, position: row.position, item: true }))
  for (const row of rows.settings) {
    const v = row.value
    if (row.key.startsWith(UNRESOLVED_KEY_PREFIX) && plain(v) && typeof v.position === 'string') elements.push({ row, position: v.position, item: false })
  }
  return elements.sort((a, b) => compare(a.position, b.position) || compare(a.row.id, b.row.id))
}

/**
 * Rows of `assetIds` appended to the list `scope`, after its last element. When no position fits, the whole scope is
 * renumbered: every view item whose position changes is updated, and an unresolved element (whose key is its position)
 * is replaced by a new setting.
 */
function appendRows(reader: DiffReader, scope: string, assetIds: readonly string[], allocateId: () => string, renumbered: string[]): FormalCommand[] {
  const elements = listElements(reader, scope)
  const created = (assetId: string, position: string) => ({ op: 'create', table: 'viewItems', value: viewItemRow(scope, `${scope}#${allocateId()}`, { table: 'assets', id: assetId }, position, false) }) as FormalCommand
  try {
    let previous = elements.at(-1)?.position
    return assetIds.map(assetId => { previous = positionBetween(previous, undefined); return created(assetId, previous) })
  } catch (error) {
    if (!isPosition(error)) throw error
  }
  renumbered.push(scope)
  const numbers = listPositions(elements.length + assetIds.length)
  const commands: FormalCommand[] = []
  elements.forEach((element, index) => {
    if (element.position === numbers[index]) return
    if (element.item) {
      const row = element.row as ViewItem
      commands.push({ op: 'update', table: 'viewItems', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, position: numbers[index] } as FormalRow })
      return
    }
    const setting = element.row as ViewSetting
    commands.push(remove('viewSettings', setting))
    commands.push({ op: 'create', table: 'viewSettings', value: unresolvedSetting(scope, `${scope}#${allocateId()}`, numbers[index], (setting.value as Json).id) })
  })
  assetIds.forEach((assetId, index) => commands.push(created(assetId, numbers[elements.length + index])))
  return commands
}

/** The media entities of a city (through the refs of their `place` field). */
function mediaOfCity(reader: DiffReader, placeId: string): StoreEntity[] {
  return reader.dependents('entities', placeId)
    .filter(ref => ref.fromTable === 'entities' && ref.field === 'fields.place')
    .map(ref => reader.get('entities', ref.fromId) as StoreEntity | undefined)
    .filter((entity): entity is StoreEntity => entity?.typeId === OFFICIAL.media)
}

/**
 * The cover flag of every photo in `placeIds` after the batch (markCovers: per city, a photo whose file name starts with
 * `cover` first, then by file name; ties by the original media order, new records last in batch order). Returns the
 * flags of the created records and the asset updates of existing ones whose flag changes.
 */
function covers(reader: DiffReader, placeIds: ReadonlySet<string>, created: readonly NewMediaRecord[], removed: ReadonlySet<string>): { flags: Map<string, boolean>; updates: FormalCommand[] } {
  const flags = new Map<string, boolean>()
  const updates: FormalCommand[] = []
  for (const placeId of [...placeIds].sort(compare)) {
    type Item = { assetId: string; kind: string; placeId: string; originalFileName: string; isCover: boolean; order: string; asset?: AssetReference }
    const items: Item[] = []
    for (const entity of mediaOfCity(reader, placeId)) {
      const assetId = entity.fields.asset
      if (typeof assetId !== 'string' || removed.has(assetId)) continue
      const asset = reader.get('assets', assetId) as AssetReference | undefined
      if (!asset) continue
      const rowId = reader.findViewItem(VIEW_SCOPES.mediaOrder, 'assets', assetId)
      const order = rowId === undefined ? '~' : (reader.get('viewItems', rowId) as ViewItem | undefined)?.position ?? '~'
      const attributes = asset.attributes
      items.push({ assetId, kind: String(attributes.kind), placeId, originalFileName: String(attributes.originalFileName ?? ''), isCover: attributes.isCover === true, order, asset })
    }
    items.sort((a, b) => compare(a.order, b.order) || compare(a.assetId, b.assetId))
    created.filter(record => record.item.placeId === placeId).forEach((record, index) => items.push({
      assetId: record.assetId, kind: record.item.kind, placeId, originalFileName: record.item.originalFileName ?? '', isCover: false, order: `~${index}`,
    }))
    for (const marked of markCovers(items)) {
      if (!marked.asset) { flags.set(marked.assetId, marked.isCover); continue }
      if ((marked.asset.attributes.isCover === true) === marked.isCover) continue
      const asset = marked.asset
      updates.push({ op: 'update', table: 'assets', id: asset.id, expectedRevision: asset.revision, value: { ...asset, revision: asset.revision + 1, attributes: { ...asset.attributes, isCover: marked.isCover } } as FormalRow })
    }
  }
  return { flags, updates }
}

/**
 * Create `records`: assets, entities, cover updates of existing photos in their cities, their rows at the end of the
 * original media order, and the explicit ones at the end of their city's photo or drone order (a missing city key
 * setting is created). In an order the planner accepts: rows before the view rows that refer to them.
 */
export function createMediaRecordCommands(records: readonly NewMediaRecord[], { reader, allocateId }: MediaRecordsContext): MediaRecordsPlan {
  const renumbered: string[] = []
  const cities = new Set(records.filter(record => record.item.kind === 'photo').map(record => record.item.placeId))
  const { flags, updates } = covers(reader, cities, records, new Set())
  const commands: FormalCommand[] = []
  for (const record of records) commands.push({ op: 'create', table: 'assets', value: mediaAssetRow(record, flags.get(record.assetId) ?? false) })
  for (const record of records) commands.push({ op: 'create', table: 'entities', value: mediaEntityRow(record) })
  commands.push(...updates)
  commands.push(...appendRows(reader, VIEW_SCOPES.mediaOrder, records.map(record => record.assetId), allocateId, renumbered))
  const byCityOrder = new Map<string, { scope: string; placeId: string; assetIds: string[] }>()
  for (const record of records.filter(item => item.appendToCityOrder)) {
    const scope = cityOrderScopeOf(record.item.kind)
    const key = `${scope}\u0000${record.item.placeId}`
    if (!byCityOrder.has(key)) byCityOrder.set(key, { scope, placeId: record.item.placeId, assetIds: [] })
    byCityOrder.get(key)!.assetIds.push(record.assetId)
  }
  for (const { scope, placeId, assetIds } of byCityOrder.values()) {
    if (reader.findViewSetting(scope, placeId) === undefined) {
      commands.push({ op: 'create', table: 'viewSettings', value: viewSettingRow(scope, `${scope}#${allocateId()}`, placeId, { ref: { table: 'entities', id: placeId } }) })
    }
    commands.push(...appendRows(reader, mapListScope(scope, placeId), assetIds, allocateId, renumbered))
  }
  return Object.freeze({ commands: Object.freeze(commands), renumbered: Object.freeze(renumbered) })
}

/** The keys of a media item its folder and sidecar entry describe, besides its city and title (buildMediaItem). */
export const DESCRIBED_KEYS = Object.freeze(['kind', 'date', 'resolution', 'captureType', 'description', 'position', 'altitudeMeters', 'relativeAltitudeMeters', 'status'] as const)

/** A record to re-read: its asset and the media item the Inbox describes now (its `id` and files are ignored). */
export interface RereadMediaRecord {
  readonly assetId: string
  readonly item: CanonicalMediaItem
}

/** The media entity of an asset (the one whose `fields.asset` names it), or undefined. */
function mediaEntityOf(reader: DiffReader, assetId: string): StoreEntity | undefined {
  const ref = reader.dependents('assets', assetId).find(item => item.fromTable === 'entities' && item.field === 'fields.asset')
  const entity = ref ? reader.get('entities', ref.fromId) as StoreEntity | undefined : undefined
  return entity?.typeId === OFFICIAL.media ? entity : undefined
}

/** The rows a re-read gives and what it changes (`place`, `title`, described keys). */
function rereadRows(reader: DiffReader, update: RereadMediaRecord): { asset: AssetReference; entity: StoreEntity; nextAsset: AssetReference; nextEntity: StoreEntity; changed: string[] } {
  const asset = reader.get('assets', update.assetId) as AssetReference | undefined
  if (!asset) reject('E_MEDIA_NOT_FOUND', 'assets')
  const entity = mediaEntityOf(reader, update.assetId)
  if (!entity) reject('E_MEDIA_NOT_FOUND', 'entities')
  const item = update.item as unknown as Json
  const attributes: Json = { ...asset!.attributes as Json }
  const changed: string[] = []
  if (entity!.fields.place !== update.item.placeId) changed.push('place')
  for (const key of DESCRIBED_KEYS) {
    if (jsonKey(attributes[key] ?? null) !== jsonKey(item[key] ?? null)) changed.push(key)
    if (item[key] === undefined) delete attributes[key]
    else attributes[key] = structuredClone(item[key]) as JsonValue
  }
  const title = update.item.title
  const fits = title !== undefined && fitsStoreTitle(title)
  const v2 = plain(entity!.extensions?.v2) ? { ...entity!.extensions!.v2 as Json } : {}
  const currentTitle = Object.keys(entity!.title.names).length ? entity!.title : v2.title
  if (jsonKey(currentTitle ?? null) !== jsonKey(title ?? null)) changed.push('title')
  delete v2.title
  if (title !== undefined && !fits) v2.title = title as unknown as JsonValue
  const extensions: Json = { ...(entity!.extensions as Json | undefined ?? {}) }
  if (Object.keys(v2).length) extensions.v2 = v2
  else delete extensions.v2
  const { extensions: _extensions, ...entityRest } = entity!
  void _extensions
  const nextEntity = {
    ...entityRest, revision: entity!.revision + 1, title: fits ? title : { names: {} }, fields: { ...entity!.fields, place: update.item.placeId },
    ...(Object.keys(extensions).length ? { extensions } : {}),
  } as StoreEntity
  const nextAsset = { ...asset!, revision: asset!.revision + 1, attributes: attributes as JsonObject }
  return { asset: asset!, entity: entity!, nextAsset, nextEntity, changed }
}

/** What re-reading a record would change: `place`, `title` and the described keys that differ (empty: nothing). */
export function rereadChanges(update: RereadMediaRecord, { reader }: Pick<MediaRecordsContext, 'reader'>): string[] {
  return rereadRows(reader, update).changed
}

/**
 * Re-read the descriptions of records: each entity's city and title and its asset's described keys follow `item`.
 * Ids, hidden lists, orders, cover flags and generated files are left as they are; a record whose description is the
 * same gets no command.
 */
export function rereadMediaRecordCommands(updates: readonly RereadMediaRecord[], { reader }: Pick<MediaRecordsContext, 'reader'>): MediaRecordsPlan {
  const commands: FormalCommand[] = []
  for (const update of updates) {
    const { asset, entity, nextAsset, nextEntity, changed } = rereadRows(reader, update)
    if (changed.length === 0) continue
    if (jsonKey(asset.attributes) !== jsonKey(nextAsset.attributes)) {
      commands.push({ op: 'update', table: 'assets', id: asset.id, expectedRevision: asset.revision, value: nextAsset as unknown as FormalRow })
    }
    commands.push({ op: 'update', table: 'entities', id: entity.id, expectedRevision: entity.revision, value: nextEntity as unknown as FormalRow })
  }
  return Object.freeze({ commands: Object.freeze(commands), renumbered: Object.freeze([]) })
}

/** The V2 media id an asset projects to (projectStoreToCanonical): a migrated asset's V2 id, otherwise its own id. */
const v2IdOf = (asset: AssetReference) => (asset.source.sourceId === 'v2:media' ? asset.source.recordId : asset.id)

/**
 * Settings of the media lists that name one of `v2Ids` without referring to its asset: the unresolved elements of the
 * hidden lists and city orders (a repeated id, kept as V2 wrote it) and covers stored as a value. V2's removal drops
 * every occurrence of a deleted id, so the store's does too.
 */
function unresolvedMentions(reader: DiffReader, v2Ids: ReadonlySet<string>): ViewSetting[] {
  const found: ViewSetting[] = []
  const scan = (scope: string) => {
    for (const setting of reader.viewScope(scope).settings) {
      const v = setting.value
      if (setting.key.startsWith(UNRESOLVED_KEY_PREFIX) && plain(v) && typeof v.id === 'string' && v2Ids.has(v.id)) found.push(setting)
    }
  }
  scan(VIEW_SCOPES.hiddenMedia)
  scan(VIEW_SCOPES.hiddenDroneMedia)
  for (const map of [VIEW_SCOPES.mediaOrderByCity, VIEW_SCOPES.droneOrderByCity]) {
    for (const key of reader.viewScope(map).settings) if (!key.key.startsWith(UNRESOLVED_KEY_PREFIX)) scan(mapListScope(map, key.key))
  }
  for (const cover of reader.viewScope(VIEW_SCOPES.coverMediaByCity).settings) {
    if (cover.ref === undefined && typeof cover.value === 'string' && v2Ids.has(cover.value)) found.push(cover)
  }
  return found
}

/**
 * Remove the records of `assetIds`: every view row and setting that refers to an asset (the original order, city
 * orders, hidden lists, covers) or names its V2 id (unresolved elements, value covers), the entities, the assets, and
 * the covers of their cities again. A record that anything else refers to is refused (E_MEDIA_DEPENDENT): the planner
 * would refuse it too.
 */
export function removeMediaRecordCommands(assetIds: readonly string[], { reader }: Pick<MediaRecordsContext, 'reader'>): MediaRecordsPlan {
  const views: FormalCommand[] = []
  const records: FormalCommand[] = []
  const assets: FormalCommand[] = []
  const cities = new Set<string>()
  const seen = new Set<string>()
  const v2Ids = new Set<string>()
  for (const assetId of assetIds) {
    const asset = reader.get('assets', assetId) as AssetReference | undefined
    if (!asset) reject('E_MEDIA_NOT_FOUND', 'assets')
    v2Ids.add(v2IdOf(asset!))
    let entity: StoreEntity | undefined
    for (const ref of reader.dependents('assets', assetId)) {
      if (ref.fromTable === 'viewItems' || ref.fromTable === 'viewSettings') {
        if (seen.has(`${ref.fromTable}\u0000${ref.fromId}`)) continue
        seen.add(`${ref.fromTable}\u0000${ref.fromId}`)
        views.push(remove(ref.fromTable, reader.get(ref.fromTable, ref.fromId) as FormalRow))
      } else if (ref.fromTable === 'entities' && ref.field === 'fields.asset' && (reader.get('entities', ref.fromId) as StoreEntity | undefined)?.typeId === OFFICIAL.media) {
        entity = reader.get('entities', ref.fromId) as StoreEntity
      } else reject('E_MEDIA_DEPENDENT', ref.fromTable)
    }
    if (!entity) reject('E_MEDIA_NOT_FOUND', 'entities')
    if (reader.dependents('entities', entity!.id).length > 0) reject('E_MEDIA_DEPENDENT', 'entities')
    if (typeof entity!.fields.place === 'string') cities.add(entity!.fields.place)
    records.push(remove('entities', entity!))
    assets.push(remove('assets', asset!))
  }
  for (const setting of unresolvedMentions(reader, v2Ids)) {
    if (seen.has(`viewSettings\u0000${setting.id}`)) continue
    seen.add(`viewSettings\u0000${setting.id}`)
    views.push(remove('viewSettings', setting))
  }
  const { updates } = covers(reader, cities, [], new Set(assetIds))
  return Object.freeze({ commands: Object.freeze([...views, ...records, ...assets, ...updates]), renumbered: Object.freeze([]) })
}
