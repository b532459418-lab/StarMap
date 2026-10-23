/**
 * The rows a store format upgrade writes (`npm run store:upgrade`, scripts/store-upgrade.mjs), for the formats whose
 * meaning of the official rows changed. Format 1 → 2 (3C-4c) added the media registry and wrote no row of the formal
 * tables.
 *
 * Format 2 → 3 (3C-5 E spec §2.6): an added country is a `starmap:travel` entry on a country (the place's `subtype`
 * marks it, ./projectCanonical.ts officialEntryRole), no longer the evidence of the V2 source `v2:country-visit`. Before,
 * a country added without a visit date had that evidence only; the upgrade gives each such country its visit entry
 * (no date, citing the evidence, the source the migration gives it), so the official view reads the same added
 * countries, values and order as before. A country that already has a travel entry is left as it is.
 *
 * Why a format upgrade and not a one-time step when a store is opened: every way into a store of an older format (the
 * App, the session, the tools, a backup's restore) stops at E_STORE_UPGRADE_REQUIRED until store:upgrade ran, so no code
 * ever reads rows of format 2 with the rules of format 3; and the upgrade is one transaction under the library lease,
 * checked in full afterwards, like the 3C-4c one. A step at open would have to run inside some reader first, and the
 * read-only consumers (the personal build, the read model export) would read the old rows with the new rules.
 *
 * Pure: the state is not modified; ids and the time come from the caller.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalState } from '../../worldgraph/store/formal.ts'
import type { Evidence, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import { OFFICIAL, V2_SOURCES } from './officialDefinitions.ts'
import { sourceRef } from './v2RecordRows.ts'

/** The commands of an upgrade from `fromVersion` to format 3 (none from 3 on). */
export function storeFormatUpgradeCommands(state: FormalState, fromVersion: number, ids: { readonly now: string; readonly newId: () => string }): FormalCommand[] {
  return fromVersion < 3 ? countryVisitEntriesOf(state, ids) : []
}

/** Format 2 → 3: a visit entry for each added country that has only its evidence (see the file header). */
export function countryVisitEntriesOf(state: FormalState, { now, newId }: { readonly now: string; readonly newId: () => string }): FormalCommand[] {
  const countries = new Set((state.entities as readonly StoreEntity[]).filter((entity) => entity.typeId === OFFICIAL.place && entity.fields.subtype === 'country').map((entity) => entity.id))
  const visited = new Set((state.entries as readonly LayerEntry[]).filter((entry) => entry.layerId === OFFICIAL.travel && countries.has(entry.entityId)).map((entry) => entry.entityId))
  const commands: FormalCommand[] = []
  const evidence = [...(state.evidence as readonly Evidence[])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const row of evidence) {
    if (row.sourceId !== V2_SOURCES.countryVisit || !countries.has(row.recordId) || visited.has(row.recordId)) continue
    visited.add(row.recordId)
    const entry: LayerEntry = {
      id: newId(), revision: 0, layerId: OFFICIAL.travel, entityId: row.recordId, fields: { date: { raw: {} } },
      source: sourceRef(V2_SOURCES.countryVisit, row.recordId, [row.id]), createdAt: now, updatedAt: now,
    }
    commands.push({ op: 'create', table: 'entries', value: entry })
  }
  return commands
}
