/// <reference types="node" />
/** The editor steps of the golden output (3C-5 C1–E; spec E §2.1, design 3C-5 §9): the scenarios' and the random
 * sequences' requests, run by the store-native engine, and the normalization their outcomes are compared under.
 *
 * - The native engine (`nativeEngineOf`): the store-native planner (../editor/native/) on the official reader of the
 *   state's live index, then Core's planCommands and applyChangeSet.
 * - Until 3C-5 E every step also ran in the old engine (the V2 write function on the store's V2 view, diffV2ToCommands,
 *   planCommands, applyChangeSet) and the two were compared. The old engine's outcomes are frozen in the golden output
 *   (./fixtures/editor-golden.json, ./golden.test.ts); since E the native engine is compared with them.
 * - Normalization: ids renamed in the order they first appear (UUIDs and `journey-<UUID>`, keys too), file headers and
 *   the V2-only values of new records left out (design §9 changes 1–3).
 *
 * Sequences go on from the native engine's state. Only tracked neutral fixtures and invented values. Not imported by
 * the App.
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
import { OFFICIAL_POLICY } from '../store/officialDefinitions.ts'
import { officialReader } from '../store/officialReader.ts'
import { projectStoreToCanonical } from '../store/projectCanonical.ts'
import { migrateIntoEmptyStore, viewOf } from '../store/v2Store.fixture.ts'
import { indexPlaces, reconstructEditorState } from '../canonical/reconstruct.ts'
import { V2WriteError } from './errors.ts'
import { TEST_CATALOG, WRITE_EPOCH_MS, WRITE_NOW, type EditorTestContext } from './editor.fixture.ts'
import { NATIVE_WRITES, type NativeWrite } from './native/routes.ts'
import type { ViewOperation } from './rules/editorView.ts'

export interface DoubleRunStore {
  state: FormalState
  readonly manifest: BridgeManifest
}
/** One step: a request to one endpoint. */
export interface DoubleRunStep {
  readonly label: string
  /** The endpoint (`METHOD /path`), for the native planner. */
  readonly route: string
  /** The request body. */
  readonly input: unknown
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

/** A step's context: the write's time and ids. */
export type StepContext = EditorTestContext
/** The context of step `n` (up to 1000 ids each, never shared between steps or with the migration's ids). */
export function stepContext(n: number): StepContext {
  return { newId: sequentialUuids(WRITE_EPOCH_MS + n * 1000), now: new Date(WRITE_NOW.getTime() + n * 60_000), countryCatalog: TEST_CATALOG }
}

const refused = (error: unknown): EngineOutcome => {
  if (error instanceof V2WriteError) return { error: { code: error.code, ...(error.params !== undefined ? { params: error.params } : {}) } }
  throw error
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

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** A request to `route` with `input`. */
export function sameRequest(label: string, route: string, input: unknown): DoubleRunStep {
  return { label, route, input }
}

/** A view operation (its answer is the revision only: not compared). */
export function viewStep(label: string, operations: readonly ViewOperation[]): DoubleRunStep {
  return {
    label, route: VIEW_ROUTE, input: { operations }, compareResult: false,
  }
}

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
 * operations a page sends), over the eight editor endpoints. The editor lists are the view's (as the page saw them).
 */
export function randomStep(rng: Random, files: V2Files): DoubleRunStep {
  const places = files.places.places
  const cities = places.filter(p => p.subtype === 'city'), countries = places.filter(p => p.subtype === 'country')
  const state = reconstructEditorState(files.editorState, indexPlaces(files.places.places))
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
      if (city && rng.chance(0.4)) return sameRequest('records/placeId', R('records'), { placeId: city.id, start_date: dateOf(rng), lat: 10, lng: 20, trip_title: title, ...choice })
      const code = rng.pick(COUNTRY_CODES)!
      return sameRequest('records/named', R('records'), {
        country: code, country_en: code, city: rng.pick(CITY_NAMES)!, city_en: `${rng.pick(CITY_NAMES)} ${rng.int(1000)}`, start_date: dateOf(rng),
        lat: rng.int(80), lng: rng.int(170), country_code: code, trip_title: title, ...(rng.chance(0.3) ? { createNew: true } : {}), ...choice,
      })
    }
    case 1: return sameRequest('countries', R('countries'), { countryCode: rng.pick(COUNTRY_CODES), visitedDate: dateOf(rng) })
    case 2: {
      const hidden = state.hiddenCountryIds
      if (hidden.length && rng.chance(0.6)) return sameRequest('countries/delete', R('countries/delete'), { ids: [rng.pick(hidden)!] })
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
      if (place && rng.chance(0.5)) return sameRequest('wanttogo/placeId', R('wanttogo'), { placeId: place.id, ...(rng.chance(0.5) ? { note: 'Synthetic' } : {}) })
      const kind = rng.chance(0.7) ? 'city' : 'country'
      const existing = rng.pick(cities)
      // Sometimes the name of a city that exists, in its own country (a place choice: the candidates and their order),
      // sometimes near it, sometimes a new one.
      const reuse = existing && rng.chance(0.35)
      const nameEn = reuse ? existing.names.en ?? 'Alpha' : `${rng.pick(CITY_NAMES)} ${rng.int(1000)}`
      const ownCountry = reuse ? countries.find(c => c.id === existing.partOf)?.externalIds?.iso3166Alpha2 : undefined
      const near = reuse && existing.location && rng.chance(0.5) ? { lat: existing.location.lat + 0.01, lng: existing.location.lng } : undefined
      return sameRequest('wanttogo/named', R('wanttogo'), {
        place: { kind, nameEn, countryCode: ownCountry ?? rng.pick(COUNTRY_CODES), ...(near ?? (rng.chance(0.5) ? { lat: rng.int(80), lng: rng.int(170) } : {})) },
        ...(rng.chance(0.4) ? { createNew: true } : {}),
      })
    }
    case 7: {
      const item = rng.pick(files.wantToGo.items)
      return sameRequest('wanttogo/update', R('wanttogo/update'), {
        id: (rng.chance(0.08) ? undefined : item?.id) ?? 'synthetic-missing', ...(rng.chance(0.6) ? { hidden: rng.chance(0.5) } : { note: rng.chance(0.7) ? `Synthetic ${rng.int(100)}` : '' }),
      })
    }
    case 8: {
      const hidden = files.wantToGo.items.filter(item => item.hidden)
      const ids = hidden.length ? rng.shuffle(hidden).slice(0, 1 + rng.int(2)).map(item => item.id) : ['synthetic-missing']
      if (rng.chance(0.15) && files.wantToGo.items.length) ids.push(rng.pick(files.wantToGo.items)!.id)
      return sameRequest('wanttogo/delete', R('wanttogo/delete'), { ids })
    }
    default: {
      const planned = files.travel.records.filter(r => r.status === 'planned')
      if (planned.length && rng.chance(0.3)) return sameRequest('convert/planned', R('wanttogo/convert'), { source: 'planned', recordId: rng.pick(planned)!.id, startDate: dateOf(rng) })
      const placeOf = new Map(places.map(p => [p.id, p]))
      const convertible = files.wantToGo.items.filter(i => !i.hidden && placeOf.get(i.placeId)?.subtype === 'city' && placeOf.get(i.placeId)?.location
        && !files.travel.records.some(r => r.placeId === i.placeId))
      const item = rng.pick(convertible.length && rng.chance(0.8) ? convertible : files.wantToGo.items)
      const tripTitle = rng.pick(TITLES)
      // Now and then one of the journeys of that title (3C-5 C2: conversions that join a journey save too).
      const journeys = [...new Set(files.travel.records.filter(r => r.status !== 'planned' && r.trip_title === tripTitle && r.journeyId).map(r => r.journeyId as string))]
      const choice = journeys.length && rng.chance(0.4) ? { journeyId: rng.pick(journeys)! } : rng.chance(0.4) ? { newJourney: true } : {}
      return sameRequest('convert/want-to-go', R('wanttogo/convert'), {
        source: 'want-to-go', id: item?.id ?? 'synthetic-missing', startDate: dateOf(rng), tripTitle, keepWantToGo: rng.chance(0.3), ...choice,
      })
    }
  }
}

/** Per label: [saved, refused]. */
export type Tally = Map<string, [number, number]>
export interface RunReport {
  readonly steps: number
  readonly tally: Tally
  /** The requests, as each was made from the store's V2 view at its turn. */
  readonly requests: readonly DoubleRunStep[]
  /** The native engine's outcome of every step. */
  readonly outcomes: readonly EngineOutcome[]
  /** The store after the last step. */
  readonly state: FormalState
}

/**
 * Run `steps` (each made from the store's current V2 view) one after the other from `files` in the native engine; step
 * `n` gets stepContext(startAt + n). `natives` replaces the planners (tests).
 */
export function runSteps(files: V2Files, steps: readonly ((view: V2Files) => DoubleRunStep)[], natives: Readonly<Record<string, NativeWrite>> = NATIVE_WRITES, startAt = 1): RunReport {
  const store = doubleRunStore(files)
  const tally: Tally = new Map()
  const requests: DoubleRunStep[] = []
  const outcomes = steps.map((make, index) => {
    const request = make(viewOf(store.state))
    requests.push(request)
    const write = natives[request.route]
    if (!write) throw new Error(`no native write for ${request.route}`)
    const outcome = nativeEngineOf(write)(store, request, stepContext(startAt + index))
    const counts = tally.get(request.label) ?? [0, 0]
    tally.set(request.label, counts)
    if (outcome.state) { store.state = outcome.state; counts[0]++ } else counts[1]++
    return outcome
  })
  return { steps: steps.length, tally, requests, outcomes, state: store.state }
}

/** Run `count` random steps from `files` (seed `seed`) in the native engine (see runSteps). */
export function runRandomSequence(seed: number, count: number, files: V2Files, natives: Readonly<Record<string, NativeWrite>> = NATIVE_WRITES): RunReport {
  const rng = random(seed)
  return runSteps(files, Array.from({ length: count }, () => (view: V2Files) => randomStep(rng, view)), natives)
}
