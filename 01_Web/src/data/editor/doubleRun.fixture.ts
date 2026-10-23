/// <reference types="node" />
/** The double run of the two write engines (3C-5 C1 spec §2.4, design 3C-5 §9): a shadow comparison in tests only.
 * Production writes run one engine and commit once.
 *
 * From one store state, the same request runs
 * - in the old engine: the V2 write function on the store's V2 view, diffV2ToCommands, planCommands, applyChangeSet
 *   (3C-4a; for the view operations the request it replaces: the page's whole editor state after its own merge, PUT);
 * - in the native engine: the store-native planner (../editor/native/) on the official reader of the state's index,
 *   planCommands, applyChangeSet.
 * Compared: the error code and parameters (the place and journey candidates, in their order, are parameters), and the
 * derived baseline of both states with ids renamed in the order they first appear, without the changes design §9
 * makes on purpose (new ids, journey ids without the `journey-` prefix, V2-only values such as `type`, `status` and
 * `source`, file headers, unknown media ids in view operations).
 *
 * Sequences go on from the second engine's state (the engine the host runs); at every step both engines start from it.
 * Endpoints that have no native planner (they still run the V2 functions in the host) run the old engine twice — the
 * stand-in (standInEngine), which also checks the comparison itself. Since 3C-5 C2 every endpoint the sequences draw has a
 * native planner.
 * Only tracked neutral fixtures and invented values. Not imported by the App.
 */
import type { FormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { readModelOf } from '../../worldgraph/readModel/build.ts'
import { liveReadModelIndex } from '../../worldgraph/readModel/liveIndex.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import type { BridgeManifest } from '../canonical/storeBridgeIdentity.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import type { CanonicalData } from '../canonical/types.ts'
import type { V2Files } from '../canonical/v2Schema.ts'
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import { diffV2ToCommands, memoryDiffReader } from '../store/diffV2.ts'
import { filesAfter, viewOf } from '../store/diffV2.fixture.ts'
import { OFFICIAL_POLICY } from '../store/officialDefinitions.ts'
import { officialReader } from '../store/officialReader.ts'
import { projectStoreToCanonical } from '../store/projectCanonical.ts'
import { migrateIntoEmptyStore } from '../store/v2Store.fixture.ts'
import {
  V2WriteError, addCountry, addTravelRecord, addWantToGo, convertToTravel, deleteHiddenCountries, deleteHiddenWantToGo, putEditorState,
  readEditorStateV1, updateWantToGo,
} from '../v2write/index.ts'
import type { V2WriteContext, V2WriteOutcome } from '../v2write/transaction.ts'
import { TEST_CATALOG, WRITE_EPOCH_MS, WRITE_NOW } from './editor.fixture.ts'
import type { NativeWrite } from './native/routes.ts'
import { applyViewOperations, type ViewLists, type ViewOperation } from './rules/editorView.ts'
import { applySetDelta, mergeOrder } from '../editorStateDelta.ts'
import type { TravelAtlasEditorState } from '../derive/editorState.ts'

export interface DoubleRunStore {
  state: FormalState
  readonly manifest: BridgeManifest
}
/** One step: what the old engine runs on the V2 view, and the same request for the native engine (when it has one). */
export interface DoubleRunStep {
  readonly label: string
  /** The endpoint (`METHOD /path`), for the native planner. */
  readonly route: string
  /** The request body the native engine gets. */
  readonly input: unknown
  /** The old engine: the V2 write on the view (for a view operation: its PUT of the page's merged state). */
  readonly old: (files: V2Files, ctx: V2WriteContext) => V2WriteOutcome<unknown>
  /** The stand-in's request where it is not `old` (see standInEngine). */
  readonly standIn?: (files: V2Files, ctx: V2WriteContext) => V2WriteOutcome<unknown>
  /** Compare the responses too (default true; a view operation answers with its revision only). */
  readonly compareResult?: boolean
}
/** The endpoint of the view operations (3C-5 C1 replaces `PUT /state`). */
export const VIEW_ROUTE = 'POST /__travelatlas/editor/view'
export interface EngineOutcome {
  readonly error?: { readonly code: string; readonly params?: unknown }
  readonly result?: unknown
  readonly state?: FormalState
  readonly commands?: number
}

/** A store migrated from `files`. */
export function doubleRunStore(files: V2Files): DoubleRunStore {
  const { state, result } = migrateIntoEmptyStore(files)
  return { state, manifest: result.manifest }
}

/** A step's context: the write's time and ids (both engines get identical ones), and the old engine's diff ids. */
export interface StepContext extends V2WriteContext {
  readonly diffIds: () => string
}
/** The context of step `n` (up to 1000 ids each, never shared between steps or with the migration's ids). */
export function stepContext(n: number): StepContext {
  return {
    newId: sequentialUuids(WRITE_EPOCH_MS + n * 1000), now: new Date(WRITE_NOW.getTime() + n * 60_000), countryCatalog: TEST_CATALOG,
    diffIds: sequentialUuids(Date.UTC(2040, 0, 1) + n * 1000),
  }
}

const refused = (error: unknown): EngineOutcome => {
  if (error instanceof V2WriteError) return { error: { code: error.code, ...(error.params !== undefined ? { params: error.params } : {}) } }
  throw error
}

/** The old engine (see the file header). */
export function oldEngine(store: DoubleRunStore, step: DoubleRunStep, ctx: StepContext): EngineOutcome {
  const before = viewOf(store.state)
  let outcome: V2WriteOutcome<unknown>
  try { outcome = step.old(before, ctx) } catch (error) { return refused(error) }
  const after = filesAfter(before, outcome.writes)
  const now = ctx.now.toISOString()
  const identities = new Map(store.manifest.identities.map(row => [JSON.stringify([row.kind, row.sourceId, row.recordId]), row.id]))
  const diff = diffV2ToCommands(before, after, {
    reader: memoryDiffReader(store.state), identity: (kind, sourceId, recordId) => identities.get(JSON.stringify([kind, sourceId, recordId])),
    now, allocateId: ctx.diffIds,
  })
  const changeSet = planCommands(memoryReader(store.state), diff.commands, { baseRevision: store.state.revision, now, policy: OFFICIAL_POLICY })
  return { result: outcome.result, state: applyChangeSet(store.state, changeSet), commands: diff.commands.length }
}

/** An engine: one step from the store's state, without changing the store. */
export type Engine = (store: DoubleRunStore, step: DoubleRunStep, ctx: StepContext) => EngineOutcome

/** The native engine of `write` (see the file header): the planner on the official reader of the state's live index. */
export function nativeEngineOf(write: NativeWrite): Engine {
  return (store, step, ctx) => {
    const reader = officialReader(liveReadModelIndex(readModelOf(store.state, { origin: 'local' })))
    let plan
    try {
      plan = write.plan(reader, structuredClone(step.input), { now: ctx.now, newId: ctx.newId, countryCatalog: ctx.countryCatalog })
    } catch (error) { return refused(error) }
    // Nothing to change: nothing is committed (the host answers with the same revision).
    if (plan.commands.length === 0) return { result: plan.result, state: store.state, commands: 0 }
    const now = ctx.now.toISOString()
    const changeSet = planCommands(memoryReader(store.state), plan.commands, { baseRevision: store.state.revision, now, policy: OFFICIAL_POLICY })
    return { result: plan.result, state: applyChangeSet(store.state, changeSet), commands: plan.commands.length }
  }
}

/**
 * The stand-in of an endpoint without a native planner: the old engine again, with the step's `standIn` request where it
 * has one and other diff ids. It is what the host runs for that endpoint, and it checks the comparison itself: ids that
 * differ only by allocation, and the media ids a view operation ignores, must not count as differences.
 */
export const standInEngine: Engine = (store, step, ctx) =>
  oldEngine(store, step.standIn ? { ...step, old: step.standIn } : step, { ...ctx, diffIds: sequentialUuids(Date.UTC(2045, 0, 1) + (ctx.now.getTime() - WRITE_NOW.getTime()) / 60) })

export interface Engines {
  /** The endpoints that have a native planner. */
  readonly native: ReadonlySet<string>
  engineFor(route: string): Engine
}
/** The engines of a double run: the native planner of an endpoint where `natives` has one, else the stand-in. */
export function enginesFor(natives: Readonly<Record<string, NativeWrite>>): Engines {
  const engines = new Map(Object.entries(natives).map(([route, write]) => [route, nativeEngineOf(write)] as const))
  return { native: new Set(engines.keys()), engineFor: (route) => engines.get(route) ?? standInEngine }
}

const NOW = '2000-01-01T00:00:00.000Z'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** File header values (design §9 change 3) and V2-only values of new records (change 2). */
const HEADER_KEYS = new Set(['updatedAt', 'generatedAt', 'generated_at'])
const V2_ONLY_SOURCE = 'local-editor'
/** V2-only values of new and converted records (design §9 change 2): `type: 'visit'`, `status: 'visited'`. */
const V2_ONLY_VALUES: Readonly<Record<string, unknown>> = { source: V2_ONLY_SOURCE, type: 'visit', status: 'visited' }
/** A new journey's id (design §9 change 1): `journey-<UUIDv7>` before, the journey entity's UUIDv7 now. */
const JOURNEY = /^journey-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

const canonicalOf = (state: FormalState): CanonicalData => projectStoreToCanonical(state, { source: 'local', track: false, freeze: false }).canonical

/**
 * Strings renamed `#n` in the order they first appear when they are UUIDs (keys too); other values as they are. With
 * `dropHeaders`, the file headers and the V2-only values of new records are left out (design §9 changes 2, 3).
 */
export function renameIdsForComparison(value: unknown, { dropHeaders }: { dropHeaders: boolean }): unknown {
  const names = new Map<string, string>()
  const rename = (text: string) => {
    if (!UUID.test(text) && !JOURNEY.test(text)) return text
    let name = names.get(text)
    if (!name) names.set(text, name = `#${names.size + 1}`)
    return name
  }
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return rename(item)
    if (Array.isArray(item)) return item.map(walk)
    if (item === null || typeof item !== 'object') return item
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(item)) {
      if (dropHeaders && HEADER_KEYS.has(key)) continue
      if (dropHeaders && Object.hasOwn(V2_ONLY_VALUES, key) && child === V2_ONLY_VALUES[key]) continue
      out[rename(key)] = walk(child)
    }
    return out
  }
  return walk(value)
}

/**
 * The derived baseline of a state, as JSON with every UUID renamed `#n` in the order it first appears (keys too), the file
 * headers left out, and the V2-only values (`source: 'local-editor'`, `type: 'visit'`, `status: 'visited'`) dropped; a new
 * journey's `journey-<UUID>` is renamed like a UUID. `adjust` changes the official view first.
 */
export function normalizedBaseline(state: FormalState, adjust?: (canonical: CanonicalData) => CanonicalData): unknown {
  const canonical = adjust ? adjust(canonicalOf(state)) : canonicalOf(state)
  return renameIdsForComparison(JSON.parse(stableStringify(buildBaseline(deriveAppDataFromCanonical(canonical, { now: NOW }), { now: NOW }))), { dropHeaders: true })
}

/**
 * Design §9 change 4 on the old engine's side of a view operation: the media ids the request brought into a media list
 * that are no media and that list did not hold (the old engine kept them as unresolved list elements; a view operation
 * ignores them). A cover set to such an id goes back to what it was.
 */
export function withoutUnknownMediaBrought(before: FormalState): (canonical: CanonicalData) => CanonicalData {
  const old = canonicalOf(before).editorState
  return (canonical) => {
    const media = new Set(canonical.media.items.map((item) => String(item.id)))
    const keep = (had: readonly string[] | undefined) => (ids: readonly string[]) => ids.filter((id) => media.has(id) || (had ?? []).includes(id))
    const keyed = (now: Record<string, string[]>, had: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(now).map(([key, ids]) => [key, keep(had[key])(ids)]))
    const e = canonical.editorState
    const covers: Record<string, string> = {}
    for (const [key, id] of Object.entries(e.coverMediaByCity)) {
      if (media.has(id) || old.coverMediaByCity[key] === id) covers[key] = id
      else if (old.coverMediaByCity[key] !== undefined) covers[key] = old.coverMediaByCity[key]
    }
    return {
      ...canonical,
      editorState: {
        ...e,
        hiddenMediaIds: keep(old.hiddenMediaIds)(e.hiddenMediaIds), hiddenDroneMediaIds: keep(old.hiddenDroneMediaIds)(e.hiddenDroneMediaIds),
        mediaOrderByCity: keyed(e.mediaOrderByCity, old.mediaOrderByCity), droneOrderByCity: keyed(e.droneOrderByCity, old.droneOrderByCity),
        coverMediaByCity: covers,
      },
    }
  }
}

/** Differences between the two outcomes of one step from `before` (empty: the same). */
export function compareOutcomes(before: FormalState, old: EngineOutcome, native: EngineOutcome, { viewOperation = false, result = true } = {}): string[] {
  const text = (value: unknown) => JSON.stringify(value)
  if (old.error || native.error) {
    if (!old.error || !native.error) return [`one engine refused: old ${text(old.error)} / native ${text(native.error)}`]
    const out: string[] = []
    if (old.error.code !== native.error.code) out.push(`code: old ${old.error.code} / native ${native.error.code}`)
    // New places get different ids in the two engines: compared by first appearance.
    const params = (error: NonNullable<EngineOutcome['error']>) => text(renameIdsForComparison(error.params, { dropHeaders: false }))
    if (params(old.error) !== params(native.error)) out.push(`params: old ${text(old.error.params)} / native ${text(native.error.params)}`)
    return out
  }
  const out: string[] = []
  const differ = (what: string, a: string, b: string) => {
    if (a === b) return
    // Point at the first differing character, with context.
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    out.push(`${what} differs at ${i}: old …${a.slice(Math.max(0, i - 160), i + 160)}… / native …${b.slice(Math.max(0, i - 160), i + 160)}…`)
  }
  if (result) differ('result', text(renameIdsForComparison(old.result, { dropHeaders: true })), text(renameIdsForComparison(native.result, { dropHeaders: true })))
  differ('derived baseline', text(normalizedBaseline(old.state!, viewOperation ? withoutUnknownMediaBrought(before) : undefined)), text(normalizedBaseline(native.state!)))
  return out
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** A request the V2 function and the native planner both take as it is. */
export function sameRequest(label: string, route: string, run: (files: V2Files, input: unknown, ctx: V2WriteContext) => V2WriteOutcome<unknown>, input: unknown): DoubleRunStep {
  return { label, route, input, old: (files, ctx) => run(files, structuredClone(input), ctx) }
}

/**
 * The page's merge before 3C-5 C1 (../editorStateDelta.ts's updaters, on the state GET /state returned): the country
 * order by mergeOrder, a city, photo or drone order replaced as a whole, a hidden list by applySetDelta (its additions
 * and removals), a cover set.
 */
export function oldPageMerge(current: TravelAtlasEditorState, operations: readonly ViewOperation[]): TravelAtlasEditorState {
  const hiddenField = { countries: 'hiddenCountryIds', cities: 'hiddenCityIds', media: 'hiddenMediaIds', drone: 'hiddenDroneMediaIds' } as const
  const mapField = { cities: 'cityOrderByCountry', media: 'mediaOrderByCity', drone: 'droneOrderByCity' } as const
  let next = current
  for (const operation of operations) {
    if (operation.op === 'order' && operation.scope === 'countries') next = { ...next, countryOrder: mergeOrder(next.countryOrder, operation.ids, operation.baseline) }
    else if (operation.op === 'order') {
      const field = mapField[operation.scope]
      next = { ...next, [field]: { ...next[field], [operation.key]: [...operation.ids] } }
    } else if (operation.op === 'hide') {
      const field = hiddenField[operation.scope]
      next = { ...next, [field]: applySetDelta<string>(next[field], operation.remove, operation.add) }
    } else next = { ...next, coverMediaByCity: { ...next.coverMediaByCity, [operation.key]: operation.id } }
  }
  return next
}

/**
 * A view operation: the native endpoint's operations. The old engine PUTs what the page sent before (oldPageMerge); the
 * stand-in PUTs the operations' own merge, unknown media ids left out, as the native planner does.
 */
export function viewStep(label: string, operations: readonly ViewOperation[]): DoubleRunStep {
  return {
    label, route: VIEW_ROUTE, input: { operations }, compareResult: false,
    old: (files, ctx) => putEditorState(files, oldPageMerge(readEditorStateV1(files, WRITE_NOW), operations), ctx),
    standIn: (files, ctx) => {
      const current = readEditorStateV1(files, WRITE_NOW)
      const media = new Set(files.media.items.map(item => item.id))
      return putEditorState(files, { ...current, ...applyViewOperations(current as unknown as ViewLists, operations, id => media.has(id)) }, ctx)
    },
  }
}

/** The V2 write functions by endpoint (the old engine of the steps a random sequence draws). */
export const OLD_WRITES = Object.freeze({
  records: addTravelRecord, countries: addCountry, countriesDelete: deleteHiddenCountries, wantToGo: addWantToGo, wantToGoUpdate: updateWantToGo,
  wantToGoDelete: deleteHiddenWantToGo, convert: convertToTravel,
})

/** Mulberry32: a small deterministic generator. */
export function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T,>(values: readonly T[]): T | undefined => (values.length ? values[int(values.length)] : undefined)
  const shuffle = <T,>(values: readonly T[]): T[] => {
    const out = [...values]
    for (let i = out.length - 1; i > 0; i--) { const j = int(i + 1); [out[i], out[j]] = [out[j], out[i]] }
    return out
  }
  return { next, int, pick, shuffle, chance: (p: number) => next() < p }
}
export type Random = ReturnType<typeof random>

const COUNTRY_CODES = ['IS', 'FO', 'NO', 'GL', 'JP', 'DK', 'CN']
const CITY_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']
const TITLES = ['Synthetic trip A', 'Synthetic trip B', undefined]
const dateOf = (rng: Random) => `20${20 + rng.int(8)}-0${1 + rng.int(9)}-1${rng.int(9)}`
/** `POST /__travelatlas/editor/<path>`. */
export const editorRoute = (path: string) => `POST /__travelatlas/editor/${path}`
const R = editorRoute

/**
 * One random request, drawn from the current V2 view (3C-4a's sequence, with the editor-state writes as the view
 * operations a page sends), over the eight editor endpoints.
 */
export function randomStep(rng: Random, files: V2Files): DoubleRunStep {
  const places = files.places.places
  const cities = places.filter(p => p.subtype === 'city'), countries = places.filter(p => p.subtype === 'country')
  const state = readEditorStateV1(files, WRITE_NOW)
  const mediaIds = [...files.media.items.map(m => m.id), 'synthetic-missing']
  switch (rng.int(12)) {
    case 0: {
      const title = rng.pick(TITLES)
      const journeys = [...new Set(files.travel.records.filter(r => r.status !== 'planned' && r.trip_title === title && r.journeyId).map(r => r.journeyId as string))]
      const choice = journeys.length && rng.chance(0.5) ? { journeyId: rng.pick(journeys)! } : rng.chance(0.3) ? { newJourney: true } : {}
      // Half the time a city without records (a want-to-go city): a city with records is E_CITY_EXISTS (3C-5 C2, so that
      // records by id also save and join journeys).
      const unrecorded = cities.filter(c => !files.travel.records.some(r => r.placeId === c.id))
      const city = unrecorded.length && rng.chance(0.5) ? rng.pick(unrecorded) : rng.pick(cities)
      if (city && rng.chance(0.4)) return sameRequest('records/placeId', R('records'), OLD_WRITES.records, { placeId: city.id, start_date: dateOf(rng), lat: 10, lng: 20, trip_title: title, ...choice })
      const code = rng.pick(COUNTRY_CODES)!
      return sameRequest('records/named', R('records'), OLD_WRITES.records, {
        country: code, country_en: code, city: rng.pick(CITY_NAMES)!, city_en: `${rng.pick(CITY_NAMES)} ${rng.int(1000)}`, start_date: dateOf(rng),
        lat: rng.int(80), lng: rng.int(170), country_code: code, trip_title: title, ...(rng.chance(0.3) ? { createNew: true } : {}), ...choice,
      })
    }
    case 1: return sameRequest('countries', R('countries'), OLD_WRITES.countries, { countryCode: rng.pick(COUNTRY_CODES), visitedDate: dateOf(rng) })
    case 2: {
      const hidden = state.hiddenCountryIds
      if (hidden.length && rng.chance(0.6)) return sameRequest('countries/delete', R('countries/delete'), OLD_WRITES.countriesDelete, { ids: [rng.pick(hidden)!] })
      const country = rng.pick(countries)
      // Hide a country (the delete flow's first step), or restore the hidden ones.
      if (country && rng.chance(0.7)) return viewStep('view/hide-country', [{ op: 'hide', scope: 'countries', add: [country.id], remove: [] }])
      return viewStep('view/restore-countries', [{ op: 'hide', scope: 'countries', add: [], remove: [...hidden] }])
    }
    case 3: case 4: {
      // A page's save: some of the lists of one card, drawn as a draft against the saved state.
      const operations: ViewOperation[] = []
      if (rng.chance(0.5)) {
        const draft = rng.shuffle(state.countryOrder.length ? state.countryOrder : countries.map(c => c.id))
        operations.push({ op: 'order', scope: 'countries', ids: draft, baseline: state.countryOrder })
      }
      const country = rng.pick(countries)
      if (country && rng.chance(0.5)) {
        const own = cities.filter(c => c.partOf === country.id).map(c => c.id)
        const saved = state.cityOrderByCountry[country.id] ?? []
        operations.push({ op: 'order', scope: 'cities', key: country.id, ids: rng.shuffle(own).slice(0, rng.int(own.length + 1)), baseline: saved })
      }
      if (rng.chance(0.4)) {
        const draft = rng.shuffle(cities.map(c => c.id)).slice(0, rng.int(3))
        operations.push({ op: 'hide', scope: 'cities', add: draft.filter(id => !state.hiddenCityIds.includes(id)), remove: state.hiddenCityIds.filter(id => !draft.includes(id)) })
      }
      if (rng.chance(0.4)) {
        const draft = rng.shuffle(mediaIds).slice(0, rng.int(3))
        operations.push({ op: 'hide', scope: 'media', add: draft.filter(id => !state.hiddenMediaIds.includes(id)), remove: state.hiddenMediaIds.filter(id => !draft.includes(id)) })
      }
      const city = rng.pick(cities)
      if (city && rng.chance(0.4)) operations.push({ op: 'cover', key: city.id, id: rng.pick(mediaIds)! })
      if (city && rng.chance(0.3)) operations.push({ op: 'order', scope: 'media', key: city.id, ids: rng.shuffle(mediaIds).slice(0, 2), baseline: state.mediaOrderByCity[city.id] ?? [] })
      if (city && rng.chance(0.2)) {
        const draft = rng.shuffle(mediaIds).slice(0, rng.int(2))
        operations.push({ op: 'order', scope: 'drone', key: city.id, ids: draft, baseline: state.droneOrderByCity[city.id] ?? [] })
        operations.push({ op: 'hide', scope: 'drone', add: draft.slice(0, 1), remove: [] })
      }
      if (!operations.length) operations.push({ op: 'hide', scope: 'cities', add: [], remove: [] })
      // Now and then a country among the hidden cities: refused (E_UNKNOWN_PLACE_REF), as PUT /state refused it.
      const country2 = rng.chance(0.06) ? rng.pick(countries) : undefined
      if (country2) operations.push({ op: 'hide', scope: 'cities', add: [country2.id], remove: [] })
      return viewStep('view/lists', operations)
    }
    case 5: case 6: {
      const place = rng.pick(places)
      if (place && rng.chance(0.5)) return sameRequest('wanttogo/placeId', R('wanttogo'), OLD_WRITES.wantToGo, { placeId: place.id, ...(rng.chance(0.5) ? { note: 'Synthetic' } : {}) })
      const kind = rng.chance(0.7) ? 'city' : 'country'
      const existing = rng.pick(cities)
      // Sometimes the name of a city that exists, in its own country (a place choice: the candidates and their order),
      // sometimes near it, sometimes a new one.
      const reuse = existing && rng.chance(0.35)
      const nameEn = reuse ? existing.names.en ?? 'Alpha' : `${rng.pick(CITY_NAMES)} ${rng.int(1000)}`
      const ownCountry = reuse ? countries.find(c => c.id === existing.partOf)?.externalIds?.iso3166Alpha2 : undefined
      const near = reuse && existing.location && rng.chance(0.5) ? { lat: existing.location.lat + 0.01, lng: existing.location.lng } : undefined
      return sameRequest('wanttogo/named', R('wanttogo'), OLD_WRITES.wantToGo, {
        place: { kind, nameEn, countryCode: ownCountry ?? rng.pick(COUNTRY_CODES), ...(near ?? (rng.chance(0.5) ? { lat: rng.int(80), lng: rng.int(170) } : {})) },
        ...(rng.chance(0.4) ? { createNew: true } : {}),
      })
    }
    case 7: {
      const item = rng.pick(files.wantToGo.items)
      return sameRequest('wanttogo/update', R('wanttogo/update'), OLD_WRITES.wantToGoUpdate, {
        id: (rng.chance(0.08) ? undefined : item?.id) ?? 'synthetic-missing', ...(rng.chance(0.6) ? { hidden: rng.chance(0.5) } : { note: rng.chance(0.7) ? `Synthetic ${rng.int(100)}` : '' }),
      })
    }
    case 8: {
      const hidden = files.wantToGo.items.filter(item => item.hidden)
      const ids = hidden.length ? rng.shuffle(hidden).slice(0, 1 + rng.int(2)).map(item => item.id) : ['synthetic-missing']
      if (rng.chance(0.15) && files.wantToGo.items.length) ids.push(rng.pick(files.wantToGo.items)!.id)
      return sameRequest('wanttogo/delete', R('wanttogo/delete'), OLD_WRITES.wantToGoDelete, { ids })
    }
    default: {
      const planned = files.travel.records.filter(r => r.status === 'planned')
      if (planned.length && rng.chance(0.3)) return sameRequest('convert/planned', R('wanttogo/convert'), OLD_WRITES.convert, { source: 'planned', recordId: rng.pick(planned)!.id, startDate: dateOf(rng) })
      const placeOf = new Map(places.map(p => [p.id, p]))
      const convertible = files.wantToGo.items.filter(i => !i.hidden && placeOf.get(i.placeId)?.subtype === 'city' && placeOf.get(i.placeId)?.location
        && !files.travel.records.some(r => r.placeId === i.placeId))
      const item = rng.pick(convertible.length && rng.chance(0.8) ? convertible : files.wantToGo.items)
      const tripTitle = rng.pick(TITLES)
      // Now and then one of the journeys of that title (3C-5 C2: conversions that join a journey save too).
      const journeys = [...new Set(files.travel.records.filter(r => r.status !== 'planned' && r.trip_title === tripTitle && r.journeyId).map(r => r.journeyId as string))]
      const choice = journeys.length && rng.chance(0.4) ? { journeyId: rng.pick(journeys)! } : rng.chance(0.4) ? { newJourney: true } : {}
      return sameRequest('convert/want-to-go', R('wanttogo/convert'), OLD_WRITES.convert, {
        source: 'want-to-go', id: item?.id ?? 'synthetic-missing', startDate: dateOf(rng), tripTitle, keepWantToGo: rng.chance(0.3), ...choice,
      })
    }
  }
}

/** Per label: [both engines saved, both refused]. */
export type Tally = Map<string, [number, number]>
export interface RunReport {
  readonly steps: number
  readonly tally: Tally
  /** Steps that ran in both engines through a native planner (the rest: the stand-in, see `enginesFor`). */
  readonly native: number
  readonly differences: readonly string[]
  /** The second engine's outcome of every step. */
  readonly outcomes: readonly EngineOutcome[]
  /** The store after the last step (the second engine's). */
  readonly state: FormalState
}

/** Run one step in both engines from `store`'s state, compare, and go on from the second engine's state. */
export function doubleRunStep(store: DoubleRunStore, request: DoubleRunStep, engine: Engine, n: number, report: { tally: Tally; differences: string[] }): EngineOutcome {
  const counts = report.tally.get(request.label) ?? [0, 0]
  report.tally.set(request.label, counts)
  const old = oldEngine(store, request, stepContext(n))
  const second = engine(store, request, stepContext(n))
  for (const difference of compareOutcomes(store.state, old, second, { viewOperation: request.route === VIEW_ROUTE, result: request.compareResult !== false })) {
    report.differences.push(`step ${n} ${request.label} ${JSON.stringify(request.input)}: ${difference}`)
  }
  if (second.state) { store.state = second.state; counts[0]++ } else counts[1]++
  return second
}

/**
 * Run `steps` (each made from the store's current V2 view) one after the other from `files`, every one in both engines:
 * the native planner of its endpoint where `engines` has one, else the stand-in.
 */
export function runSteps(files: V2Files, steps: readonly ((view: V2Files) => DoubleRunStep)[], engines: Engines, startAt = 1): RunReport {
  const store = doubleRunStore(files)
  const report = { tally: new Map() as Tally, differences: [] as string[] }
  let native = 0
  const outcomes = steps.map((make, index) => {
    const request = make(viewOf(store.state))
    if (engines.native.has(request.route)) native++
    return doubleRunStep(store, request, engines.engineFor(request.route), startAt + index, report)
  })
  return { steps: steps.length, native, ...report, outcomes, state: store.state }
}

/** Run `count` random steps from `files` (seed `seed`) in both engines (see runSteps). */
export function runRandomSequence(seed: number, count: number, files: V2Files, engines: Engines): RunReport {
  const rng = random(seed)
  return runSteps(files, Array.from({ length: count }, () => (view: V2Files) => randomStep(rng, view)), engines)
}
