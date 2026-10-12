/** Compatible definition evolution (design 3B §3.3). Records carry no definition
 * version and are always read with the current definition, so a change may never
 * alter what an existing value means. Anything else needs a data migration, which
 * is designed separately later.
 */
import type { FormalFieldDefinition, FormalTable } from './formal.ts'
import { type ObjectValue, jsonKey, reject } from './primitives.ts'

export const DEFINITION_TABLES: readonly FormalTable[] = Object.freeze(['sources','entityTypes','layers','relationTypes'])

/** An empty type list accepts every type, so it is the widest list. */
const widens = (before: readonly string[], after: readonly string[]): boolean =>
  !after.length || before.length > 0 && before.every(type => after.includes(type))

function fieldsWiden(before: readonly FormalFieldDefinition[], after: readonly FormalFieldDefinition[], path: string) {
  for (const old of before) {
    const next = after.find(field => field.key === old.key)
    if (!next || next.kind !== old.kind) reject('E_SCHEMA_CHANGE', path)
    if (!old.required && next.required) reject('E_SCHEMA_CHANGE', path)
    if (next.min !== undefined && (old.min === undefined || next.min > old.min)) reject('E_SCHEMA_CHANGE', path)
    if (next.max !== undefined && (old.max === undefined || next.max < old.max)) reject('E_SCHEMA_CHANGE', path)
  }
  if (after.some(next => next.required && !before.some(old => old.key === next.key))) reject('E_SCHEMA_CHANGE', path)
}

/** Throws E_SCHEMA_CHANGE unless `after` is a compatible edit of `before`. Both must
 * be valid rows of `table` (validateRow, formal dialect) with the same id.
 * Allowed: names, extensions, field order, new optional fields, setting or clearing
 * `deprecated`, required to optional, wider numeric ranges, wider type lists.
 * Rejected: removing a field, changing its kind, optional to required, narrower
 * ranges or type lists, any systemKey change, a source's origin. */
export function checkDefinitionChange(table: FormalTable, before: unknown, after: unknown): void {
  const b = before as ObjectValue, a = after as ObjectValue
  const types = (key: string) => { if (!widens(b[key] as string[], a[key] as string[])) reject('E_SCHEMA_CHANGE', `${table}.${key}`) }
  switch (table) {
    case 'sources':
      if (a.origin !== b.origin) reject('E_SCHEMA_CHANGE', 'sources.origin')
      return
    case 'entityTypes':
      fieldsWiden(b.fields as FormalFieldDefinition[], a.fields as FormalFieldDefinition[], 'entityTypes.fields')
      return
    case 'layers':
      if (jsonKey(b.systemKey ?? null) !== jsonKey(a.systemKey ?? null)) reject('E_SCHEMA_CHANGE', 'layers.systemKey')
      types('acceptedEntityTypes')
      fieldsWiden(b.entryFields as FormalFieldDefinition[], a.entryFields as FormalFieldDefinition[], 'layers.entryFields')
      return
    case 'relationTypes':
      types('fromTypes'); types('toTypes')
      fieldsWiden(b.fields as FormalFieldDefinition[], a.fields as FormalFieldDefinition[], 'relationTypes.fields')
      return
    default: reject('E_SCHEMA_CHANGE', table)
  }
}
