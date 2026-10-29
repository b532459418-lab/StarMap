/**
 * Digests of media plans (3C-4c tasks, 3C-5 F re-reading and re-importing): SHA-256 (hex) of a JSON whose object keys
 * are sorted, so the same plan always gives the same digest. A preview hands its digest to the page or the command
 * line; the write computes the plan again under the library lease and refuses when the digest differs.
 */
import { createHash } from 'node:crypto'

/** SHA-256 (lowercase hex) of a string. */
export const hash = (value) => createHash('sha256').update(value).digest('hex')

const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]))
  return value
}

/** JSON with sorted object keys (`undefined` becomes null at the top). */
export const stable = (value) => JSON.stringify(normalized(value) ?? null)

/** A plan digest as the requests carry it: 64 lowercase hex digits. */
export const isPlanDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
