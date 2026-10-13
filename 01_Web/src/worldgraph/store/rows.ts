/** Row-level rules shared by whole-store validation and incremental planning.
 * One row at a time: references resolve through `lookup.get`, which never
 * enumerates a table. Store-wide uniqueness is the caller's job.
 */
import { isCalendarDate } from '../timeFilter.ts'
import type { StorePolicy, StoreTable } from './types.ts'
import type { FormalTable } from './formal.ts'
import { type ObjectValue, opaqueId, plain, reject, revision, shape, utcTimestamp, uuid, validateStoredDates } from './primitives.ts'
import { isPosition } from './position.ts'

export type RowTable = StoreTable | FormalTable
/** 'g1': the G1 world-store tables and field definitions, unchanged.
 * 'formal': the formal store (formal.ts): viewItems/viewSettings instead of
 * viewStates, and field definitions may carry `deprecated: true`. */
export type RowDialect = 'g1' | 'formal'
export interface RowLookup {
  /** The row with this id, or undefined. Rows are trusted to have passed validateRowBase. */
  get(table: RowTable, id: string): object | undefined
}
const VIEW_ITEM_TABLES: readonly string[] = ['entries','entities','assets']

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
function finite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) reject('E_NUMBER',path)
}
function fieldDefinitions(value: unknown, path: string, dialect: RowDialect): ObjectValue[] {
  if (!Array.isArray(value)) reject('E_SCHEMA',path)
  const keys = new Set<string>()
  for (const field of value) {
    if (dialect==='formal') {
      shape(field,['key','kind','required','min','max','deprecated'],['key','kind'],path)
      // A deprecated field accepts no new values, so it cannot also be required.
      if (field.deprecated!==undefined && (field.deprecated!==true || field.required===true)) reject('E_SCHEMA',path)
    } else shape(field,['key','kind','required','min','max'],['key','kind'],path)
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
const visibility = (v: unknown, path: string) => { if (typeof v !== 'string' || !['private','friends','selected','link','public'].includes(v)) reject('E_VISIBILITY',path) }
const scope = (v: unknown, path: string) => { if (typeof v !== 'string' || !v.trim() || v.length > 256) reject('E_SCOPE',path) }

/** Identity, revision and the opaque extensions lane: the part every table shares. */
export function validateRowBase(table: RowTable, row: unknown): asserts row is ObjectValue {
  if (!plain(row)) reject('E_SHAPE',table)
  opaqueId(row.id,table+'.id'); revision(row.revision,table+'.revision')
  if (row.extensions!==undefined&&!plain(row.extensions)) reject('E_EXTENSIONS',table+'.extensions')
}

/** Every per-row rule of the G1 contract: shape, field primitives, source and review
 * receipt, references, entry/relation type limits, times and coordinates. */
export function validateRow(table: RowTable, row: unknown, lookup: RowLookup, policy: StorePolicy = {}, dialect: RowDialect = 'g1'): asserts row is ObjectValue {
  validateRowBase(table,row)
  const r=row
  const definitions=(value:unknown,path:string) => fieldDefinitions(value,path,dialect)
  const get=(t:RowTable,id:unknown,path:string):ObjectValue => {
    const found=typeof id==='string'?lookup.get(t,id):undefined
    if (!found) reject('E_REFERENCE',path); return found as ObjectValue
  }
  const refs=(v:unknown,t:StoreTable,path:string) => { for (const id of ids(v,path)) get(t,id,path) }
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
  const g1=dialect==='g1'
  if (g1 ? table==='viewItems'||table==='viewSettings' : table==='viewStates') reject('E_TABLE',table)
  switch (table) {
    case 'sources':
      shape(r,['id','revision','title','origin']); names(r.title,'sources.title')
      if (typeof r.origin !== 'string' || !['user','import','rule','ai'].includes(r.origin)) reject('E_SOURCE','sources.origin')
      return
    case 'evidence':
      shape(r,['id','revision','sourceId','recordId','attributes']); get('sources',r.sourceId,'evidence.sourceId')
      opaqueId(r.recordId,'evidence.recordId'); if (!plain(r.attributes)) reject('E_SHAPE','evidence.attributes')
      return
    case 'reviews':
      shape(r,['id','revision','proposalId','sourceId','acceptedAt']); get('sources',r.sourceId,'reviews.sourceId')
      opaqueId(r.proposalId,'reviews.proposalId'); utcTimestamp(r.acceptedAt,'reviews.acceptedAt')
      return
    case 'entityTypes':
      shape(r,['id','revision','title','schemaVersion','fields']); names(r.title,'entityTypes.title')
      if (r.schemaVersion!==1) reject('E_SCHEMA_VERSION','entityTypes'); definitions(r.fields,'entityTypes.fields')
      return
    case 'layers':
      shape(r,['id','revision','title','schemaVersion','acceptedEntityTypes','entryFields','systemKey'],['id','revision','title','schemaVersion','acceptedEntityTypes','entryFields'])
      names(r.title,'layers.title'); if (r.schemaVersion!==1) reject('E_SCHEMA_VERSION','layers')
      refs(r.acceptedEntityTypes,'entityTypes','layers.acceptedEntityTypes'); definitions(r.entryFields,'layers.entryFields')
      if (r.systemKey!==undefined) {
        opaqueId(r.systemKey,'layers.systemKey')
        if (!Object.hasOwn(policy.officialLayers??{},r.systemKey) || policy.officialLayers![r.systemKey]!==r.id) reject('E_SYSTEM_KEY','layers.systemKey')
      }
      return
    case 'entities': {
      shape(r,['id','revision','typeId','title','fields','source','visibility']); uuid(r.id,'entities.id'); names(r.title,'entities.title')
      const type=get('entityTypes',r.typeId,'entities.typeId'); fields(r.fields,type.fields,'entities.fields')
      source(r.source,'entities.source'); visibility(r.visibility,'entities.visibility')
      return
    }
    case 'entries': {
      shape(r,['id','revision','layerId','entityId','fields','source','createdAt','updatedAt']); uuid(r.id,'entries.id')
      const layer=get('layers',r.layerId,'entries.layerId'),entity=get('entities',r.entityId,'entries.entityId')
      const accepted=layer.acceptedEntityTypes as string[]
      if (accepted.length && !accepted.includes(entity.typeId as string)) reject('E_TYPE','entries.entityId')
      fields(r.fields,layer.entryFields,'entries.fields'); source(r.source,'entries.source')
      utcTimestamp(r.createdAt,'entries.createdAt'); utcTimestamp(r.updatedAt,'entries.updatedAt')
      if (Date.parse(r.updatedAt)<Date.parse(r.createdAt)) reject('E_TIME','entries.updatedAt')
      return
    }
    case 'relationTypes':
      shape(r,['id','revision','title','fromTypes','toTypes','fields','schemaVersion']); names(r.title,'relationTypes.title')
      if(r.schemaVersion!==1)reject('E_SCHEMA_VERSION','relationTypes')
      refs(r.fromTypes,'entityTypes','relationTypes.fromTypes'); refs(r.toTypes,'entityTypes','relationTypes.toTypes'); definitions(r.fields,'relationTypes.fields')
      return
    case 'relations': {
      shape(r,['id','revision','typeId','fromEntityId','toEntityId','source','fields'])
      const type=get('relationTypes',r.typeId,'relations.typeId')
      for (const [key,allowed] of [['fromEntityId','fromTypes'],['toEntityId','toTypes']]) {
        const entity=get('entities',r[key],'relations.'+key),types=type[allowed] as string[]
        if (types.length && !types.includes(entity.typeId as string)) reject('E_TYPE','relations.'+key)
      }
      fields(r.fields,type.fields,'relations.fields'); source(r.source,'relations.source')
      return
    }
    case 'anchors': {
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
      return
    }
    case 'assets':
      shape(r,['id','revision','source','attributes']); source(r.source,'assets.source')
      if (!plain(r.attributes)) reject('E_SHAPE','assets.attributes')
      return
    case 'sequences':
      shape(r,['id','revision','entityId','entryIds','source']); get('entities',r.entityId,'sequences.entityId')
      refs(r.entryIds,'entries','sequences.entryIds'); source(r.source,'sequences.source')
      return
    case 'viewStates':
      shape(r,['id','revision','layerId','orderedEntryIds','hiddenEntryIds']); get('layers',r.layerId,'viewStates.layerId')
      for (const key of ['orderedEntryIds','hiddenEntryIds']) {
        for (const id of ids(r[key],'viewStates.'+key)) if (get('entries',id,'viewStates.'+key).layerId!==r.layerId) reject('E_VIEW_LAYER','viewStates.'+key)
      }
      return
    case 'viewItems': {
      shape(r,['id','revision','scope','itemTable','itemId','layerId','position','hidden'],['id','revision','scope','itemTable','itemId','position','hidden'])
      scope(r.scope,'viewItems.scope')
      if (typeof r.itemTable!=='string' || !VIEW_ITEM_TABLES.includes(r.itemTable)) reject('E_VIEW_TABLE','viewItems.itemTable')
      const item=get(r.itemTable as RowTable,r.itemId,'viewItems.itemId')
      if (r.layerId!==undefined) {
        get('layers',r.layerId,'viewItems.layerId')
        if (r.itemTable==='entries' && item.layerId!==r.layerId) reject('E_VIEW_LAYER','viewItems.layerId')
      }
      if (!isPosition(r.position)) reject('E_POSITION','viewItems.position')
      if (typeof r.hidden !== 'boolean') reject('E_SHAPE','viewItems.hidden')
      return
    }
    case 'viewSettings':
      shape(r,['id','revision','scope','key','value','ref'],['id','revision','scope','key'])
      scope(r.scope,'viewSettings.scope'); opaqueId(r.key,'viewSettings.key')
      if (r.ref!==undefined) {
        shape(r.ref,['table','id'],['table','id'],'viewSettings.ref')
        if (typeof r.ref.table !== 'string' || !VIEW_ITEM_TABLES.includes(r.ref.table)) reject('E_VIEW_TABLE','viewSettings.ref')
        get(r.ref.table as RowTable,r.ref.id,'viewSettings.ref')
      }
      return
    default: reject('E_TABLE',String(table))
  }
}
