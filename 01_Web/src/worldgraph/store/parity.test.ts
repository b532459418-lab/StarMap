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
import { book, create, generator, randomBatch, remove, review, update, withFilm } from './parity.fixture.ts'
import type { FormalCommand, FormalState } from './formal.ts'
import { memoryReader } from './reader.ts'
import { applyChangeSet, planCommands } from './planner.ts'
import { applyStoreCommands } from './commands.ts'
import { StoreError, jsonKey } from './schema.ts'
import type { LayerEntry, ReviewReceipt, StoreCommand, StorePolicy, WorldStore } from './types.ts'

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
    ['a null source is a source move, not a crash', w, [update('entries',{...e10,revision:1,source:null as unknown as LayerEntry['source']})], 'E_SOURCE_IDENTITY'],
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
