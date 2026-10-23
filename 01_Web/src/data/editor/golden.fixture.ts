/// <reference types="node" />
/**
 * The golden output of the editor writes (3C-5 E spec §2.1, design 3C-5 §9): what the old engine (the V2 write functions
 * with diffV2ToCommands) did on every double-run scenario and random sequence, frozen as a test fixture before the old
 * engine was retired. The native engine must reproduce it step by step.
 *
 * One entry per step: `[label, status, code, params, result, baseline]`
 * - `status`: `saved` or `refused`;
 * - `code`: the error code of a refusal (else null);
 * - `params`: the hash of the refusal's parameters, ids renamed in the order they first appear (the place and journey
 *   candidates, in their order, are parameters); null without parameters;
 * - `result`: the hash of a saved step's response, normalized the same way (null where it is not compared: a view
 *   operation answers with its revision only);
 * - `baseline`: the hash of the derived baseline after a saved step, normalized (ids renamed in the order they first
 *   appear, file headers and V2-only values left out; see ./doubleRun.fixture.ts normalizedBaseline); null after a
 *   refusal (nothing changed).
 * Hashes are the first 16 hex digits of a SHA-256 of the normalized JSON.
 *
 * The behaviours design 3C-5 §9 changed on purpose are recorded as changed: the normalization leaves out what changes 1–3
 * changed (new ids and journey ids, V2-only values, file headers), the old engine's side of a view operation leaves out
 * the media ids a view operation ignores (change 4), and the scenarios and sequences never reach changes 5–9 (see
 * ./golden.test.ts). A later change of behaviour updates the golden file under review, like a new baseline format.
 *
 * Only tracked neutral fixtures and invented values. Not imported by the App.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { V2Files } from '../canonical/v2Schema.ts'
import { viewOf } from '../store/diffV2.fixture.ts'
import {
  doubleRunStore, nativeEngineOf, normalizedBaseline, random, randomStep, renameIdsForComparison, stepContext,
  type DoubleRunStep, type EngineOutcome,
} from './doubleRun.fixture.ts'
import type { NativeWrite } from './native/routes.ts'

export type GoldenEntry = readonly [label: string, status: 'saved' | 'refused', code: string | null, params: string | null, result: string | null, baseline: string | null]
export interface GoldenFile {
  readonly format: 'starmap.editor-golden'
  readonly version: 1
  /** How it was recorded (the engine, the normalization). */
  readonly recordedWith: string
  readonly scenarios: Readonly<Record<string, readonly GoldenEntry[]>>
  readonly sequences: Readonly<Record<string, readonly GoldenEntry[]>>
}

export const GOLDEN_URL = new URL('./fixtures/editor-golden.json', import.meta.url)
export const readGolden = (): GoldenFile => JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as GoldenFile

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/**
 * The entry of one step. `adjust` changes the official view before the baseline (the old engine's side of a view
 * operation: the media ids it brought that are no media are left out, design §9 change 4).
 */
export function goldenEntryOf(step: DoubleRunStep, outcome: EngineOutcome, adjust?: Parameters<typeof normalizedBaseline>[1]): GoldenEntry {
  if (outcome.error) {
    const { code, params } = outcome.error
    return [step.label, 'refused', code, params === undefined ? null : hash(renameIdsForComparison(params, { dropHeaders: false })), null, null]
  }
  const compareResult = step.compareResult !== false
  return [step.label, 'saved', null, null, compareResult ? hash(renameIdsForComparison(outcome.result, { dropHeaders: true })) : null, hash(normalizedBaseline(outcome.state!, adjust))]
}

/** The native engine's entries of `steps` from `files` (each step made from the store's V2 view; numbered from 1). */
export function nativeEntries(files: V2Files, steps: readonly ((view: V2Files) => DoubleRunStep)[], natives: Readonly<Record<string, NativeWrite>>): GoldenEntry[] {
  const store = doubleRunStore(files)
  return steps.map((make, index) => {
    const step = make(viewOf(store.state))
    const write = natives[step.route]
    if (!write) throw new Error(`no native write for ${step.route}`)
    const outcome = nativeEngineOf(write)(store, step, stepContext(1 + index))
    if (outcome.state) store.state = outcome.state
    return goldenEntryOf(step, outcome)
  })
}

/** The steps of a random sequence (as runRandomSequence draws them). */
export const sequenceSteps = (seed: number, count: number): ((view: V2Files) => DoubleRunStep)[] => {
  const rng = random(seed)
  return Array.from({ length: count }, () => (view: V2Files) => randomStep(rng, view))
}

/** The first entry that differs (null: the same), for a readable failure. */
export function firstDifference(expected: readonly GoldenEntry[], actual: readonly GoldenEntry[]): string | null {
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) {
      return `step ${index + 1}: golden ${JSON.stringify(expected[index])} / now ${JSON.stringify(actual[index])}`
    }
  }
  return null
}
