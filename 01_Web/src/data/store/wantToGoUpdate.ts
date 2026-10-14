/** POST /__travelatlas/editor/wanttogo/update in the new-library mode (3C-3, design 3B §4.4): the request V2 accepts,
 * `{ id, note?, hidden? }`, translated into formal store commands.
 *
 * - Input: the same rules and messages as the V2 write (`updateWantToGo` in ../v2write/wantToGo.ts): `id` is required,
 *   at least one of `note` / `hidden`, `hidden` is a boolean, `note` is text of at most 200 characters after trimming,
 *   and an empty note removes it.
 * - The item: a migrated want-to-go item is the entry of source `v2:want-to-go` whose `recordId` is the V2 id (the
 *   host finds its entry id in `id_map`); one created after the migration (`starmap:user`) is the entry with that id.
 *   Anything else, `planned` footprint records included, is E_WTG_NOT_FOUND, as in V2.
 * - `note` is the entry's `note` field: one `update` with the entry's revision as `expectedRevision`.
 * - `hidden` is a row of the official view scope `starmap:hidden/want-to-go` (hiding is view state, never a field):
 *   true creates it or keeps it, false removes it. A removed view row is tombstoned for good, so a new one gets a new id
 *   (the caller passes one per request).
 * - Nothing to change gives no command.
 *
 * Pure: the reader is Core's StoreReader, bound by the host to one read transaction.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, ViewItem } from '../../worldgraph/store/formal.ts'
import type { JsonObject, JsonValue, LayerEntry } from '../../worldgraph/store/types.ts'
import type { StoreReader } from '../../worldgraph/store/reader.ts'
import { jsonKey } from '../../worldgraph/store/primitives.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { bodyOf, requireText } from '../v2write/common.ts'
import { fail } from '../v2write/errors.ts'
import { normalizeNote } from '../v2write/wantToGo.ts'
import { OFFICIAL, V2_SOURCES, VIEW_SCOPES } from './officialDefinitions.ts'

/** A validated update: the V2 item id and what to change (`note: ''` removes the note). */
export interface WantToGoUpdate {
  readonly id: string
  readonly hidden?: boolean
  readonly note?: string
}

/** The V2 input → a WantToGoUpdate, or V2WriteError with the V2 code and message. */
export function readWantToGoUpdate(input: unknown): WantToGoUpdate {
  const body = bodyOf(input)
  const id = requireText(body.id, 'id')
  const hasHidden = body.hidden !== undefined
  const hasNote = body.note !== undefined
  if (!hasHidden && !hasNote) fail('E_WTG_UPDATE_EMPTY')
  if (hasHidden && typeof body.hidden !== 'boolean') fail('E_HIDDEN_NOT_BOOLEAN')
  const note = hasNote ? normalizeNote(body.note) ?? '' : undefined
  return { id, ...(hasHidden ? { hidden: body.hidden as boolean } : {}), ...(note !== undefined ? { note } : {}) }
}

/** The canonical JSON of an update: the same intent gives the same text (the host fingerprints requests with it). */
export const wantToGoUpdateKey = (update: WantToGoUpdate): string => jsonKey(update)

/** Whether `entry` is the want-to-go item the V2 id `id` names. */
function isWantToGoItem(entry: LayerEntry | undefined, id: string): entry is LayerEntry {
  if (!entry || entry.layerId !== OFFICIAL.wantToGo) return false
  if (entry.source.sourceId === V2_SOURCES.wantToGo) return entry.source.recordId === id
  return entry.source.sourceId === OFFICIAL.user && entry.id === id
}

const plain = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `extensions` without a verbatim V2 `note` (a note that was not text in V2), dropping emptied objects. */
function withoutV2Note(extensions: JsonObject | undefined): JsonObject | undefined {
  const v2 = extensions?.v2
  if (!plain(v2) || !Object.hasOwn(v2, 'note')) return extensions
  const rest: Record<string, JsonValue> = { ...v2 }
  delete rest.note
  const next: Record<string, JsonValue> = { ...extensions }
  if (Object.keys(rest).length) next.v2 = rest
  else delete next.v2
  return Object.keys(next).length ? next : undefined
}

export interface WantToGoUpdateContext {
  /** Host time (UTC timestamp) for the entry's `updatedAt`; an older entry time is kept instead. */
  readonly now: string
  /** Id of a new hidden-scope view row; unique per request. */
  readonly newViewItemId: string
}

/**
 * The commands of `update` against the state `reader` sees. `entryId` is the entry the host resolved for `update.id`
 * (from `id_map`, or the id itself). E_WTG_NOT_FOUND when that entry is not this want-to-go item.
 */
export function wantToGoUpdateCommands(reader: StoreReader, entryId: string, update: WantToGoUpdate, context: WantToGoUpdateContext): FormalCommand[] {
  const entry = reader.get('entries', entryId) as LayerEntry | undefined
  if (!isWantToGoItem(entry, update.id)) return fail('E_WTG_NOT_FOUND', { id: update.id })
  const commands: FormalCommand[] = []

  if (update.note !== undefined) {
    const fields: Record<string, JsonValue> = { ...entry.fields }
    if (update.note) fields.note = update.note
    else delete fields.note
    const extensions = withoutV2Note(entry.extensions)
    if (jsonKey(fields) !== jsonKey(entry.fields) || extensions !== entry.extensions) {
      const updatedAt = Date.parse(context.now) >= Date.parse(entry.updatedAt) ? context.now : entry.updatedAt
      const value: Record<string, unknown> = { ...entry, revision: entry.revision + 1, fields, updatedAt }
      if (extensions === undefined) delete value.extensions
      else value.extensions = extensions
      commands.push({ op: 'update', table: 'entries', id: entry.id, expectedRevision: entry.revision, value: value as unknown as LayerEntry })
    }
  }

  if (update.hidden !== undefined) {
    const scope = VIEW_SCOPES.wantToGoHidden
    const viewId = reader.findViewItem(scope, 'entries', entry.id)
    const view = viewId === undefined ? undefined : reader.get('viewItems', viewId) as ViewItem | undefined
    if (update.hidden && !view) {
      commands.push({
        op: 'create', table: 'viewItems',
        value: { id: context.newViewItemId, revision: 0, scope, itemTable: 'entries', itemId: entry.id, layerId: OFFICIAL.wantToGo, position: positionBetween(), hidden: true },
      })
    } else if (update.hidden && view && !view.hidden) {
      commands.push({ op: 'update', table: 'viewItems', id: view.id, expectedRevision: view.revision, value: { ...view, revision: view.revision + 1, hidden: true } })
    } else if (!update.hidden && view) {
      commands.push({ op: 'remove', table: 'viewItems', id: view.id, expectedRevision: view.revision })
    }
  }
  return commands
}
