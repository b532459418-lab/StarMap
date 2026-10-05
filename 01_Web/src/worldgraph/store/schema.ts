import { isCalendarDate } from '../timeFilter.ts'
import type { JsonValue, StorePolicy, StoreTable, WorldStore, StoreCommand } from './types.ts'

export const STORE_TABLES: readonly StoreTable[] = Object.freeze([
  'sources', 'evidence', 'reviews', 'entityTypes', 'layers', 'entities', 'entries',
  'relationTypes', 'relations', 'anchors', 'assets', 'sequences', 'viewStates',
])
/** Safe diagnostics: code/path only, never user record contents. */
export class StoreError extends Error {
  readonly code: string
  readonly path: string
  constructor(code: string, path: string) {
    super(`${code}: ${path}`); this.code = code; this.path = path
  }
}
export function reject(code: string, path: string): never { throw new StoreError(code, path) }
type ObjectValue = Record<string, unknown>
const plain = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

/** Validate descriptors before reading values; reject getter execution and lossy JSON. */
export function validateJson(value: unknown, path = '$', parents = new Set<object>(), depth = 0): asserts value is JsonValue {
  if (depth > 64) reject('E_JSON_DEPTH', path)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!Array.isArray(value) && !plain(value)) reject('E_JSON', path)
  if (parents.has(value)) reject('E_JSON_CYCLE', path)
  parents.add(value)
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) reject('E_JSON_ARRAY', path)
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i))
      if (!d || !d.enumerable || !('value' in d)) reject('E_JSON_ARRAY', path)
      validateJson(d.value, `${path}[${i}]`, parents, depth + 1)
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !('value' in d)) reject('E_JSON', path)
      validateJson(d.value, `${path}.${key}`, parents, depth + 1)
    }
  }
  parents.delete(value)
}
export function shape(value: unknown, keys: readonly string[], required = keys, path = '$'): asserts value is ObjectValue {
  const allowed=keys.includes('id')&&keys.includes('revision')?[...keys,'extensions']:keys
  if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) reject('E_SHAPE', path)
}
export function opaqueId(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) reject('E_ID', path)
}
export function revision(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject('E_REVISION', path)
}
function uuid(value: unknown, path: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) reject('E_UUID7', path)
}
export function utcTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !isCalendarDate(value.slice(0,10))) reject('E_TIME', path)
  if (+value.slice(11,13) > 23 || +value.slice(14,16) > 59 || +value.slice(17,19) > 59) reject('E_TIME', path)
}
/** Canonical key sorting only; array order and every persisted value remain significant. */
export function jsonKey(value: unknown): string {
  validateJson(value)
  const serialize = (v: JsonValue): string => {
    if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']'
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+serialize((v as Record<string, JsonValue>)[k])).join(',') + '}'
    return JSON.stringify(v)
  }
  return serialize(value)
}
function names(value: unknown, path: string) {
  shape(value, ['names','originalLanguage'], ['names'], path)
  if (!plain(value.names)) reject('E_TITLE', path)
  const seen = new Set<string>()
  for (const [tag,text] of Object.entries(value.names)) {
    let normalized: string
    try { normalized = Intl.getCanonicalLocales(tag)[0] } catch { reject('E_LANGUAGE', path) }
    if (seen.has(normalized) || typeof text !== 'string') reject('E_TITLE', path)
    seen.add(normalized)
  }
  if (value.originalLanguage !== undefined && (typeof value.originalLanguage !== 'string' || !Object.hasOwn(value.names,value.originalLanguage) || !value.names[value.originalLanguage])) reject('E_TITLE', path)
}
function ids(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) reject('E_SHAPE', path)
  const seen = new Set<string>()
  for (const id of value) { opaqueId(id,path); if (seen.has(id)) reject('E_DUPLICATE',path); seen.add(id) }
  return value
}
export function validateStoredDates(value: unknown, path = '$.date') {
  validateJson(value,path)
  shape(value,['raw'],['raw'],path)
  shape(value.raw,['startDate','endDate','year'],[],path+'.raw')
  // Historical evidence may be partial, invalid or missing. Never repair it here.
}
function finite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) reject('E_NUMBER',path)
}
function definitions(value: unknown, path: string): ObjectValue[] {
  if (!Array.isArray(value)) reject('E_SCHEMA',path)
  const keys = new Set<string>()
  for (const field of value) {
    shape(field,['key','kind','required','min','max'],['key','kind'],path)
    opaqueId(field.key,path)
    if (['__proto__','constructor','prototype'].includes(field.key) || keys.has(field.key)) reject('E_SCHEMA',path)
    keys.add(field.key)
    if (typeof field.kind !== 'string' || !['text','number','boolean','date','date_evidence','entity_ref','asset_ref'].includes(field.kind)) reject('E_FIELD_KIND',path)
    if (field.required !== undefined && typeof field.required !== 'boolean') reject('E_SCHEMA',path)
    if (field.min !== undefined || field.max !== undefined) {
      if (field.kind !== 'number') reject('E_SCHEMA',path)
      if (field.min !== undefined) finite(field.min,path)
      if (field.max !== undefined) finite(field.max,path)
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) reject('E_SCHEMA',path)
    }
  }
  return value
}
type Index = Map<unknown,ObjectValue>
const target = (index: Index, id: unknown, path: string): ObjectValue => {
  const row=index.get(id); if (!row) reject('E_REFERENCE',path); return row
}
const visibility = (v: unknown, path: string) => { if (typeof v !== 'string' || !['private','friends','selected','link','public'].includes(v)) reject('E_VISIBILITY',path) }

export function validateWorldStore(value: unknown, policy: StorePolicy = {}): asserts value is WorldStore {
  validateJson(value)
  shape(value,['format','formatVersion','revision',...STORE_TABLES])
  if (value.format !== 'starmap.world-store' || value.formatVersion !== 1) reject('E_VERSION','$')
  revision(value.revision,'$.revision')
  const indices = new Map<StoreTable,Index>()
  for (const table of STORE_TABLES) {
    const rows=value[table]; if (!Array.isArray(rows)) reject('E_SHAPE',table)
    const index: Index=new Map()
    for (const row of rows) {
      if (!plain(row)) reject('E_SHAPE',table)
      opaqueId(row.id,table+'.id'); revision(row.revision,table+'.revision')
      if (row.extensions!==undefined&&!plain(row.extensions)) reject('E_EXTENSIONS',table+'.extensions')
      if (index.has(row.id)) reject('E_DUPLICATE',table)
      index.set(row.id,row)
    }
    indices.set(table,index)
  }
  const rows=(table:StoreTable) => [...indices.get(table)!.values()]
  const get=(table:StoreTable,id:unknown,path:string) => target(indices.get(table)!,id,path)
  const refs=(v:unknown,table:StoreTable,path:string) => { for (const id of ids(v,path)) get(table,id,path) }
  function source(v:unknown,path:string) {
    shape(v,['sourceId','recordId','evidenceIds','reviewId'],['sourceId','recordId','evidenceIds'],path)
    opaqueId(v.sourceId,path); opaqueId(v.recordId,path)
    const definition=get('sources',v.sourceId,path)
    refs(v.evidenceIds,'evidence',path)
    if (v.reviewId !== undefined) {
      const review=get('reviews',v.reviewId,path)
      if (review.sourceId !== v.sourceId) reject('E_REVIEW_SOURCE',path)
    } else if (definition.origin === 'ai') reject('E_UNCONFIRMED',path)
  }
  function fields(v:unknown,defs:unknown,path:string) {
    if (!plain(v)) reject('E_FIELDS',path)
    const schema=definitions(defs,path)
    if (Object.keys(v).some(k=>!schema.some(f=>f.key===k))) reject('E_FIELDS',path)
    for (const f of schema) {
      const key=f.key as string
      if (!Object.hasOwn(v,key)) { if (f.required) reject('E_REQUIRED',path); continue }
      const x=v[key]
      if (f.kind==='text' && typeof x!=='string' || f.kind==='boolean' && typeof x!=='boolean') reject('E_FIELDS',path)
      if (f.kind==='number') {
        finite(x,path)
        if (typeof f.min==='number' && x<f.min || typeof f.max==='number' && x>f.max) reject('E_FIELDS',path)
      }
      if (f.kind==='date' && !isCalendarDate(x)) reject('E_DATE',path)
      if (f.kind==='date_evidence') validateStoredDates(x,path)
      if (f.kind==='entity_ref') get('entities',x,path)
      if (f.kind==='asset_ref') get('assets',x,path)
    }
  }
  for (const r of rows('sources')) {
    shape(r,['id','revision','title','origin']); names(r.title,'sources.title')
    if (typeof r.origin !== 'string' || !['user','import','rule','ai'].includes(r.origin)) reject('E_SOURCE','sources.origin')
  }
  for (const r of rows('evidence')) {
    shape(r,['id','revision','sourceId','recordId','attributes']); get('sources',r.sourceId,'evidence.sourceId')
    opaqueId(r.recordId,'evidence.recordId'); if (!plain(r.attributes)) reject('E_SHAPE','evidence.attributes')
  }
  const proposalIds=new Set<unknown>()
  for (const r of rows('reviews')) {
    shape(r,['id','revision','proposalId','sourceId','acceptedAt']); get('sources',r.sourceId,'reviews.sourceId')
    opaqueId(r.proposalId,'reviews.proposalId'); utcTimestamp(r.acceptedAt,'reviews.acceptedAt')
    if (proposalIds.has(r.proposalId)) reject('E_DUPLICATE','reviews.proposalId'); proposalIds.add(r.proposalId)
  }
  for (const r of rows('entityTypes')) {
    shape(r,['id','revision','title','schemaVersion','fields']); names(r.title,'entityTypes.title')
    if (r.schemaVersion!==1) reject('E_SCHEMA_VERSION','entityTypes'); definitions(r.fields,'entityTypes.fields')
  }
  const systemKeys=new Set<unknown>()
  for (const r of rows('layers')) {
    shape(r,['id','revision','title','schemaVersion','acceptedEntityTypes','entryFields','systemKey'],['id','revision','title','schemaVersion','acceptedEntityTypes','entryFields'])
    names(r.title,'layers.title'); if (r.schemaVersion!==1) reject('E_SCHEMA_VERSION','layers')
    refs(r.acceptedEntityTypes,'entityTypes','layers.acceptedEntityTypes'); definitions(r.entryFields,'layers.entryFields')
    if (r.systemKey!==undefined) {
      opaqueId(r.systemKey,'layers.systemKey')
      if (!Object.hasOwn(policy.officialLayers??{},r.systemKey) || policy.officialLayers![r.systemKey]!==r.id) reject('E_SYSTEM_KEY','layers.systemKey')
      if (systemKeys.has(r.systemKey)) reject('E_DUPLICATE','layers.systemKey'); systemKeys.add(r.systemKey)
    }
  }
  for (const r of rows('entities')) {
    shape(r,['id','revision','typeId','title','fields','source','visibility']); uuid(r.id,'entities.id'); names(r.title,'entities.title')
    const type=get('entityTypes',r.typeId,'entities.typeId'); fields(r.fields,type.fields,'entities.fields')
    source(r.source,'entities.source'); visibility(r.visibility,'entities.visibility')
  }
  const identities=new Set<string>()
  for (const r of rows('entries')) {
    shape(r,['id','revision','layerId','entityId','fields','source','createdAt','updatedAt']); uuid(r.id,'entries.id')
    const layer=get('layers',r.layerId,'entries.layerId'),entity=get('entities',r.entityId,'entries.entityId')
    const accepted=layer.acceptedEntityTypes as string[]
    if (accepted.length && !accepted.includes(entity.typeId as string)) reject('E_TYPE','entries.entityId')
    fields(r.fields,layer.entryFields,'entries.fields'); source(r.source,'entries.source')
    utcTimestamp(r.createdAt,'entries.createdAt'); utcTimestamp(r.updatedAt,'entries.updatedAt')
    if (Date.parse(r.updatedAt)<Date.parse(r.createdAt)) reject('E_TIME','entries.updatedAt')
    const s=r.source as ObjectValue
    const key=JSON.stringify([r.entityId,r.layerId,s.sourceId,s.recordId])
    if (identities.has(key)) reject('E_SOURCE_COLLISION','entries.source'); identities.add(key)
  }
  for (const r of rows('relationTypes')) {
    shape(r,['id','revision','title','fromTypes','toTypes','fields','schemaVersion']); names(r.title,'relationTypes.title')
    if(r.schemaVersion!==1)reject('E_SCHEMA_VERSION','relationTypes')
    refs(r.fromTypes,'entityTypes','relationTypes.fromTypes'); refs(r.toTypes,'entityTypes','relationTypes.toTypes'); definitions(r.fields,'relationTypes.fields')
  }
  for (const r of rows('relations')) {
    shape(r,['id','revision','typeId','fromEntityId','toEntityId','source','fields'])
    const type=get('relationTypes',r.typeId,'relations.typeId')
    for (const [key,allowed] of [['fromEntityId','fromTypes'],['toEntityId','toTypes']]) {
      const entity=get('entities',r[key],'relations.'+key),types=type[allowed] as string[]
      if (types.length && !types.includes(entity.typeId as string)) reject('E_TYPE','relations.'+key)
    }
    fields(r.fields,type.fields,'relations.fields'); source(r.source,'relations.source')
  }
  for (const r of rows('anchors')) {
    const base=['id','revision','entityId','source','precision','visibility','kind']
    const extra=r.kind==='location'?['lat','lng','altitude','approximate']:['date']
    shape(r,[...base,...extra],['id','revision','entityId','source','precision','kind',...(r.kind==='location'?['lat','lng']:['date'])])
    get('entities',r.entityId,'anchors.entityId'); source(r.source,'anchors.source')
    if (typeof r.precision !== 'string' || !['exact','city','region','hidden'].includes(r.precision)) reject('E_PRECISION','anchors.precision')
    if (r.visibility!==undefined) visibility(r.visibility,'anchors.visibility')
    if (r.kind==='location') {
      finite(r.lat,'anchors.lat'); finite(r.lng,'anchors.lng')
      if (r.lat < -90 || r.lat > 90 || r.lng < -180 || r.lng > 180) reject('E_COORDINATE','anchors')
      if (r.altitude!==undefined) finite(r.altitude,'anchors.altitude')
      if (r.approximate!==undefined && typeof r.approximate!=='boolean') reject('E_SHAPE','anchors.approximate')
    } else if (r.kind==='time') validateStoredDates(r.date,'anchors.date')
    else reject('E_ANCHOR_KIND','anchors.kind')
  }
  for (const r of rows('assets')) {
    shape(r,['id','revision','source','attributes']); source(r.source,'assets.source')
    if (!plain(r.attributes)) reject('E_SHAPE','assets.attributes')
  }
  for (const r of rows('sequences')) {
    shape(r,['id','revision','entityId','entryIds','source']); get('entities',r.entityId,'sequences.entityId')
    refs(r.entryIds,'entries','sequences.entryIds'); source(r.source,'sequences.source')
  }
  for (const r of rows('viewStates')) {
    shape(r,['id','revision','layerId','orderedEntryIds','hiddenEntryIds']); get('layers',r.layerId,'viewStates.layerId')
    for (const key of ['orderedEntryIds','hiddenEntryIds']) {
      for (const id of ids(r[key],'viewStates.'+key)) if (get('entries',id,'viewStates.'+key).layerId!==r.layerId) reject('E_VIEW_LAYER','viewStates.'+key)
    }
  }
}

export function validateCommands(value: unknown): asserts value is readonly StoreCommand[] {
  validateJson(value)
  if (!Array.isArray(value) || !value.length) reject('E_COMMAND','$')
  for (const c of value) {
    if (!plain(c) || !STORE_TABLES.includes(c.table as StoreTable)) reject('E_COMMAND','$')
    if (c.op==='create') { shape(c,['op','table','value']); if (!plain(c.value)) reject('E_SHAPE','command.value') }
    else if (c.op==='update') {
      shape(c,['op','table','id','expectedRevision','value']); opaqueId(c.id,'command.id'); revision(c.expectedRevision,'command.expectedRevision')
      if (!plain(c.value)) reject('E_SHAPE','command.value')
    } else if (c.op==='remove') { shape(c,['op','table','id','expectedRevision']); opaqueId(c.id,'command.id'); revision(c.expectedRevision,'command.expectedRevision') }
    else reject('E_COMMAND','$')
  }
}
export function freezeCopy<T>(value: T): T {
  const freeze=(v:unknown):void=>{if(v && typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v)}}
  const copied=structuredClone(value); freeze(copied); return copied
}
export function readWorldStore(value: unknown, policy: StorePolicy = {}): WorldStore {
  validateWorldStore(value,policy); return freezeCopy(value)
}
export const emptyWorldStore = (): WorldStore => freezeCopy({
  format:'starmap.world-store',formatVersion:1,revision:0,
  sources:[],evidence:[],reviews:[],entityTypes:[],layers:[],entities:[],entries:[],
  relationTypes:[],relations:[],anchors:[],assets:[],sequences:[],viewStates:[],
})
