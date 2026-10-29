/** Bringing a store's official definition rows to the code's (3C-5 G): the definitions half of `npm run store:upgrade`.
 *
 * A store records the version of its official definitions (the host's `store_definitions`, store format 4); the code
 * has OFFICIAL_DEFINITIONS at OFFICIAL_DEFINITIONS_VERSION (./officialDefinitions.ts). The upgrade writes, for every
 * official definition row of the code (sources, entity types, relation types, layers, in dependency order):
 * - nothing when the store's row has the same content (the row's `revision` is the store's bookkeeping, not content);
 * - a `create` when the store has no row of that id (a definition added later, such as a 3C-6 template);
 * - an `update` (the store's revision + 1) when the content differs, after Core's checkDefinitionChange: definitions
 *   only evolve compatibly (design 3B §3.3: names, new optional fields, required to optional, wider ranges and type
 *   lists), so an incompatible change refuses the whole upgrade with E_SCHEMA_CHANGE and the store stays as it was. The
 *   planner checks every update again inside the upgrade's transaction.
 * A row the store has and the code does not (none so far) is left alone: removing a definition is not compatible.
 * A version whose rows need data changed with them would add its commands here, keyed by the version it starts from;
 * none has so far.
 *
 * Pure: the state is not modified.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalEntityType, FormalLayer, FormalRelationType, FormalState, FormalTable } from '../../worldgraph/store/formal.ts'
import { checkDefinitionChange } from '../../worldgraph/store/evolution.ts'
import { jsonKey } from '../../worldgraph/store/primitives.ts'
import type { JsonValue, SourceDefinition } from '../../worldgraph/store/types.ts'
import { OFFICIAL_DEFINITIONS } from './officialDefinitions.ts'

/** One version of the official definitions: the rows of each definition table. */
export interface OfficialDefinitionSet {
  readonly sources: readonly SourceDefinition[]
  readonly entityTypes: readonly FormalEntityType[]
  readonly relationTypes: readonly FormalRelationType[]
  readonly layers: readonly FormalLayer[]
}

/** The definition tables in dependency order (types before the layers and relation types that name them). */
const TABLES = Object.freeze(['sources', 'entityTypes', 'relationTypes', 'layers'] as const)

/** A definition row's content: everything but its revision. */
const contentOf = (row: { readonly revision: number }) => {
  const { revision: _revision, ...content } = row as Record<string, unknown>
  void _revision
  return jsonKey(content as JsonValue)
}

/**
 * The commands that bring the official definition rows of `state` to `definitions` (default: the code's current ones).
 * Throws Core's StoreError E_SCHEMA_CHANGE when a row of `definitions` is not a compatible evolution of the store's.
 */
export function officialDefinitionSyncCommands(state: FormalState, definitions: OfficialDefinitionSet = OFFICIAL_DEFINITIONS): FormalCommand[] {
  const commands: FormalCommand[] = []
  for (const table of TABLES) {
    const stored = new Map((state[table] as readonly { readonly id: string; readonly revision: number }[]).map((row) => [row.id, row]))
    for (const row of definitions[table] as readonly { readonly id: string; readonly revision: number }[]) {
      const before = stored.get(row.id)
      if (!before) {
        commands.push({ op: 'create', table: table as FormalTable, value: structuredClone({ ...row, revision: 0 }) } as FormalCommand)
        continue
      }
      if (contentOf(before) === contentOf(row)) continue
      const value = structuredClone({ ...row, revision: before.revision + 1 })
      checkDefinitionChange(table, before, value)
      commands.push({ op: 'update', table: table as FormalTable, id: row.id, expectedRevision: before.revision, value } as FormalCommand)
    }
  }
  return commands
}
