/** Test helpers only: the command builders and the seeded random command sequences of
 * the shared-semantics parity test (parity.test.ts), moved here unchanged so the SQLite
 * host tests (scripts/store-host.test.mjs, 3C-2) generate states the same way.
 * Not part of any Core API. */
import { NOW, entry, id, source, title } from './store.fixture.ts'
import { commonFixture } from './formal.fixture.ts'
import { applyStoreCommands } from './commands.ts'
import type { AnyStoreRow, LayerEntry, ReviewReceipt, StoreCommand, StoreEntity, StoreTable, WorldStore } from './types.ts'
export const create = (table: StoreTable, value: unknown): StoreCommand => ({op:'create',table,value:value as AnyStoreRow})
export const update = (table: StoreTable, value: AnyStoreRow, expectedRevision = value.revision - 1): StoreCommand => ({op:'update',table,id:value.id,expectedRevision,value})
export const remove = (table: StoreTable, row: AnyStoreRow): StoreCommand => ({op:'remove',table,id:row.id,expectedRevision:row.revision})
export const book = (n: number, fields: Record<string,string> = {author:'A'}): StoreEntity =>
  ({id:id(n),revision:0,typeId:'custom:book',title:title('Book '+n),fields,source:source('book-'+n),visibility:'private'})
const film = {id:'custom:film',revision:0,title:title('Film'),schemaVersion:1,fields:[{key:'director',kind:'text'}]}
export const withFilm = (): WorldStore => applyStoreCommands(commonFixture(),[create('entityTypes',film),
  create('entities',{id:id(70),revision:0,typeId:'custom:film',title:title('Film'),fields:{director:'D'},source:source('film-70'),visibility:'private'})],0)
export const review: ReviewReceipt = {id:'review-one',revision:0,proposalId:'proposal-one',sourceId:'test:ai',acceptedAt:NOW}

/** Deterministic LCG; fixed seeds keep every run identical. */
export const generator = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }
export const VALID = ['entity','entry','entry','anchor','relation','asset','updateEntry','updateEntity','duplicate','removeLeaf'] as const
export const FAULTS = ['conflict','staleStore','staleRow','notFound','revision','sourceIdentity','layerMove','typeChange','timeBack','collision',
  'unconfirmed','fieldType','required','unknownField','reference','typeLimit','reviewCommand','evidence','recreate','dependents','date'] as const

export function randomBatch(world: WorldStore, random: () => number, counter: { n: number }) {
  const pick = <T>(xs: readonly T[]): T | undefined => xs.length ? xs[Math.floor(random() * xs.length)] : undefined
  const fresh = () => counter.n++
  const entities = [...world.entities], assets = [...world.assets]
  const touched = new Set<string>(), referenced = new Set<string>()
  const commands: StoreCommand[] = [], options: { expected?: number } = {}
  const books = () => entities.filter(e => e.typeId === 'custom:book')
  const untouched = <T extends AnyStoreRow>(rows: readonly T[]) => rows.filter(r => !touched.has(r.id))
  const isLeaf = (table: StoreTable, rowId: string): boolean => {
    if (touched.has(rowId) || referenced.has(rowId)) return false
    if (table === 'entries') return !world.sequences.some(s => s.entryIds.includes(rowId))
    if (table === 'entities') return !world.entries.some(e => e.entityId === rowId) && !world.relations.some(r => r.fromEntityId === rowId || r.toEntityId === rowId)
      && !world.anchors.some(a => a.entityId === rowId) && !world.sequences.some(s => s.entityId === rowId)
      && !world.entities.some(e => Object.values(e.fields).includes(rowId))
    if (table === 'assets') return !world.entities.some(e => Object.values(e.fields).includes(rowId))
    return true
  }
  const newEntry = (): LayerEntry | undefined => {
    const layerId = random() < 0.5 ? 'user:reading' : 'user:favorites'
    const target = pick(layerId === 'user:reading' ? books() : entities)
    if (!target) return undefined
    referenced.add(target.id)
    const n = fresh()
    return {id:id(n),revision:0,layerId,entityId:target.id,source:source('random-'+n),createdAt:NOW,updatedAt:NOW,
      fields:layerId === 'user:reading' ? {rating:Math.floor(random() * 6)} : {rating:Math.round(random() * 1000) / 10}}
  }
  function valid(kind: typeof VALID[number]): StoreCommand | undefined {
    const n = fresh()
    switch (kind) {
      case 'entity': {
        const fields: Record<string,string> = {author:'Author '+n}
        const related = random() < 0.3 ? pick(books()) : undefined, cover = random() < 0.2 ? pick(assets) : undefined
        if (related) { fields.related = related.id; referenced.add(related.id) }
        if (cover) { fields.cover = cover.id; referenced.add(cover.id) }
        const row = {...book(n,fields),source:source('random-'+n)}
        entities.push(row); return create('entities',row)
      }
      case 'entry': { const row = newEntry(); return row && create('entries',row) }
      case 'anchor': {
        const target = pick(entities); if (!target) return undefined
        referenced.add(target.id)
        return create('anchors',{id:'anchor-'+n,revision:0,entityId:target.id,kind:'location',lat:Math.round(random() * 1800 - 900) / 10,
          lng:Math.round(random() * 3600 - 1800) / 10,precision:'city',source:source('anchor-'+n)})
      }
      case 'relation': {
        const from = pick(books()), to = pick(books()); if (!from || !to) return undefined
        referenced.add(from.id); referenced.add(to.id)
        return create('relations',{id:'relation-'+n,revision:0,typeId:'custom:related',fromEntityId:from.id,toEntityId:to.id,source:source('relation-'+n),fields:{}})
      }
      case 'asset': { const row = {id:'asset-'+n,revision:0,source:source('asset-'+n),attributes:{n}}; assets.push(row); return create('assets',row) }
      case 'updateEntry': {
        const row = pick(untouched(world.entries)); if (!row) return undefined
        touched.add(row.id)
        const fields = row.layerId === 'user:reading' ? {rating:Math.floor(random() * 6)} : {rating:n}
        return update('entries',{...row,revision:row.revision + 1,fields,updatedAt:random() < 0.5 ? row.updatedAt : '2026-10-09T00:00:00.000Z'})
      }
      case 'updateEntity': {
        const row = pick(untouched(world.entities)); if (!row) return undefined
        touched.add(row.id)
        return update('entities',{...row,revision:row.revision + 1,title:title('Renamed '+n)})
      }
      case 'duplicate': { const row = pick(world.entities); return row && create('entities',row) }
      case 'removeLeaf': {
        const table = pick(['entries','entities','anchors','relations','assets'] as const)!
        const row = pick((world[table] as readonly AnyStoreRow[]).filter(r => isLeaf(table,r.id))); if (!row) return undefined
        touched.add(row.id)
        const at = entities.findIndex(e => e.id === row.id); if (at >= 0) entities.splice(at,1)
        const asset = assets.findIndex(a => a.id === row.id); if (asset >= 0) assets.splice(asset,1)
        return remove(table,row)
      }
    }
  }
  function fault(kind: typeof FAULTS[number]): StoreCommand[] {
    const e = pick(untouched(world.entries)), entity = pick(untouched(world.entities)), n = fresh()
    switch (kind) {
      case 'conflict': return entity ? [create('entities',{...entity,title:title('Conflict '+n)})] : []
      case 'staleStore': options.expected = world.revision + 1; return []
      case 'staleRow': return e ? [update('entries',{...e,revision:e.revision + 1},e.revision + 3)] : []
      case 'notFound': return [random() < 0.5 ? remove('anchors',{id:'missing-'+n,revision:0} as AnyStoreRow) : update('entries',{...entry(900000 + n),revision:1})]
      case 'revision': return random() < 0.5 ? [create('entities',{...book(n),revision:1})] : e ? [update('entries',{...e,revision:e.revision + 2},e.revision)] : []
      case 'sourceIdentity': return e ? [update('entries',{...e,revision:e.revision + 1,source:source('moved-'+n)})] : []
      case 'layerMove': return e ? [update('entries',{...e,revision:e.revision + 1,layerId:e.layerId === 'user:reading' ? 'user:favorites' : 'user:reading'})] : []
      case 'typeChange': return entity ? [update('entities',{...entity,revision:entity.revision + 1,typeId:entity.typeId === 'custom:book' ? 'custom:film' : 'custom:book'})] : []
      case 'timeBack': return e ? [update('entries',{...e,revision:e.revision + 1,updatedAt:'2026-10-01T00:00:00.000Z'})] : []
      case 'collision': return e ? [create('entries',{...e,id:id(n)})] : []
      case 'unconfirmed': { const row = newEntry(); return row ? [create('entries',{...row,source:source('ai-'+n,'test:ai')})] : [] }
      case 'fieldType': return [create('entities',book(n,{author:n as unknown as string}))]
      case 'required': return [create('entities',book(n,{}))]
      case 'unknownField': return [create('entities',book(n,{author:'A',extra:'x'}))]
      case 'reference': { const row = newEntry(); return row ? [create('entries',{...row,entityId:id(800000 + n)})] : [] }
      case 'typeLimit': { const target = entities.find(x => x.typeId === 'custom:film'); return target ? [create('entries',{...entry(n),entityId:target.id})] : [] }
      case 'reviewCommand': return [create('reviews',{...review,id:'review-'+n})]
      case 'evidence': return [update('evidence',{...world.evidence[0],revision:world.evidence[0].revision + 1,attributes:{n}})]
      case 'recreate': {
        const row = pick(world.anchors.filter(a => !touched.has(a.id))); if (!row) return []
        touched.add(row.id); return [remove('anchors',row),create('anchors',row)]
      }
      case 'dependents': { const target = world.entities.find(x => world.entries.some(y => y.entityId === x.id) && !touched.has(x.id)); return target ? [remove('entities',target)] : [] }
      case 'date': { const row = newEntry(); return row && row.layerId === 'user:reading' ? [create('entries',{...row,fields:{readAt:'2025-02-30'}})] : [] }
    }
  }
  const size = 1 + Math.floor(random() * 3), faultAt = random() < 0.45 ? Math.floor(random() * size) : -1
  const faultKind = pick(FAULTS)!
  let tail: StoreCommand[] = []
  for (let i = 0; i < size; i++) {
    if (i !== faultAt) { const c = valid(pick(VALID)!); if (c) commands.push(c); continue }
    // Removing a referenced row is order-sensitive in the planner, so nothing follows it.
    if (faultKind === 'dependents') tail = fault(faultKind); else commands.push(...fault(faultKind))
  }
  commands.push(...tail)
  return {commands,options}
}
