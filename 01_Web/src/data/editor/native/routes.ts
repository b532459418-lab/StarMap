/**
 * The store-native editor writes (3C-5 C1, design 3C-5 §3): by endpoint, the planner that turns a request into store
 * commands with the official reader, and the status of a success. The host session (scripts/store-session.mjs) runs
 * them: protocol, receipt lookup, E_STALE against the live index, plan, commit, then the live index moves on.
 *
 * A planner is pure: it reads the official reader (one revision of the live index) and the context (`now`, `newId`, the
 * country catalog), and returns `{ commands, result }` or throws the V2WriteError of the decision layer (../rules/),
 * with the same codes and parameters as the V2 write functions it replaces.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand } from '../../../worldgraph/store/formal.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import type { CatalogCountry } from '../../v2write/transaction.ts'
import { convertWrite } from './convert.ts'
import { editorViewWrite } from './editorView.ts'
import { addCountryWrite, addTravelRecordWrite, deleteCountriesWrite } from './footprint.ts'
import { addWantToGoWrite, deleteWantToGoWrite, updateWantToGoWrite } from './wantToGo.ts'

export interface NativeWriteContext {
  /** This write's time: createdAt / updatedAt of new and changed entries, the default date of a want-to-go item. */
  readonly now: Date
  /** Fresh lowercase UUIDv7 for every new row. */
  readonly newId: () => string
  /** The country catalog by upper-case ISO code. */
  readonly countryCatalog: ReadonlyMap<string, CatalogCountry>
}
export interface NativePlan<R = unknown> {
  readonly commands: readonly FormalCommand[]
  readonly result: R
}
export interface NativeWrite {
  readonly status: number
  plan(reader: OfficialReader, input: unknown, ctx: NativeWriteContext): NativePlan
}

/** The store-native endpoints by `METHOD /path` (filled in by the commits of 3C-5 C1). */
export const NATIVE_WRITES: Readonly<Record<string, NativeWrite>> = Object.freeze({
  'POST /__travelatlas/editor/view': editorViewWrite,
  'POST /__travelatlas/editor/records': addTravelRecordWrite,
  'POST /__travelatlas/editor/countries': addCountryWrite,
  'POST /__travelatlas/editor/countries/delete': deleteCountriesWrite,
  'POST /__travelatlas/editor/wanttogo/convert': convertWrite,
  'POST /__travelatlas/editor/wanttogo': addWantToGoWrite,
  'POST /__travelatlas/editor/wanttogo/update': updateWantToGoWrite,
  'POST /__travelatlas/editor/wanttogo/delete': deleteWantToGoWrite,
})
