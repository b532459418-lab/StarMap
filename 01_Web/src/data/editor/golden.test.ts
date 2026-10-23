/// <reference types="node" />
/**
 * The golden output of the editor writes (3C-5 E spec §2.1; ./golden.fixture.ts, ./fixtures/editor-golden.json): the
 * native engine reproduces, step by step, what the old engine did on every double-run scenario and random sequence.
 *
 * How the changes of design 3C-5 §9 are recorded (as changed):
 * 1. new sources and ids, journey ids without `journey-`: ids are renamed in the order they first appear;
 * 2. no V2-only values on new records: `type: 'visit'`, `status: 'visited'`, `source: 'local-editor'` are left out;
 * 3. no file headers: `updatedAt`, `generatedAt` are left out;
 * 4. unknown media ids in view operations: left out of the old engine's side;
 * 5. no reload after a save, 6. the in-memory migration of a root that needs migrating: not editor writes;
 * 7. city, photo and drone orders merged (mergeOrder): every order step's draft starts from the saved order, where the
 *    merge and the old replacement agree;
 * 8. a request that changes nothing commits nothing (`unchanged: true`): view operations compare no response, and an
 *    empty step changes no baseline in either engine;
 * 9. a country deleted while a user's own layer uses its cities: the scenarios have no such layer (the native tests cover
 *    it, ./native/footprint.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { viewOf } from '../store/diffV2.fixture.ts'
import { VIEW_ROUTE, doubleRunStore, oldEngine, stepContext, withoutUnknownMediaBrought, nativeEngineOf, type DoubleRunStep } from './doubleRun.fixture.ts'
import { SCENARIOS, SEQUENCE_SEEDS, SEQUENCE_STEPS } from './editorScenarios.fixture.ts'
import { GOLDEN_URL, firstDifference, goldenEntryOf, nativeEntries, readGolden, sequenceSteps, type GoldenEntry, type GoldenFile } from './golden.fixture.ts'
import { NATIVE_WRITES } from './native/routes.ts'
import { migratedFiles } from '../v2write/v2write.fixture.ts'
import type { V2Files } from '../canonical/v2Schema.ts'

const golden = readGolden()

test('the golden file covers every scenario and random sequence, and is small', () => {
  assert.equal(golden.format, 'starmap.editor-golden')
  assert.deepEqual(Object.keys(golden.scenarios), SCENARIOS.map(({ name }) => name))
  assert.deepEqual(Object.keys(golden.sequences), SEQUENCE_SEEDS.map(String))
  for (const entries of Object.values(golden.sequences)) assert.equal(entries.length, SEQUENCE_STEPS)
  const statuses = [...Object.values(golden.scenarios), ...Object.values(golden.sequences)].flat().map(([, status]) => status)
  assert.ok(statuses.filter((status) => status === 'saved').length > 200 && statuses.filter((status) => status === 'refused').length > 60)
})

for (const { name, files, steps } of SCENARIOS) {
  test(`golden: the native engine reproduces ${name}`, () => {
    assert.equal(firstDifference(golden.scenarios[name], nativeEntries(files(), steps, NATIVE_WRITES)), null)
  })
}
for (const seed of SEQUENCE_SEEDS) {
  test(`golden: the native engine reproduces the random sequence of seed ${seed}`, () => {
    assert.equal(firstDifference(golden.sequences[String(seed)], nativeEntries(migratedFiles(), sequenceSteps(seed, SEQUENCE_STEPS), NATIVE_WRITES)), null)
  })
}

// --- Until the old engine is retired: the file is what the old engine records (STARMAP_RECORD_GOLDEN=1 writes it).

/** The old engine's entries of `steps` (from the native engine's state at every step, as the double run goes on). */
function oldEntries(files: V2Files, steps: readonly ((view: V2Files) => DoubleRunStep)[]): GoldenEntry[] {
  const store = doubleRunStore(files)
  return steps.map((make, index) => {
    const step = make(viewOf(store.state))
    // Each engine its own context (the same ids and time, from fresh generators), as doubleRunStep does.
    const old = oldEngine(store, step, stepContext(1 + index))
    const entry = goldenEntryOf(step, old, step.route === VIEW_ROUTE ? withoutUnknownMediaBrought(store.state) : undefined)
    const native = nativeEngineOf(NATIVE_WRITES[step.route])(store, step, stepContext(1 + index))
    // The double run's comparison, on the entries: both engines agree on every step.
    assert.deepEqual(goldenEntryOf(step, native), entry, `${step.label} (step ${index + 1})`)
    if (native.state) store.state = native.state
    return entry
  })
}

test('the golden file is what the old engine records (V2 write functions with diffV2ToCommands)', () => {
  const recorded: GoldenFile = {
    format: 'starmap.editor-golden',
    version: 1,
    recordedWith: 'the V2 write functions with diffV2ToCommands (3C-5 E, before the old engine was retired); ids renamed in the order they first appear, design 3C-5 §9 changes 1-4 left out',
    scenarios: Object.fromEntries(SCENARIOS.map(({ name, files, steps }) => [name, oldEntries(files(), steps)])),
    sequences: Object.fromEntries(SEQUENCE_SEEDS.map((seed) => [String(seed), oldEntries(migratedFiles(), sequenceSteps(seed, SEQUENCE_STEPS))])),
  }
  if (process.env.STARMAP_RECORD_GOLDEN === '1') {
    // One step per line: small, and a change shows as the lines of the steps that changed.
    const lines = (entries: readonly GoldenEntry[]) => entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')
    const group = (record: Readonly<Record<string, readonly GoldenEntry[]>>) =>
      Object.entries(record).map(([key, entries]) => `  ${JSON.stringify(key)}: [\n${lines(entries)}\n  ]`).join(',\n')
    writeFileSync(GOLDEN_URL, `{\n"format": "starmap.editor-golden",\n"version": 1,\n"recordedWith": ${JSON.stringify(recorded.recordedWith)},\n"scenarios": {\n${group(recorded.scenarios)}\n},\n"sequences": {\n${group(recorded.sequences)}\n}\n}\n`)
  }
  assert.deepEqual(readGolden(), recorded)
})
