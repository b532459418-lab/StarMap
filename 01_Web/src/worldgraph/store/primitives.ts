/** Store-wide primitives shared by row rules, whole-store validation and planning.
 * schema.ts re-exports the public ones unchanged; existing importers keep using it.
 */
import { isCalendarDate } from '../timeFilter.ts'
import type { JsonValue } from './types.ts'

/** Safe diagnostics: code/path only, never user record contents. */
export class StoreError extends Error {
  readonly code: string
  readonly path: string
  constructor(code: string, path: string) {
    super(`${code}: ${path}`); this.code = code; this.path = path
  }
}
export function reject(code: string, path: string): never { throw new StoreError(code, path) }
export type ObjectValue = Record<string, unknown>
export const plain = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

/** Validate descriptors before reading values; reject getter execution and lossy JSON. */
export function validateJson(value: unknown, path = '$', parents = new Set<object>(), depth = 0): asserts value is JsonValue {
  if (depth > 64) reject('E_JSON_DEPTH', path)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!Array.isArray(value) && !plain(value)) reject('E_JSON', path)
  if (parents.has(value)) reject('E_JSON_CYCLE', path)
  parents.add(value)
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) reject('E_JSON_ARRAY', path)
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i))
      if (!d || !d.enumerable || !('value' in d)) reject('E_JSON_ARRAY', path)
      validateJson(d.value, `${path}[${i}]`, parents, depth + 1)
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !('value' in d)) reject('E_JSON', path)
      validateJson(d.value, `${path}.${key}`, parents, depth + 1)
    }
  }
  parents.delete(value)
}
export function shape(value: unknown, keys: readonly string[], required = keys, path = '$'): asserts value is ObjectValue {
  const allowed=keys.includes('id')&&keys.includes('revision')?[...keys,'extensions']:keys
  if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) reject('E_SHAPE', path)
}
export function opaqueId(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) reject('E_ID', path)
}
export function revision(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject('E_REVISION', path)
}
export function uuid(value: unknown, path: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) reject('E_UUID7', path)
}
export function utcTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !isCalendarDate(value.slice(0,10))) reject('E_TIME', path)
  if (+value.slice(11,13) > 23 || +value.slice(14,16) > 59 || +value.slice(17,19) > 59) reject('E_TIME', path)
}
/** Canonical key sorting only; array order and every persisted value remain significant. */
export function jsonKey(value: unknown): string {
  validateJson(value)
  const serialize = (v: JsonValue): string => {
    if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']'
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+serialize((v as Record<string, JsonValue>)[k])).join(',') + '}'
    return JSON.stringify(v)
  }
  return serialize(value)
}
export function validateStoredDates(value: unknown, path = '$.date') {
  validateJson(value,path)
  shape(value,['raw'],['raw'],path)
  shape(value.raw,['startDate','endDate','year'],[],path+'.raw')
  // Historical evidence may be partial, invalid or missing. Never repair it here.
}
export function freezeCopy<T>(value: T): T {
  const freeze=(v:unknown):void=>{if(v && typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v)}}
  const copied=structuredClone(value); freeze(copied); return copied
}
