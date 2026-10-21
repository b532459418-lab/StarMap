/** The public sample's generator (3C-5A): ./sampleSource.ts → the read model `sample.read-model.json`.
 *
 * The official definitions and every row of the source become create commands, in dependency order (FORMAL_TABLES);
 * Core's planner checks them on an empty store with the official policy, as a store would on its first commit; the
 * state after that one change set (revision 1) is the read model, with origin `sample`, checked in full. The text is
 * JSON with two-space indentation and a final newline, so the committed file reads and diffs well.
 *
 * `npm run sample:build` writes it (scripts/sample-build.mjs); ./sample.test.ts and `npm run privacy:check` require the
 * committed file to equal it byte for byte.
 *
 * Pure: no IO; the time and every id are fixed in the source.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import { FORMAL_TABLES, type FormalCommand, type FormalRow, type FormalTable, emptyFormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { readModelOf } from '../../worldgraph/readModel/build.ts'
import { validateReadModel } from '../../worldgraph/readModel/check.ts'
import type { ReadModel } from '../../worldgraph/readModel/types.ts'
import { OFFICIAL_POLICY, officialDefinitionCommands } from '../store/officialDefinitions.ts'
import { SAMPLE_TIME, sampleRows } from './sampleSource.ts'

/** The file the generator writes, next to the source. */
export const SAMPLE_READ_MODEL_FILE_NAME = 'sample.read-model.json'

/** The official definitions, then the sample's rows table by table in dependency order. */
export function sampleCommands(): FormalCommand[] {
  const rows = sampleRows() as Partial<Record<FormalTable, readonly FormalRow[]>>
  return [
    ...officialDefinitionCommands(),
    ...FORMAL_TABLES.flatMap((table) => (rows[table] ?? []).map((value): FormalCommand => ({ op: 'create', table, value }))),
  ]
}

/** The sample's read model: the source planned on an empty store (revision 1), checked in full. */
export function buildSampleReadModel(): ReadModel {
  const empty = emptyFormalState()
  const changeSet = planCommands(memoryReader(empty), sampleCommands(), { baseRevision: 0, now: SAMPLE_TIME, policy: OFFICIAL_POLICY })
  const model = readModelOf(applyChangeSet(empty, changeSet), { origin: 'sample' })
  validateReadModel(model, OFFICIAL_POLICY)
  return model
}

/** The text of `sample.read-model.json`. */
export const sampleReadModelText = (): string => `${JSON.stringify(buildSampleReadModel(), null, 2)}\n`
