/** Sort keys for view rows: base-62 fractions compared as plain strings.
 * '0'-'9' < 'A'-'Z' < 'a'-'z' in code-unit order, so string order is numeric
 * order. A key never ends in '0', which keeps room before every key. */
import { reject } from './primitives.ts'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const MAX_POSITION_LENGTH = 64

export const isPosition = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9A-Za-z]{1,64}$/.test(value) && !value.endsWith('0')

/** a < result < b. `a` = '' means no lower bound, `b` = null no upper bound.
 * Appends step up by one digit and prepends step down by one, so repeated
 * inserts at either end grow the key slowly; inserts between halve the gap. */
function between(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while (n < b.length && (a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + between(a.slice(n), b.slice(n))
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0
  const high = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (high - low > 1) return DIGITS[b === null && a ? low + 1 : !a && b !== null ? high - 1 : Math.floor((low + high) / 2)]
  if (b !== null && b.length > 1) return b[0]
  return DIGITS[low] + between(a.slice(1), null)
}

/** Deterministic key strictly between `before` and `after` (either may be absent).
 * E_POSITION for malformed or unordered bounds, or when no key of at most
 * MAX_POSITION_LENGTH characters fits. Renumbering is a caller decision. */
export function positionBetween(before?: string, after?: string): string {
  if (before !== undefined && !isPosition(before) || after !== undefined && !isPosition(after)) reject('E_POSITION', 'position')
  if (before !== undefined && after !== undefined && before >= after) reject('E_POSITION', 'position')
  const key = between(before ?? '', after ?? null)
  if (key.length > MAX_POSITION_LENGTH) reject('E_POSITION', 'position')
  return key
}
