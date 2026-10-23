/// <reference types="node" />
/** Test helpers for the incremental write path (3C-4a): a migrated store, its V2 view, and one V2 write applied the way
 * the new-library mode applies it (V2 function on the view -> diffV2ToCommands -> planCommands -> applyChangeSet).
 * Only tracked neutral fixtures and invented values. Not imported by the App. */
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import type { V2Write, V2WriteContext, V2WriteOutcome } from '../v2write/transaction.ts'
import { OFFICIAL_POLICY } from './officialDefinitions.ts'
import { diffV2ToCommands, memoryDiffReader, type StoreDiff } from './diffV2.ts'
import { storeFrom, viewOf, type StoreUnderTest } from './v2Store.fixture.ts'

export { storeFrom, viewOf, type StoreUnderTest }

/** The five files after `writes`, sharing every file that was not written (as the session builds them). */
export const filesAfter = (files: V2Files, writes: readonly V2Write[]): V2Files =>
  ({ ...files, ...Object.fromEntries(writes.map(write => [write.file, write.value])) } as Record<V2FileKey, unknown>) as unknown as V2Files

/** Plan and apply the diff between `before` and `after` on the store; returns the diff. */
export function commitDiff(store: StoreUnderTest, before: V2Files, after: V2Files, now: string): StoreDiff {
  const identities = new Map(store.manifest.identities.map(row => [JSON.stringify([row.kind, row.sourceId, row.recordId]), row.id]))
  const diff = diffV2ToCommands(before, after, {
    reader: memoryDiffReader(store.state),
    identity: (kind, sourceId, recordId) => identities.get(JSON.stringify([kind, sourceId, recordId])),
    now,
    allocateId: store.allocateId,
  })
  const changeSet = planCommands(memoryReader(store.state), diff.commands, { baseRevision: store.state.revision, now, policy: OFFICIAL_POLICY })
  store.state = applyChangeSet(store.state, changeSet)
  return diff
}

/** Run one V2 write on the store's view and commit it; the view becomes the files after the write. */
export function writeThroughStore<R>(store: StoreUnderTest, run: (files: V2Files, ctx: V2WriteContext) => V2WriteOutcome<R>, ctx: V2WriteContext): {
  readonly outcome: V2WriteOutcome<R>; readonly before: V2Files; readonly after: V2Files; readonly diff: StoreDiff
} {
  const before = store.view
  const outcome = run(before, ctx)
  const after = filesAfter(before, outcome.writes)
  const diff = commitDiff(store, before, after, ctx.now.toISOString())
  store.view = after
  return { outcome, before, after, diff }
}
