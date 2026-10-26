/// <reference types="node" />
/** The native public sample (3C-5A spec §2.4): the committed read model is what the source generates, and through the
 * official view it derives exactly what the V2 sample derives (the locked hash 9b68b8ad…), with the same time query
 * context; exported back to V2 it gives the five V2 sample files. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { formalStateOfReadModel } from '../../worldgraph/readModel/build.ts'
import { readReadModel, validateReadModel } from '../../worldgraph/readModel/check.ts'
import { V2_SAMPLE_BASELINE_SHA256 } from '../canonical/baselineLocks.fixture.ts'
import { canonicalForInputs } from '../compat/v2/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import { publicBridgeFixture } from '../compat/v2/storeBridge.fixture.ts'
import { serializeV2 } from '../compat/v2/v2Serializer.ts'
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import { deriveTimeQueryContext } from '../derive/timeQueryContext.ts'
import { OFFICIAL_POLICY } from '../store/officialDefinitions.ts'
import { officialViewOf, projectStoreToCanonical } from '../store/projectCanonical.ts'
import { publicReadModelOf } from '../store/publicReadModel.ts'
import { SAMPLE_READ_MODEL_FILE_NAME, buildSampleReadModel, sampleReadModelText } from './sampleBuild.ts'

const NOW = '2000-01-01T00:00:00.000Z'
const committed = readFileSync(new URL(`./${SAMPLE_READ_MODEL_FILE_NAME}`, import.meta.url), 'utf8')
const model = readReadModel(JSON.parse(committed))
const projection = projectStoreToCanonical(formalStateOfReadModel(model), { source: 'sample' })

test('the committed sample read model is what the source generates, byte for byte', () => {
  assert.equal(committed, sampleReadModelText())
  assert.deepEqual(model, JSON.parse(JSON.stringify(buildSampleReadModel())))
  assert.equal(model.origin, 'sample'); assert.equal(model.revision, 1)
  assert.doesNotThrow(() => validateReadModel(model, OFFICIAL_POLICY))
})

test('through the official view the sample derives the locked baseline 9b68b8ad…', () => {
  const text = stableStringify(buildBaseline(deriveAppDataFromCanonical(projection.canonical, { now: NOW }), { now: NOW }))
  assert.equal(createHash('sha256').update(`${text}\n`).digest('hex'), V2_SAMPLE_BASELINE_SHA256)
})

test('the public build reads it as ../rawInputs.ts does (3C-5B): the imported JSON → readReadModel → officialViewOf(…, sample) derives the locked baseline', () => {
  const canonical = officialViewOf(readReadModel(JSON.parse(committed)), 'sample')
  assert.deepEqual(canonical, projection.canonical)
  const text = stableStringify(buildBaseline(deriveAppDataFromCanonical(canonical, { now: NOW }), { now: NOW }))
  assert.equal(createHash('sha256').update(`${text}
`).digest('hex'), V2_SAMPLE_BASELINE_SHA256)
  assert.deepEqual(deriveTimeQueryContext(canonical), deriveTimeQueryContext(canonicalForInputs({ v2Files: publicBridgeFixture(), source: 'sample' })))
})

test('the official view equals the V2 sample read through readV2, with the same time query context; nothing is skipped', () => {
  const viaV2 = canonicalForInputs({ v2Files: publicBridgeFixture(), source: 'sample' })
  assert.deepEqual(projection.canonical, viaV2)
  assert.deepEqual(deriveTimeQueryContext(projection.canonical), deriveTimeQueryContext(viaV2))
  assert.deepEqual(projection.skipped, [])
})

test('exported as V2, the sample gives the five V2 sample files', () => {
  assert.deepEqual(serializeV2(projection.canonical, projection.v2Meta), publicBridgeFixture())
})

test('the sample is public through and through: its public export keeps every fact and view row', () => {
  const published = publicReadModelOf(model)
  for (const table of ['entities', 'entries', 'relations', 'anchors', 'sequences', 'viewItems', 'viewSettings'] as const) {
    assert.equal(published[table].length, model[table].length, table)
  }
})
