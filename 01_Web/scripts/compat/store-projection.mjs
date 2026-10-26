/**
 * The new-library mode's compatibility path (3C-3, design 3B §4.7 G4a and §7): formal store rows → CanonicalData
 * (`projectStoreToCanonical`, 3C-1b) → the five V2 files (`serializeV2`). Since 3C-5B the App reads the read model, not
 * these files; they remain the V2 form of a store.
 *
 * Also the parity checks of the migration (design 3B §7, two paths): the projection must equal readV2 of the V2 files it
 * came from, and the derived baseline (the same digest as `npm run baseline`) of the App's real input — the serialized
 * projection — must equal the one of the original V2 files.
 *
 * Pure apart from timing; no IO.
 *
 * Compat (3C-5 E spec §2.4; moved here from scripts/): the V2 files of a store (the migration's parity checks, the
 * format-1 upgrade, tests and benchmarks).
 * V2 files are read and written only to migrate a library, to show a root that awaits migration (read-only), and to
 * export a library to V2 (store:export-v2). Ordinary read and write code does not import this directory
 * (../compat-boundary.test.mjs).
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalForInputs } from '../../src/data/compat/v2/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../../src/data/canonical/derive.ts'
import { readV2 } from '../../src/data/compat/v2/v2Reader.ts'
import { serializeV2 } from '../../src/data/compat/v2/v2Serializer.ts'
import { buildBaseline, stableStringify } from '../../src/data/derive/baseline.ts'
import { projectStoreToCanonical } from '../../src/data/store/projectCanonical.ts'

/** The `now` of scripts/baseline.mjs, so the digests here are the digests of `npm run baseline`. */
const BASELINE_NOW = '2000-01-01T00:00:00.000Z'
const ms = (started) => Math.round((performance.now() - started) * 10) / 10

/**
 * Rows of the store (readRowsUnchecked or readFormalState) → `{ projection, files, timings }`: `projection` is
 * projectStoreToCanonical's result (canonical, v2Meta, skipped), `files` the five V2 files the App reads, and
 * `timings` the milliseconds of each step ({ projectMs, serializeMs }). The rows are not modified.
 */
export function projectToV2Files(rows) {
  let started = performance.now()
  const projection = projectStoreToCanonical(rows, { source: 'local' })
  const projectMs = ms(started)
  started = performance.now()
  const files = serializeV2(projection.canonical, projection.v2Meta)
  return { projection, files, timings: { projectMs, serializeMs: ms(started) } }
}

/** SHA-256 of the derived baseline of five V2 files (the App's pipeline: canonicalForInputs → derive → buildBaseline). */
export function derivedBaselineDigest(files) {
  const exports = deriveAppDataFromCanonical(canonicalForInputs({ v2Files: files }), { now: BASELINE_NOW })
  return createHash('sha256').update(stableStringify(buildBaseline(exports, { now: BASELINE_NOW }))).digest('hex')
}

/**
 * Compare a store's projection with the V2 files it was migrated from. `files` are the complete, valid V2 files.
 * Returns { canonical, baseline } (true when equal), and `ok` when both are. Differences are reported as booleans only:
 * the values are private data.
 */
export function compareWithV2(projection, files) {
  const canonical = isDeepStrictEqual(projection.canonical, readV2(files))
  const baseline = derivedBaselineDigest(serializeV2(projection.canonical, projection.v2Meta)) === derivedBaselineDigest(files)
  return Object.freeze({ ok: canonical && baseline, canonical, baseline })
}

/** `skipped` (projectStoreToCanonical) as counts per table, for logs that must not list ids. */
export function skippedCounts(skipped) {
  const counts = {}
  for (const { table } of skipped) counts[table] = (counts[table] ?? 0) + 1
  return counts
}
