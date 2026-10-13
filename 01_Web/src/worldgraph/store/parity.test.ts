/// <reference types="node" />
/** Shared semantics: the G1 reference (applyStoreCommands) and the formal path
 * (formalFromWorld -> memoryReader -> planCommands -> applyChangeSet -> worldFromFormal)
 * must both accept with equal results or both reject with the same code. The only
 * code difference allowed here is the README's: a referenced row's deletion is
 * E_REFERENCE in G1 and E_DEPENDENTS in the planner. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, entry, id, source, title } from './store.fixture.ts'
import { commonFixture, formalFromWorld, worldFromFormal } from './formal.fixture.ts'
import type { FormalCommand, FormalState } from './formal.ts'
import { memoryReader } from './reader.ts'
import { applyChangeSet, planCommands } from './planner.ts'
import { applyStoreCommands } from './commands.ts'
import { StoreError, jsonKey } from './schema.ts'
import type { AnyStoreRow, LayerEntry, ReviewReceipt, StoreCommand, StoreEntity, StorePolicy, StoreTable, WorldStore } from './types.ts'

interface Options { readonly expected?: number; readonly review?: ReviewReceipt; readonly policy?: StorePolicy }
type Outcome = { readonly world: WorldStore; readonly state: FormalState | undefined } | { readonly code: string }
const attempt = (fn: () => Outcome): Outcome => {
  try { return fn() } catch (error) { if (error instanceof StoreError) return {code:error.code}; throw error }
}
const viaG1 = (world: WorldStore, commands: readonly StoreCommand[], o: Options): Outcome => attempt(() => ({
  world: applyStoreCommands(world,commands,o.expected ?? world.revision,{policy:o.policy,acceptedReview:o.review}), state: undefined,
}))
const viaFormal = (state: FormalState, commands: readonly StoreCommand[], o: Options): Outcome => attempt(() => {
  const changes = planCommands(memoryReader(state),commands as unknown as readonly FormalCommand[],
    {baseRevision:o.expected ?? state.revision,now:NOW,policy:o.policy,acceptedReview:o.review})
  const next = applyChangeSet(state,changes)
  return {world:worldFromFormal(next),state:next}
})
const describe = (o: Outcome) => 'code' in o ? o.code : 'accepted'
/** undefined when the two outcomes agree, otherwise a short reason. */
function disagreement(g1: Outcome, formal: Outcome, commands: readonly StoreCommand[]): string | undefined {
  if ('code' in g1 && 'code' in formal) {
    if (g1.code === formal.code) return undefined
    if (g1.code === 'E_REFERENCE' && formal.code === 'E_DEPENDENTS' && commands.some(c => c.op === 'remove')) return undefined
    return `codes differ: ${g1.code} / ${formal.code}`
  }
  if ('code' in g1 || 'code' in formal) return `only one path accepted: ${describe(g1)} / ${describe(formal)}`
  return jsonKey(g1.world) === jsonKey(formal.world) ? undefined : 'accepted with different results'
}
function compare(world: WorldStore, commands: readonly StoreCommand[], o: Options = {}) {
  const g1 = viaG1(world,commands,o), formal = viaFormal(formalFromWorld(world),commands,o)
  assert.equal(disagreement(g1,formal,commands),undefined)
  return {g1:describe(g1),formal:describe(formal),world:'world' in g1 ? g1.world : world}
}
const create = (table: StoreTable, value: unknown): StoreCommand => ({op:'create',table,value:value as AnyStoreRow})
const update = (table: StoreTable, value: AnyStoreRow, expectedRevision = value.revision - 1): StoreCommand => ({op:'update',table,id:value.id,expectedRevision,value})
const remove = (table: StoreTable, row: AnyStoreRow): StoreCommand => ({op:'remove',table,id:row.id,expectedRevision:row.revision})
const book = (n: number, fields: Record<string,string> = {author:'A'}): StoreEntity =>
  ({id:id(n),revision:0,typeId:'custom:book',title:title('Book '+n),fields,source:source('book-'+n),visibility:'private'})
const film = {id:'custom:film',revision:0,title:title('Film'),schemaVersion:1,fields:[{key:'director',kind:'text'}]}
const withFilm = (): WorldStore => applyStoreCommands(commonFixture(),[create('entityTypes',film),
  create('entities',{id:id(70),revision:0,typeId:'custom:film',title:title('Film'),fields:{director:'D'},source:source('film-70'),visibility:'private'})],0)
const review: ReviewReceipt = {id:'review-one',revision:0,proposalId:'proposal-one',sourceId:'test:ai',acceptedAt:NOW}
const aiEntry = (n: number, reviewId?: string): LayerEntry => ({...entry(n),source:{...source('ai-'+n,'test:ai'),...(reviewId ? {reviewId} : {})}})

test('hand-written scenarios: both paths agree on result or error code',()=>{
  const w = commonFixture(), e10 = w.entries[0], e1 = w.entities[0]
  const cases: [string, WorldStore, StoreCommand[], string, Options?][] = [
    ['create', w, [create('entities',book(50)),create('entries',{...entry(60),entityId:id(50)})], 'accepted'],
    ['identical create is a no-op', w, [create('entities',e1)], 'accepted'],
    ['conflicting create', w, [create('entities',{...e1,title:title('Other')})], 'E_CONFLICT'],
    ['update', w, [update('entries',{...e10,revision:1,fields:{rating:4,note:'n'}})], 'accepted'],
    ['stale store revision', w, [update('entries',{...e10,revision:1})], 'E_STALE', {expected:w.revision+1}],
    ['stale row revision', w, [update('entries',{...e10,revision:1},9)], 'E_STALE'],
    ['unknown row', w, [remove('entries',entry(999))], 'E_NOT_FOUND'],
    ['create with nonzero revision', w, [create('entities',{...book(50),revision:1})], 'E_REVISION'],
    ['update that skips a revision', w, [update('entries',{...e10,revision:2},0)], 'E_REVISION'],
    ['source identity is immutable', w, [update('entries',{...e10,revision:1,source:source('moved')})], 'E_SOURCE_IDENTITY'],
    ['entry layer is immutable', w, [update('entries',{...e10,revision:1,layerId:'user:favorites'})], 'E_IDENTITY'],
    ['entry createdAt is immutable', w, [update('entries',{...e10,revision:1,createdAt:'2026-10-01T00:00:00.000Z'})], 'E_IDENTITY'],
    ['entity type is immutable', withFilm(), [update('entities',{...e1,revision:1,typeId:'custom:film'})], 'E_IDENTITY'],
    ['updatedAt never moves back', w, [update('entries',{...e10,revision:1,updatedAt:'2026-10-01T00:00:00.000Z'})], 'E_TIME'],
    ['entry identity collision', w, [create('entries',{...e10,id:id(50)})], 'E_SOURCE_COLLISION'],
    ['same raw record from another source is distinct', w, [create('entries',{...e10,id:id(50),source:source('record-10','test:planned')})], 'accepted'],
    ['unconfirmed AI source', w, [create('entries',aiEntry(50))], 'E_UNCONFIRMED'],
    ['AI source with a foreign review id', w, [create('entries',aiEntry(50,'review-one'))], 'E_UNCONFIRMED'],
    ['accepted review confirms AI content', w, [create('entries',aiEntry(50,'review-one'))], 'accepted', {review}],
    ['review receipts are not commands', w, [create('reviews',review)], 'E_REVIEW_COMMAND'],
    ['field of the wrong type', w, [create('entities',book(50,{author:5 as unknown as string}))], 'E_FIELDS'],
    ['number field out of range', w, [create('entries',{...entry(50),fields:{rating:6}})], 'E_FIELDS'],
    ['number field with text', w, [create('entries',{...entry(50),fields:{rating:'five' as unknown as number}})], 'E_NUMBER'],
    ['invalid calendar date', w, [create('entries',{...entry(50),fields:{readAt:'2025-02-30'}})], 'E_DATE'],
    ['missing required field', w, [create('entities',book(50,{}))], 'E_REQUIRED'],
    ['unknown field', w, [create('entities',book(50,{author:'A',unknown:'x'}))], 'E_FIELDS'],
    ['unknown row key', w, [create('entities',{...book(50),unexpected:true})], 'E_SHAPE'],
    ['entry fields belong to the layer, not the entity type', w, [create('entries',{...entry(50),fields:{author:'A'}})], 'E_FIELDS'],
    ['missing entity', w, [create('entries',{...entry(50),entityId:id(999)})], 'E_REFERENCE'],
    ['missing layer', w, [create('entries',{...entry(50),layerId:'user:missing'})], 'E_REFERENCE'],
    ['missing entity type', w, [create('entities',{...book(50),typeId:'custom:missing'})], 'E_REFERENCE'],
    ['missing relation end', w, [create('relations',{...w.relations[0],id:'relation-two',toEntityId:id(999)})], 'E_REFERENCE'],
    ['missing evidence', w, [create('entities',{...book(50),source:{...source('b'),evidenceIds:['missing']}})], 'E_REFERENCE'],
    ['missing field reference', w, [create('entities',book(50,{author:'A',related:id(999)}))], 'E_REFERENCE'],
    ['entity type not accepted by the layer', withFilm(), [create('entries',{...entry(50),entityId:id(70)})], 'E_TYPE'],
    ['relation end of the wrong type', withFilm(), [create('relations',{...w.relations[0],id:'relation-two',toEntityId:id(70)})], 'E_TYPE'],
    ['create then reference in one batch', w, [create('entities',book(50)),create('entries',{...entry(60),entityId:id(50)}),
      create('anchors',{...w.anchors[0],id:'anchor-two',entityId:id(50)}),create('relations',{...w.relations[0],id:'relation-two',toEntityId:id(50)})], 'accepted'],
    ['remove dependents first, then the row', w, [remove('sequences',w.sequences[0]),remove('entries',e10)], 'accepted'],
    ['remove then recreate in one batch', w, [remove('relations',w.relations[0]),create('relations',w.relations[0])], 'E_RECREATE_ID'],
    ['evidence is immutable', w, [update('evidence',{...w.evidence[0],revision:1,attributes:{}})], 'E_SCHEMA_CHANGE'],
    ['system key without host policy', w, [create('layers',{...w.layers[1],id:'user:travel',systemKey:'travel'})], 'E_SYSTEM_KEY'],
    ['system key bound by host policy', w, [create('layers',{...w.layers[1],id:'user:travel',systemKey:'travel'})], 'accepted', {policy:{officialLayers:{travel:'user:travel'}}}],
  ]
  for (const [name,world,commands,expected,options] of cases) {
    const result = compare(world,commands,options)
    assert.equal(result.g1,expected,name)
  }
  // Replay needs a store that already holds the receipt; both paths look it up.
  const reviewed = compare(w,[create('entries',aiEntry(50,'review-one'))],{review}).world
  assert.equal(compare(reviewed,[create('entries',aiEntry(51,'review-one'))],{review}).g1,'E_REVIEW_REPLAY')
  assert.equal(compare(reviewed,[create('entities',book(52))],{review:{...review,id:'review-two'}}).g1,'E_REVIEW_REPLAY')
  assert.equal(compare(reviewed,[update('entries',{...reviewed.entries[3],revision:1,fields:{rating:3}})]).g1,'accepted')
  // The one listed code difference: deleting a referenced row.
  const referenced = compare(w,[remove('entries',e10)])
  assert.deepEqual([referenced.g1,referenced.formal],['E_REFERENCE','E_DEPENDENTS'])
})

/** Deterministic LCG; fixed seeds keep every run identical. */
const generator = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }
const VALID = ['entity','entry','entry','anchor','relation','asset','updateEntry','updateEntity','duplicate','removeLeaf'] as const
const FAULTS = ['conflict','staleStore','staleRow','notFound','revision','sourceIdentity','layerMove','typeChange','timeBack','collision',
  'unconfirmed','fieldType','required','unknownField','reference','typeLimit','reviewCommand','evidence','recreate','dependents','date'] as const

function randomBatch(world: WorldStore, random: () => number, counter: { n: number }) {
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

test('random command sequences (fixed seeds): both paths agree batch by batch',t=>{
  const seen = new Map<string,number>(), problems: string[] = []
  let batches = 0, dependents = 0
  for (let sequence = 0; sequence < 220; sequence++) {
    const random = generator(0xc0ffee + sequence), counter = {n:100000 + sequence * 1000}
    let world = withFilm(), state = formalFromWorld(world)
    for (let step = 0; step < 4; step++) {
      const {commands,options} = randomBatch(world,random,counter)
      if (!commands.length) continue
      batches++
      const g1 = viaG1(world,commands,options), formal = viaFormal(state,commands,options)
      const problem = disagreement(g1,formal,commands)
      if (problem && problems.length < 5) problems.push(`sequence ${sequence} step ${step}: ${problem} ${JSON.stringify(commands.map(c => [c.op,c.table]))}`)
      const key = describe(g1); seen.set(key,(seen.get(key) ?? 0) + 1)
      if (key !== describe(formal)) dependents++
      if ('world' in g1 && 'world' in formal && formal.state) { world = g1.world; state = formal.state }
    }
  }
  t.diagnostic(`sequences 220, batches ${batches}, G1 E_REFERENCE as planner E_DEPENDENTS ${dependents}, G1 outcomes ${JSON.stringify(Object.fromEntries([...seen].sort()))}`)
  assert.deepEqual(problems,[])
  assert.ok(batches >= 800,`batches: ${batches}`)
  assert.ok((seen.get('accepted') ?? 0) >= 300,`accepted: ${seen.get('accepted')}`)
  for (const code of ['E_CONFLICT','E_STALE','E_NOT_FOUND','E_REVISION','E_SOURCE_IDENTITY','E_IDENTITY','E_TIME','E_SOURCE_COLLISION','E_UNCONFIRMED',
    'E_FIELDS','E_REQUIRED','E_REFERENCE','E_TYPE','E_REVIEW_COMMAND','E_SCHEMA_CHANGE','E_RECREATE_ID','E_DATE']) assert.ok(seen.has(code),`never produced ${code}`)
})
