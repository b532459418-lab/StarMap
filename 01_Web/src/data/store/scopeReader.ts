/**
 * A store reader that also answers the rows of one view scope (3C-4a; 3C-5 E: moved here from the retired
 * diffV2ToCommands): the host's SqliteStoreReader (scripts/store-host.mjs `viewScope`) in a read transaction, and
 * memoryScopeReader over a formal state in tests. The media records (./mediaRecords.ts) plan with it.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalState, ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import { memoryReader, type StoreReader } from '../../worldgraph/store/reader.ts'

/** A store reader with the rows of one view scope. */
export interface ScopeReader extends StoreReader {
  viewScope(scope: string): { readonly items: readonly ViewItem[]; readonly settings: readonly ViewSetting[] }
}

/** The scope reader of a formal state (tests): the memory reader, and every scope's rows. */
export function memoryScopeReader(state: FormalState): ScopeReader {
  const reader = memoryReader(state)
  const scopes = new Map<string, { items: ViewItem[]; settings: ViewSetting[] }>()
  const scopeOf = (scope: string) => {
    let rows = scopes.get(scope)
    if (!rows) { rows = { items: [], settings: [] }; scopes.set(scope, rows) }
    return rows
  }
  for (const item of state.viewItems) scopeOf(item.scope).items.push(item)
  for (const setting of state.viewSettings) scopeOf(setting.scope).settings.push(setting)
  const none = Object.freeze({ items: Object.freeze([]), settings: Object.freeze([]) })
  return Object.freeze({ ...reader, viewScope: (scope: string) => scopes.get(scope) ?? none })
}
