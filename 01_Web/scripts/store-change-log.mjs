/**
 * The changed rows of the last commits a dev server saw (3C-5 D, design §3): what the page fetches to move its read
 * model on without reading it whole (GET /__travelatlas/editor/read-model/changes?since=R).
 *
 * - Each entry is `{ libraryId, restoreMark, from, to, upserts, deletes }`: one commit of this process (`to` = `from`
 *   + 1), or the rows another process changed (`to` may be several revisions on, ./store-session.mjs checkExternal).
 *   Only read-model tables (src/worldgraph/readModel/types.ts).
 * - The entries form one chain: each starts where the previous one ended. An entry that does not continue the chain
 *   clears it first (whatever came before can no longer be told apart).
 * - At most `maxEntries` entries and `maxRows` changed rows in all; the oldest go first (a single larger entry is kept
 *   alone).
 * - `since(revision, { current, library })` answers the entries from `revision` to the current revision, or why it
 *   cannot (`gone` with a reason; the endpoint answers 410 and the page reads the whole read model again):
 *   - `library`: the page's read model is of another library (its id) — a library put in place of the one it read;
 *   - `restored`: the same library restored from a backup (its restore mark changed);
 *   - `ahead`: the page is at a revision the library has not reached (the library was replaced by an older copy);
 *   - `restart`: nothing is kept (a new dev server, or the chain was cleared) and the page is not current;
 *   - `too-old`: the page's revision is older than the first change kept.
 *
 * Constraint: plain ESM; it imports only the read-model table list (tests load it directly).
 */
import { READ_MODEL_TABLES } from '../src/worldgraph/readModel/types.ts'

export const CHANGE_LOG_ENTRIES = 128
export const CHANGE_LOG_ROWS = 50_000

const readModelTables = new Set(READ_MODEL_TABLES)

/** A commit's change set (the host's `changes`) as a change-log entry: read-model tables only. */
export function changeEntryOf(identity, changes) {
  return Object.freeze({
    libraryId: identity.libraryId,
    restoreMark: identity.restoreMark,
    from: changes.baseRevision,
    to: changes.nextRevision,
    upserts: changes.upserts.filter((change) => readModelTables.has(change.table)),
    deletes: changes.deletes.filter((change) => readModelTables.has(change.table)),
  })
}

const rowsOf = (entry) => entry.upserts.length + entry.deletes.length

export function createChangeLog({ maxEntries = CHANGE_LOG_ENTRIES, maxRows = CHANGE_LOG_ROWS } = {}) {
  let entries = []
  let rows = 0
  return {
    /** Append an entry (see the file header). */
    add(entry) {
      const last = entries.at(-1)
      if (last && (last.to !== entry.from || last.libraryId !== entry.libraryId || last.restoreMark !== entry.restoreMark)) {
        entries = []
        rows = 0
      }
      entries.push(entry)
      rows += rowsOf(entry)
      while (entries.length > 1 && (entries.length > maxEntries || rows > maxRows)) rows -= rowsOf(entries.shift())
      return entry
    },
    /** Forget every entry (the next `since` that is not current answers `restart`). */
    clear() {
      entries = []
      rows = 0
    },
    /** The revision the kept chain ends at, or undefined. */
    get lastRevision() { return entries.at(-1)?.to },
    get size() { return entries.length },
    /**
     * The entries from `revision` to `current.revision` for a page whose read model is of `library` (`{ libraryId,
     * restoreMark }`, either part may be missing), or `{ gone }` (see the file header).
     */
    since(revision, { current, library = {} }) {
      if (library.libraryId !== undefined && library.libraryId !== current.libraryId) return { gone: 'library' }
      if (library.restoreMark !== undefined && library.restoreMark !== current.restoreMark) return { gone: 'restored' }
      if (revision > current.revision) return { gone: 'ahead' }
      if (revision === current.revision) return { deltas: [] }
      if (entries.length === 0 || entries.at(-1).to !== current.revision) return { gone: 'restart' }
      const start = entries.findIndex((entry) => entry.from === revision)
      if (start < 0) return { gone: revision < entries[0].from ? 'too-old' : 'restart' }
      return { deltas: entries.slice(start) }
    },
  }
}
