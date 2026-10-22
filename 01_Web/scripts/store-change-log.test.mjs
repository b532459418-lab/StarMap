/**
 * The change log of the dev server (3C-5 D, design §3): one chain of entries, bounded by entries and rows, and the
 * reasons a page has to read the whole read model again (410).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeEntryOf, createChangeLog } from './store-change-log.mjs'

const LIBRARY = { libraryId: '01990000-0000-7000-8000-00000000c0de', restoreMark: null }
const entry = (from, to = from + 1, rows = 1, library = LIBRARY) => Object.freeze({
  ...library, from, to, upserts: Array.from({ length: rows }, (_, n) => ({ table: 'entries', row: { id: `e${from}-${n}`, revision: 0 } })), deletes: [],
})
const current = (revision, library = LIBRARY) => ({ current: { ...library, revision } })

test('changes since a revision: the entries from there, in order; none when current', () => {
  const log = createChangeLog()
  for (let from = 4; from < 8; from++) log.add(entry(from))
  assert.equal(log.lastRevision, 8)
  assert.deepEqual(log.since(8, current(8)), { deltas: [] })
  assert.deepEqual(log.since(6, current(8)).deltas.map((delta) => [delta.from, delta.to]), [[6, 7], [7, 8]])
  assert.deepEqual(log.since(4, { ...current(8), library: LIBRARY }).deltas.length, 4)
})

test('410 reasons: another library, a restore, ahead, older than the log, a log that does not reach the current revision', () => {
  const log = createChangeLog()
  for (let from = 4; from < 8; from++) log.add(entry(from))
  assert.deepEqual(log.since(6, { ...current(8), library: { libraryId: '01990000-0000-7000-8000-00000000beef' } }), { gone: 'library' })
  assert.deepEqual(log.since(6, { ...current(8), library: { ...LIBRARY, restoreMark: '2026-10-01T00:00:00.000Z' } }), { gone: 'restored' })
  // The library was restored after the page read it (the page's mark is none).
  assert.deepEqual(log.since(6, { current: { ...LIBRARY, restoreMark: '2026-10-01T00:00:00.000Z', revision: 8 }, library: LIBRARY }), { gone: 'restored' })
  assert.deepEqual(log.since(9, current(8)), { gone: 'ahead' })
  assert.deepEqual(log.since(3, current(8)), { gone: 'too-old' })
  // The library moved on without the log (a store read the log could not explain).
  assert.deepEqual(log.since(6, current(9)), { gone: 'restart' })
  // Nothing kept (a new dev server): only a current page needs nothing.
  const fresh = createChangeLog()
  assert.deepEqual(fresh.since(8, current(8)), { deltas: [] })
  assert.deepEqual(fresh.since(7, current(8)), { gone: 'restart' })
  log.clear()
  assert.deepEqual(log.since(7, current(8)), { gone: 'restart' })
})

test('an entry that does not continue the chain clears it; the log keeps at most its entries and rows, a large entry alone', () => {
  const log = createChangeLog({ maxEntries: 3, maxRows: 10 })
  for (let from = 1; from < 6; from++) log.add(entry(from))
  assert.equal(log.size, 3)
  assert.deepEqual(log.since(2, current(6)), { gone: 'too-old' })
  assert.equal(log.since(3, current(6)).deltas.length, 3)
  log.add(entry(6, 7, 9))
  assert.deepEqual(log.since(5, current(7)).deltas.map((delta) => delta.from), [5, 6])
  log.add(entry(7, 8, 20))
  assert.equal(log.size, 1, 'a single larger entry is kept alone')
  // A gap (another library, or a revision the chain does not reach): the chain starts again.
  log.add(entry(10))
  assert.equal(log.size, 1)
  assert.deepEqual(log.since(8, current(11)), { gone: 'too-old' })
  log.add(entry(11, 12, 1, { ...LIBRARY, restoreMark: '2026-10-01T00:00:00.000Z' }))
  assert.equal(log.size, 1)
})

test('a commit\'s change set as an entry: read-model tables only', () => {
  const changes = {
    baseRevision: 3, nextRevision: 4,
    upserts: [{ table: 'entries', row: { id: 'e', revision: 1 } }, { table: 'reviews', row: { id: 'r', revision: 0 } }],
    deletes: [{ table: 'viewItems', id: 'v' }, { table: 'reviews', id: 'r2' }],
  }
  assert.deepEqual(changeEntryOf(LIBRARY, changes), {
    ...LIBRARY, from: 3, to: 4, upserts: [{ table: 'entries', row: { id: 'e', revision: 1 } }], deletes: [{ table: 'viewItems', id: 'v' }],
  })
})
