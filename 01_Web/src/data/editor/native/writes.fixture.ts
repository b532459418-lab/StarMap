/// <reference types="node" />
/**
 * Test helpers for the behaviour tests of the store-native writes (3C-5 E review R1): the tests of the retired V2 write
 * functions (v2write/*.test.ts), ported to the native engine. A `Library` is a store migrated from V2 files; each write
 * runs as the next step (its own ids and time) and moves the store on when it saves. What a write did is read through
 * the official view (the V2 shape: places, records, items and editor lists by id) and the store's rows.
 *
 * Only tracked neutral fixtures and invented values. Not imported by the App.
 */
import assert from 'node:assert/strict'
import type { FormalState } from '../../../worldgraph/store/formal.ts'
import type { CanonicalData, CanonicalPlace, CanonicalTravelRecord } from '../../canonical/types.ts'
import { emptyV2FilesForWrite } from '../../compat/v2/v2Integrity.ts'
import type { V2Files } from '../../compat/v2/v2Schema.ts'
import { viewOf } from '../../store/v2Store.fixture.ts'
import { WRITE_NOW, migratedFiles } from '../editor.fixture.ts'
import { doubleRunStore, editorRoute, nativeEngineOf, sameRequest, stepContext, type DoubleRunStore, type EngineOutcome, type StepContext } from '../doubleRun.fixture.ts'
import { messageFor, type V2WriteErrorCode } from '../errors.ts'
import { canonicalOf, runNative } from './native.fixture.ts'
import { NATIVE_WRITES } from './routes.ts'

/** A store and its next step number. */
export class Library {
  readonly store: DoubleRunStore
  private step = 0
  constructor(files: V2Files = migratedFiles()) { this.store = doubleRunStore(files) }
  /** Run a native write as the next step; the store moves on when it saves. */
  run(route: string, input: unknown): EngineOutcome { return runNative(this.store, route, input, ++this.step) }
  /** Run a native write as the next step with a context of its own (another country catalog). */
  runWith(route: string, input: unknown, context: Partial<StepContext>): EngineOutcome {
    const outcome = nativeEngineOf(NATIVE_WRITES[editorRoute(route)])(this.store, sameRequest(route, editorRoute(route), input), { ...stepContext(++this.step), ...context })
    if (outcome.state) this.store.state = outcome.state
    return outcome
  }
  /** Run a write that must save; its result. */
  save<T = Record<string, unknown>>(route: string, input: unknown): T {
    const outcome = this.run(route, input)
    assert.ok(outcome.state, `${route} refused: ${JSON.stringify(outcome.error)}`)
    return outcome.result as T
  }
  /**
   * Run a write that must be refused with `code` (and `params` when given, compared exactly); nothing is written. Returns
   * the refusal's parameters.
   */
  refuse(route: string, input: unknown, code: V2WriteErrorCode, params?: Record<string, unknown>, message?: string): Record<string, unknown> {
    const before = this.store.state
    const outcome = this.run(route, input)
    assert.equal(outcome.error?.code, code, `${route} ${JSON.stringify(input)}: ${JSON.stringify(outcome.error ?? outcome.result)}`)
    assert.equal(this.store.state, before, 'nothing written')
    const got = (outcome.error!.params ?? {}) as Record<string, unknown>
    if (params !== undefined) assert.deepEqual(got, params)
    if (message !== undefined) assert.equal(messageFor(code, got), message)
    return got
  }
  get state(): FormalState { return this.store.state }
  /** The official view. */
  get view(): CanonicalData { return canonicalOf(this.store.state) }
  /** The V2 shape of the store (ids by name, as the requests use them). */
  get files(): V2Files { return viewOf(this.store.state) }
  place(en: string, subtype?: 'country' | 'city'): CanonicalPlace {
    const place = this.view.places.find((candidate) => candidate.names.en === en && (subtype === undefined || candidate.subtype === subtype))
    assert.ok(place, `no place named ${en}`)
    return place
  }
  record(id: string): CanonicalTravelRecord | undefined { return this.view.travel.records.find((record) => record.id === id) }
  get lastRecord(): CanonicalTravelRecord { return this.view.travel.records.at(-1)! }
}

/** V2 files with `edit` applied before the migration (fixtures the V2 tests built by editing files). */
export const filesWith = (edit: (files: V2Files) => void, files: V2Files = migratedFiles()): V2Files => { edit(files); return files }

/** An empty library: the empty V2 files migrated (official definitions, no place, record or item). */
export const emptyFiles = (): V2Files => emptyV2FilesForWrite(WRITE_NOW)
