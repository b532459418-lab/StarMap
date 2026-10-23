/// <reference types="node" />
/**
 * The golden output of the editor writes (3C-5 E spec §2.1, §2.3; ./golden.fixture.ts, ./fixtures/editor-golden.json):
 * the double run since 3C-5 E. The old engine's outcomes (the V2 write functions with diffV2ToCommands) were frozen on
 * every double-run scenario and random sequence before it was retired; the native engine reproduces them step by step.
 *
 * How the changes of design 3C-5 §9 are recorded (as changed):
 * 1. new sources and ids, journey ids without `journey-`: ids are renamed in the order they first appear;
 * 2. no V2-only values on new records: `type: 'visit'`, `status: 'visited'`, `source: 'local-editor'` are left out;
 * 3. no file headers: `updatedAt`, `generatedAt` are left out;
 * 4. unknown media ids in view operations: left out of the old engine's side when it was recorded;
 * 5. no reload after a save, 6. the in-memory migration of a root that needs migrating: not editor writes;
 * 7. city, photo and drone orders merged (mergeOrder): every order step's draft starts from the saved order, where the
 *    merge and the old replacement agree;
 * 8. a request that changes nothing commits nothing (`unchanged: true`): view operations compare no response, and an
 *    empty step changes no baseline in either engine;
 * 9. a country deleted while a user's own layer uses its cities: the scenarios have no such layer (the native tests cover
 *    it, ./native/footprint.test.ts, ./native/wantToGo.test.ts).
 * A later change of behaviour on purpose updates the golden file under review, like a new baseline format, with its
 * reasons: STARMAP_RECORD_GOLDEN=1 writes what the native engine does now (one step per line, so the diff shows the
 * steps that changed).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { readV2 } from '../canonical/v2Reader.ts'
import { validateV2Files } from '../canonical/v2Schema.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import { projectStoreToCanonical } from '../store/projectCanonical.ts'
import { VIEW_ROUTE, editorRoute, runSteps, type RunReport } from './doubleRun.fixture.ts'
import { migratedFiles } from './editor.fixture.ts'
import { SCENARIOS, SEQUENCE_SEEDS, SEQUENCE_STEPS } from './editorScenarios.fixture.ts'
import { GOLDEN_URL, entriesOf, firstDifference, readGolden, sequenceSteps, type GoldenEntry, type GoldenFile } from './golden.fixture.ts'
import { NATIVE_WRITES } from './native/routes.ts'

const golden = readGolden()
/** What the native engine records now (STARMAP_RECORD_GOLDEN=1 writes it). */
const recorded: { scenarios: Record<string, readonly GoldenEntry[]>; sequences: Record<string, readonly GoldenEntry[]> } = { scenarios: {}, sequences: {} }

test('the golden file covers every scenario and random sequence, and is small', () => {
  assert.equal(golden.format, 'starmap.editor-golden')
  assert.deepEqual(Object.keys(golden.scenarios), SCENARIOS.map(({ name }) => name))
  assert.deepEqual(Object.keys(golden.sequences), SEQUENCE_SEEDS.map(String))
  for (const entries of Object.values(golden.sequences)) assert.equal(entries.length, SEQUENCE_STEPS)
  const statuses = [...Object.values(golden.scenarios), ...Object.values(golden.sequences)].flat().map(([, status]) => status)
  assert.ok(statuses.filter((status) => status === 'saved').length > 200 && statuses.filter((status) => status === 'refused').length > 60)
})

for (const { name, files, steps, check } of SCENARIOS) {
  test(`golden: the native engine reproduces ${name}`, () => {
    const report = runSteps(files(), steps)
    recorded.scenarios[name] = entriesOf(report)
    assert.equal(firstDifference(golden.scenarios[name], recorded.scenarios[name]), null)
    check?.(report)
  })
}

/** The labels every random sequence draws. */
const SEQUENCE_LABELS = ['countries', 'countries/delete', 'records/named', 'records/placeId', 'view/lists', 'wanttogo/named', 'wanttogo/placeId',
  'wanttogo/update', 'wanttogo/delete', 'convert/want-to-go', 'convert/planned']

for (const seed of SEQUENCE_SEEDS) {
  test(`golden: the native engine reproduces the random sequence of seed ${seed} (240 steps over the eight editor endpoints)`, () => {
    const report: RunReport = runSteps(migratedFiles(), sequenceSteps(seed, SEQUENCE_STEPS))
    recorded.sequences[String(seed)] = entriesOf(report)
    assert.equal(firstDifference(golden.sequences[String(seed)], recorded.sequences[String(seed)]), null)
    // Every kind of step happened, and steps saved and were refused along the way.
    const labels = [...report.tally.keys()]
    for (const label of SEQUENCE_LABELS) assert.ok(labels.includes(label), label)
    const totals = [...report.tally.values()].reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0])
    assert.ok(totals[0] > 60 && totals[1] > 20, JSON.stringify(totals))
    // Design 3C-5 §3, condition 5: what the native writes wrote exports to V2 (store:export-v2's path), valid, and reads back.
    const { canonical, v2Meta } = projectStoreToCanonical(report.state, { source: 'local', track: false, freeze: false })
    const exported = serializeV2(canonical, v2Meta)
    assert.deepEqual(validateV2Files(exported), [])
    assert.deepEqual(readV2(exported), canonical)
  })
}

test('the native endpoints are the eight editor endpoints', () => {
  assert.deepEqual(Object.keys(NATIVE_WRITES).sort(), [
    VIEW_ROUTE, editorRoute('wanttogo'), editorRoute('wanttogo/update'), editorRoute('wanttogo/delete'), editorRoute('records'), editorRoute('countries'),
    editorRoute('countries/delete'), editorRoute('wanttogo/convert'),
  ].sort())
})

test('STARMAP_RECORD_GOLDEN=1 writes the golden file from the native engine (a reviewed change of behaviour)', { skip: process.env.STARMAP_RECORD_GOLDEN !== '1' }, () => {
  assert.deepEqual(Object.keys(recorded.scenarios), SCENARIOS.map(({ name }) => name), 'every scenario ran first')
  assert.deepEqual(Object.keys(recorded.sequences), SEQUENCE_SEEDS.map(String), 'every sequence ran first')
  const file: GoldenFile = { format: 'starmap.editor-golden', version: 1, recordedWith: golden.recordedWith, ...recorded }
  // One step per line: small, and a change shows as the lines of the steps that changed.
  const lines = (entries: readonly GoldenEntry[]) => entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')
  const group = (record: Readonly<Record<string, readonly GoldenEntry[]>>) =>
    Object.entries(record).map(([key, entries]) => `  ${JSON.stringify(key)}: [\n${lines(entries)}\n  ]`).join(',\n')
  writeFileSync(GOLDEN_URL, `{\n"format": "starmap.editor-golden",\n"version": 1,\n"recordedWith": ${JSON.stringify(file.recordedWith)},\n"scenarios": {\n${group(file.scenarios)}\n},\n"sequences": {\n${group(file.sequences)}\n}\n}\n`)
})
