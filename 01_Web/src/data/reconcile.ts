/**
 * Structural sharing between two versions of derived data (3C-5 D, design §1 step 4, "keep object identities"): the
 * result is `next`, except that every part of it that equals the matching part of `prev` is `prev`'s object. A save
 * changes a few records; with this, everything else keeps its identity, so `React.memo` and the map's entities skip
 * what did not change, and a selector hook re-renders only the components whose slice changed.
 *
 * - Plain objects and arrays are compared member by member; arrays of objects with an id (`id`, `entityId`, `sourceId`,
 *   `recordId`) are matched by it, others by position. Maps by key, Sets by members (primitive members only).
 * - Functions cannot be compared: an object whose other members are all `prev`'s (and has the same keys) is `prev`'s
 *   object, its functions included (they were made from equal data). Otherwise `next`'s functions are kept.
 * - Anything else (class instances, dates) is `prev`'s only when it is the same object.
 * - Shared parts of `next` stay shared in the result (each object of `next` is reconciled once).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript).
 */

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const ID_KEYS = ['id', 'entityId', 'sourceId', 'recordId'] as const
const idOf = (value: unknown): string | undefined => {
  if (!isPlain(value)) return undefined
  for (const key of ID_KEYS) if (typeof value[key] === 'string') return `${key}:${value[key]}`
  return undefined
}

export function reconcile<T>(prev: unknown, next: T): T {
  const done = new WeakMap<object, unknown>()
  const walk = (before: unknown, after: unknown): unknown => {
    if (Object.is(before, after)) return before
    if (after === null || typeof after !== 'object') return after
    const known = done.get(after)
    if (known !== undefined) return known
    let result: unknown = after
    if (Array.isArray(after)) {
      if (Array.isArray(before)) {
        const keyed = after.length > 0 && idOf(after[0]) !== undefined
        const previous = keyed ? new Map(before.map((item) => [idOf(item), item])) : undefined
        let same = before.length === after.length
        const items = after.map((item, index) => {
          const match = keyed ? previous!.get(idOf(item)) : before[index]
          const value = walk(match, item)
          if (value !== before[index]) same = false
          return value
        })
        result = same ? before : items
      }
    } else if (after instanceof Map) {
      if (before instanceof Map) {
        let same = before.size === after.size
        const entries: [unknown, unknown][] = []
        for (const [key, value] of after) {
          const old = before.get(key)
          const merged = walk(old, value)
          if (merged !== old || !before.has(key)) same = false
          entries.push([key, merged])
        }
        result = same ? before : new Map(entries)
      }
    } else if (after instanceof Set) {
      if (before instanceof Set && before.size === after.size && [...after].every((member) => before.has(member))) result = before
    } else if (isPlain(after) && isPlain(before)) {
      const keys = Object.keys(after)
      let same = keys.length === Object.keys(before).length
      const merged: Record<string, unknown> = {}
      for (const key of keys) {
        const value = after[key]
        if (typeof value === 'function') {
          if (typeof before[key] !== 'function') same = false
          merged[key] = value
          continue
        }
        if (!Object.hasOwn(before, key)) same = false
        const kept = walk(before[key], value)
        if (kept !== before[key]) same = false
        merged[key] = kept
      }
      result = same ? before : (Object.isFrozen(after) ? Object.freeze(merged) : merged)
    }
    done.set(after, result)
    return result
  }
  return walk(prev, next) as T
}
