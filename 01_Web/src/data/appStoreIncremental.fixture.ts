/// <reference types="node" />
/**
 * Test helpers (③, scope-incremental design §5): what a snapshot moved on by a commit's changed rows must be, against the
 * snapshot computed again from the whole read model. Not a test file itself.
 *
 * - `orderedText(value)`: the value as text in insertion order (object keys as they are, Maps and Sets by their entries,
 *   `undefined` kept, functions as a marker): equal texts are equal values byte for byte, key order included.
 * - `assertIncrementalStep(before, after, model, label)`: `after` (the store's snapshot after the changes) has the values of
 *   the snapshot computed from `model` alone (official view, the six data sections, their baseline with the functions
 *   evaluated, the time query context, the page queries); and its official view shares objects with `before` exactly as
 *   the structural sharing of today's whole projection does (`todayCanonical`), node by node.
 * - `sharingViolations(before, after, asked)`: the parts that kept inputs equal by identity but are new objects (the
 *   derivation steps and queries whose inputs a commit did not change must give the same object again).
 * - `askQueries(snapshot)`: the page queries of a snapshot (what the App asks for), to compare before and after.
 * - `randomRowChanges(rng, model, n)`: changed rows drawn directly (not through a planner) for the adversarial generator
 *   G3: view rows that change scope, position, flag or item, duplicates, deletions, entries that change layer, entities
 *   that change type or place, assets, sequences, evidence, and rows that must make the official view start over.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import assert from 'node:assert/strict'
import { computeSnapshot, type AppSnapshot, type ReadModelChanges } from './appStoreCore.ts'
import { buildBaseline, stableStringify } from './derive/baseline.ts'
import { reconcile } from './reconcile.ts'
import { officialViewOf } from './store/projectCanonical.ts'
import { VIEW_SCOPES, mapListScope } from './store/officialDefinitions.ts'
import type { CanonicalData } from './canonical/types.ts'
import { applyReadModelDelta } from '../worldgraph/readModel/delta.ts'
import type { ReadModel, ReadModelTable } from '../worldgraph/readModel/types.ts'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers.ts'
import type { LayerTimeFilters } from '../worldgraph/timeQuery.ts'
import type { Random } from './editor/doubleRun.fixture.ts'

export const OPTIONS = { source: 'local', now: '2026-10-22T00:00:00.000Z' } as const
export const IDENTITY = { libraryId: '01990000-0000-7000-8000-00000000d001', restoreMark: null }
const LAYERS = [TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID]
const ACTIVE: LayerTimeFilters = {
  travel: { from: '2000-01-01', to: '2100-12-31', includeUncertain: true },
  want_to_go: { from: '2000-01-01', to: '2100-12-31', includeUncertain: true },
}

/** The value as text in insertion order (see the file header). */
export function orderedText(value: unknown): string {
  const path = new Set<object>()
  const walk = (v: unknown): string => {
    if (v === undefined) return 'undefined'
    if (v === null || typeof v === 'boolean') return String(v)
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'function') return '[function]'
    if (typeof v !== 'object') return `[${typeof v}]`
    if (path.has(v)) throw new Error('orderedText: a cycle')
    path.add(v)
    try {
      if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`
      if (v instanceof Map) return `Map{${[...v].map(([key, member]) => `${walk(key)}=>${walk(member)}`).join(',')}}`
      if (v instanceof Set) return `Set{${[...v].map(walk).join(',')}}`
      const proto = Object.getPrototypeOf(v)
      const kind = proto === Object.prototype || proto === null ? '' : `${proto.constructor?.name ?? '?'}`
      return `${kind}{${Object.keys(v).map((key) => `${JSON.stringify(key)}:${walk((v as Record<string, unknown>)[key])}`).join(',')}}`
    } finally {
      path.delete(v)
    }
  }
  return walk(value)
}

/** Every object reachable from `root`: arrays, plain objects, and the members of Maps and Sets. */
export function objectsOf(root: unknown): Set<object> {
  const found = new Set<object>()
  const visit = (v: unknown) => {
    if (v === null || typeof v !== 'object' || found.has(v)) return
    found.add(v)
    if (v instanceof Map) for (const member of v.values()) visit(member)
    else if (v instanceof Set) for (const member of v) visit(member)
    else for (const member of Object.values(v)) visit(member)
  }
  visit(root)
  return found
}

/**
 * `actual` and `expected` hold equal values: at every object of the two trees (same path), being one of `previous`'s
 * objects must be the same on both sides. Below a node both keep, nothing more is compared (it is the same object).
 */
export function assertSameSharing(actual: unknown, expected: unknown, previous: ReadonlySet<object>, label: string, path = '$'): void {
  if (actual === null || typeof actual !== 'object' || expected === null || typeof expected !== 'object') return
  const kept = previous.has(actual), keptExpected = previous.has(expected)
  assert.equal(kept, keptExpected, `${label}: at ${path} the incremental snapshot ${kept ? 'keeps' : 'does not keep'} the earlier object, today's sharing ${keptExpected ? 'does' : 'does not'}`)
  if (kept) return
  if (actual instanceof Map && expected instanceof Map) {
    for (const [key, member] of actual) assertSameSharing(member, expected.get(key), previous, label, `${path}<${String(key)}>`)
    return
  }
  if (actual instanceof Set) return
  for (const key of Object.keys(actual)) assertSameSharing((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], previous, label, `${path}.${key}`)
}

/** The official view today's store gives after `previous` for `model`: the whole projection, each section reconciled. */
export function todayCanonical(previous: CanonicalData, model: ReadModel): CanonicalData {
  const fresh = officialViewOf(model, 'local')
  const merged: Record<string, unknown> = {}
  let same = true
  for (const key of Object.keys(fresh) as (keyof CanonicalData)[]) {
    merged[key] = reconcile(previous[key], fresh[key])
    if (merged[key] !== previous[key]) same = false
  }
  return same ? previous : merged as unknown as CanonicalData
}

/** The page's queries on a snapshot: what the App asks for (the map without and with active time filters, Collection). */
export function askQueries(snapshot: AppSnapshot) {
  return {
    context: snapshot.timeQueryContext(),
    visible: snapshot.queries.visiblePlaces(LAYERS),
    visibleFiltered: snapshot.queries.visiblePlaces(LAYERS, ACTIVE),
    browse: snapshot.queries.browseProjection({}),
    browseFiltered: snapshot.queries.browseProjection(ACTIVE),
    collection: snapshot.queries.collection('en'),
  }
}
export type AskedQueries = ReturnType<typeof askQueries>

const baselineOf = (snapshot: AppSnapshot) => stableStringify(buildBaseline(snapshot.appData as never, { now: OPTIONS.now }))

/** See the file header. Returns the snapshot computed from `model` alone. */
export function assertIncrementalStep(before: AppSnapshot, after: AppSnapshot, model: ReadModel, label: string): AppSnapshot {
  const full = computeSnapshot(model, { ...OPTIONS, identity: IDENTITY })
  assert.equal(after.revision, full.revision, `${label}: revision`)
  assert.deepEqual(after.model, model, `${label}: read model`)
  assert.equal(orderedText(after.canonical), orderedText(full.canonical), `${label}: official view, byte for byte`)
  assert.deepStrictEqual(after.canonical, full.canonical, `${label}: official view`)
  for (const key of Object.keys(full.appData) as (keyof AppSnapshot['appData'])[]) {
    assert.equal(orderedText(after.appData[key]), orderedText(full.appData[key]), `${label}: derived data ${key}, byte for byte`)
  }
  assert.equal(baselineOf(after), baselineOf(full), `${label}: derived baseline (functions evaluated)`)
  const asked = askQueries(after), expected = askQueries(full)
  for (const key of Object.keys(expected) as (keyof AskedQueries)[]) {
    assert.equal(orderedText(asked[key]), orderedText(expected[key]), `${label}: ${key}, byte for byte`)
    assert.deepStrictEqual(asked[key], expected[key], `${label}: ${key}`)
  }
  assertSameSharing(after.canonical, todayCanonical(before.canonical, model), objectsOf(before.canonical), `${label}: official view sharing`)
  return full
}

/**
 * The parts whose inputs a commit kept (by identity) and that must therefore be the same objects (design §5.1 group 3):
 * returns what is a new object although it should not be. `asked` are `before`'s queries, asked before the commit.
 */
export function sharingViolations(before: AppSnapshot, after: AppSnapshot, asked: AskedQueries): string[] {
  const b = before.canonical, a = after.canonical, be = b.editorState, ae = a.editorState
  const same = (...pairs: [unknown, unknown][]) => pairs.every(([x, y]) => x === y)
  const violations: string[] = []
  const expect = (holds: boolean, name: string, kept: boolean) => { if (holds && !kept) violations.push(name) }
  const sections = (key: keyof AppSnapshot['appData']) => after.appData[key] === before.appData[key]
  const now = askQueries(after)
  if (a === b) {
    for (const key of Object.keys(after.appData) as (keyof AppSnapshot['appData'])[]) expect(true, `nothing changed: ${key}`, sections(key))
    for (const key of Object.keys(asked) as (keyof AskedQueries)[]) expect(true, `nothing changed: ${key}`, now[key] === asked[key])
  }
  const media = same([a.media, b.media], [a.places, b.places], [ae.hiddenMediaIds, be.hiddenMediaIds], [ae.hiddenDroneMediaIds, be.hiddenDroneMediaIds],
    [ae.mediaOrderByCity, be.mediaOrderByCity], [ae.coverMediaByCity, be.coverMediaByCity], [ae.droneOrderByCity, be.droneOrderByCity])
  expect(media, 'mediaCatalog (its inputs kept)', sections('mediaCatalog'))
  expect(media, 'droneMedia (its inputs kept)', sections('droneMedia'))
  const travel = same([a.travel, b.travel], [a.places, b.places], [ae.hiddenCountryIds, be.hiddenCountryIds], [ae.hiddenCityIds, be.hiddenCityIds],
    [ae.addedCountries, be.addedCountries], [ae.cityOrderByCountry, be.cityOrderByCountry], [ae.countryOrder, be.countryOrder])
  expect(travel, 'travelAtlas (its inputs kept)', sections('travelAtlas'))
  expect(same([ae, be], [a.places, b.places]), 'editorState (its inputs kept)', sections('editorState'))
  expect(same([a.wantToGo, b.wantToGo], [a.places, b.places], [a.travel, b.travel]), 'wantToGo (its inputs kept)', sections('wantToGo'))
  const graph = same([a.places, b.places], [a.wantToGo, b.wantToGo], [a.travel, b.travel]) && sections('travelAtlas')
  expect(graph, 'worldGraph (its inputs kept)', sections('worldGraph'))
  const context = same([a.places, b.places], [a.travel, b.travel], [a.wantToGo, b.wantToGo], [ae.hiddenCountryIds, be.hiddenCountryIds],
    [ae.hiddenCityIds, be.hiddenCityIds], [ae.addedCountries, be.addedCountries])
  expect(context, 'time query context (its inputs kept)', now.context === asked.context)
  const sameGraph = sections('worldGraph'), sameContext = now.context === asked.context
  expect(sameGraph, 'visiblePlaces (the graph kept)', now.visible === asked.visible)
  expect(sameGraph, 'collection (the graph kept)', now.collection === asked.collection)
  expect(sameContext, 'browseProjection (the context kept)', now.browse === asked.browse && now.browseFiltered === asked.browseFiltered)
  expect(sameGraph && sameContext, 'visiblePlaces with filters (graph and context kept)', now.visibleFiltered === asked.visibleFiltered)
  return violations
}

/** The changes of a whole read model to another of the same library, as the store applies them. */
export const changesOf = (from: number, upserts: readonly { table: string; row: unknown }[], deletes: readonly { table: string; id: string }[]): ReadModelChanges => ({
  libraryId: IDENTITY.libraryId, restoreMark: null, from, to: from + 1, upserts, deletes,
})

type Row = Record<string, unknown> & { readonly id: string; readonly revision: number }
const tableOf = (model: ReadModel, table: ReadModelTable) => model[table] as unknown as readonly Row[]
const bump = (row: Row, patch: Record<string, unknown>): Row => ({ ...row, ...patch, revision: (row.revision as number) + 1 })

/**
 * One random change of rows (G3), drawn directly from the read model: `undefined` when the drawn kind has no row to
 * change. Kinds that must make the official view start over (places, part-of, locations, sources, unknown scopes, layers
 * and tables) are drawn too.
 */
export function randomRowChange(rng: Random, model: ReadModel, n: number): ReadModelChanges | undefined {
  const items = tableOf(model, 'viewItems'), settings = tableOf(model, 'viewSettings')
  const scopes = [...new Set(items.map((row) => row.scope as string))]
  const upsert = (table: ReadModelTable, row: Row) => changesOf(model.revision, [{ table, row }], [])
  const remove = (table: ReadModelTable, row: Row | undefined) => (row ? changesOf(model.revision, [], [{ table, id: row.id }]) : undefined)
  const pick = <T,>(rows: readonly T[]) => rng.pick(rows)
  if (rng.chance(0.06)) { // a media list gets an asset (so that a later change of that asset reaches the list)
    const asset = pick(tableOf(model, 'assets')); if (!asset) return undefined
    const scope = rng.pick([VIEW_SCOPES.hiddenMedia, VIEW_SCOPES.hiddenDroneMedia, mapListScope(VIEW_SCOPES.mediaOrderByCity, String(pick(tableOf(model, 'entities').filter((e) => e.typeId === 'starmap:place'))?.id))])!
    return upsert('viewItems', { id: `${scope}#0000fuzz-${String(n).padStart(4, '0')}`, revision: 0, scope, itemTable: 'assets', itemId: asset.id, position: `a${n}`, hidden: false })
  }
  switch (rng.int(16)) {
    case 0: { // a view item moves
      const row = pick(items); if (!row) return undefined
      const other = pick(items)!
      return upsert('viewItems', bump(row, { position: rng.chance(0.5) ? other.position : `${row.position as string}V` }))
    }
    case 1: { // a view item's flag
      const row = pick(items); if (!row) return undefined
      return upsert('viewItems', bump(row, { hidden: !(row.hidden as boolean) }))
    }
    case 2: { // a view item changes scope (sometimes to one the official view does not know)
      const row = pick(items); if (!row) return undefined
      return upsert('viewItems', bump(row, { scope: rng.chance(0.2) ? 'test:unknown-scope' : pick(scopes) }))
    }
    case 3: { // a view item refers to another item of its table
      const row = pick(items); if (!row) return undefined
      const other = pick(items.filter((candidate) => candidate.itemTable === row.itemTable))!
      return upsert('viewItems', bump(row, { itemId: other.itemId }))
    }
    case 4: { // a duplicate view item (first by id wins where the projection takes one)
      const row = pick(items); if (!row) return undefined
      return upsert('viewItems', { ...row, id: `${row.scope as string}#0000fuzz-${String(n).padStart(4, '0')}`, revision: 0, position: rng.chance(0.5) ? row.position : `${row.position as string}D` })
    }
    case 5: return rng.chance(0.7) ? remove('viewItems', pick(items)) : remove('viewSettings', pick(settings))
    case 6: { // a view setting's value or reference
      const row = pick(settings); if (!row) return undefined
      if (row.ref !== undefined && rng.chance(0.6)) {
        const asset = pick(tableOf(model, 'assets'))
        return asset ? upsert('viewSettings', bump(row, { ref: { table: 'assets', id: asset.id } })) : undefined
      }
      return upsert('viewSettings', bump(row, { value: rng.chance(0.5) ? `fuzz-${n}` : [] }))
    }
    case 7: { // an entry's fields
      const row = pick(tableOf(model, 'entries')); if (!row) return undefined
      const fields = row.fields as Record<string, unknown>
      return upsert('entries', bump(row, { fields: { ...fields, note: `Fuzz ${n}`, ...(typeof fields.addedAt === 'string' ? { addedAt: '2024-02-0' + (1 + rng.int(9)) } : {}) } }))
    }
    case 8: { // an entry changes layer (official or not)
      const row = pick(tableOf(model, 'entries')); if (!row) return undefined
      const layers = tableOf(model, 'layers').map((layer) => layer.id)
      return upsert('entries', bump(row, { layerId: rng.chance(0.2) ? 'test:unknown-layer' : pick(layers) }))
    }
    case 9: return remove('entries', pick(tableOf(model, 'entries')))
    case 10: { // an entity: a media item's place or title, a journey's identity, another type, a place's title
      const row = pick(tableOf(model, 'entities')); if (!row) return undefined
      const places = tableOf(model, 'entities').filter((entity) => entity.typeId === 'starmap:place')
      const fields = row.fields as Record<string, unknown>
      if (rng.chance(0.15)) return upsert('entities', bump(row, { typeId: pick(tableOf(model, 'entityTypes').map((type) => type.id)) }))
      if (row.typeId === 'starmap:media' && rng.chance(0.6)) return upsert('entities', bump(row, { fields: { ...fields, place: pick(places)!.id } }))
      return upsert('entities', bump(row, { title: { names: { en: `Fuzz ${n}` } } }))
    }
    case 11: { // an asset's attributes, or an asset gone
      const row = pick(tableOf(model, 'assets')); if (!row) return undefined
      if (rng.chance(0.25)) return remove('assets', row)
      const attributes = row.attributes as Record<string, unknown>
      return upsert('assets', bump(row, { attributes: { ...attributes, status: rng.chance(0.5) ? 'needsMetadata' : 'ready', date: `2023-0${1 + rng.int(9)}-1${rng.int(9)}` } }))
    }
    case 12: { // a sequence's members, or a sequence gone
      const row = pick(tableOf(model, 'sequences')); if (!row) return undefined
      if (rng.chance(0.25)) return remove('sequences', row)
      return upsert('sequences', bump(row, { entryIds: rng.shuffle(row.entryIds as string[]) }))
    }
    case 13: { // an evidence row's attributes
      const row = pick(tableOf(model, 'evidence')); if (!row) return undefined
      return upsert('evidence', bump(row, { attributes: { ...(row.attributes as Record<string, unknown>), region: `Fuzz ${n}` } }))
    }
    case 14: { // rows that make the official view start over: a location, a part-of, a source
      const table = (['anchors', 'relations', 'sources'] as const)[rng.int(3)]
      const row = pick(tableOf(model, table)); if (!row) return undefined
      if (table === 'anchors') return upsert(table, bump(row, { lat: (row.lat as number) + 0.5 }))
      if (table === 'relations' && rng.chance(0.5)) return remove(table, row)
      return upsert(table, bump(row, { extensions: { fuzz: n } }))
    }
    default: { // a table the read model does not have (ignored by the model, but not understood: start over)
      const row = pick(items); if (!row) return undefined
      return changesOf(model.revision, [{ table: 'test:unknown-table', row: { ...row } }], [])
    }
  }
}

/** The read model after `changes` (the store's own way of moving on). */
export const modelAfter = (model: ReadModel, changes: ReadModelChanges): ReadModel => ({
  ...applyReadModelDelta(model, { baseRevision: changes.from, nextRevision: changes.from + 1, upserts: changes.upserts as never, deletes: changes.deletes as never }),
})
