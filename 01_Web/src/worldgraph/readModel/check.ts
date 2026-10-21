/** Reading and validating a read model (3C-5A; design 3B v1.1 §16.2-4: no full check on the hot path).
 *
 * - `readReadModel(value)`: what a reader does before using a read model. The header (format, version, revision,
 *   origin), the set of tables, and the shape every table shares: an array of rows with an opaque id, a revision and an
 *   optional plain `extensions`, no id twice. No row rule, no reference check. A higher `formatVersion` is
 *   E_READ_MODEL_TOO_NEW: the reader is older than the model.
 * - `validateReadModel(value, policy)`: the full check, for exports and tests only. The rows go through
 *   `readFormalState`, i.e. Core's own row rules, references and unique keys; there is no second rule set.
 *   Review receipts are host bookkeeping and never in a read model, so a row that names one (`source.reviewId`, an AI
 *   fact accepted by review) is trusted to have it: the check stands in a receipt for each review id the rows name,
 *   with the source of the first row naming it, so two rows naming one review with different sources still fail
 *   (E_REVIEW_SOURCE).
 *
 * Errors are StoreError (code and path only, never values).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { StorePolicy } from '../store/types.ts'
import { readFormalState } from '../store/formal.ts'
import { plain, reject, revision, shape } from '../store/primitives.ts'
import { validateRowBase } from '../store/rows.ts'
import {
  READ_MODEL_FORMAT, READ_MODEL_FORMAT_VERSION, READ_MODEL_HEADER_KEYS, READ_MODEL_ORIGINS, READ_MODEL_TABLES,
  type ReadModel, type ReadModelOrigin,
} from './types.ts'

/** Header and shape only (see the file header); returns the value as a ReadModel, unchanged. */
export function readReadModel(value: unknown): ReadModel {
  if (!plain(value)) reject('E_SHAPE', '$')
  if (value.format !== READ_MODEL_FORMAT) reject('E_READ_MODEL_FORMAT', '$.format')
  const version = value.formatVersion
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > READ_MODEL_FORMAT_VERSION) reject('E_READ_MODEL_TOO_NEW', '$.formatVersion')
  if (version !== READ_MODEL_FORMAT_VERSION) reject('E_READ_MODEL_VERSION', '$.formatVersion')
  shape(value, [...READ_MODEL_HEADER_KEYS, ...READ_MODEL_TABLES])
  revision(value.revision, '$.revision')
  if (!READ_MODEL_ORIGINS.includes(value.origin as ReadModelOrigin)) reject('E_READ_MODEL_ORIGIN', '$.origin')
  for (const table of READ_MODEL_TABLES) {
    const rows = value[table]
    if (!Array.isArray(rows)) reject('E_SHAPE', table)
    const seen = new Set<string>()
    for (const row of rows) {
      validateRowBase(table, row)
      if (seen.has(row.id as string)) reject('E_DUPLICATE', table)
      seen.add(row.id as string)
    }
  }
  return value as unknown as ReadModel
}

const REVIEW_STAND_IN_TIME = '1970-01-01T00:00:00.000Z'

/** The full check (see the file header). Throws StoreError; returns nothing. */
export function validateReadModel(value: unknown, policy: StorePolicy = {}): void {
  const model = readReadModel(value)
  const reviews = new Map<string, { id: string; revision: number; proposalId: string; sourceId: string; acceptedAt: string }>()
  for (const table of READ_MODEL_TABLES) {
    for (const row of model[table] as readonly { readonly source?: unknown }[]) {
      const source = row.source
      if (!plain(source) || typeof source.reviewId !== 'string' || reviews.has(source.reviewId)) continue
      if (typeof source.sourceId !== 'string') continue
      reviews.set(source.reviewId, {
        id: source.reviewId, revision: 0, proposalId: `read-model:${source.reviewId}`, sourceId: source.sourceId, acceptedAt: REVIEW_STAND_IN_TIME,
      })
    }
  }
  const state: Record<string, unknown> = { revision: model.revision, tombstones: [], reviews: [...reviews.values()] }
  for (const table of READ_MODEL_TABLES) state[table] = model[table]
  readFormalState(state, policy)
}
