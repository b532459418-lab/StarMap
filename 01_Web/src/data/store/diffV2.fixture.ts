/// <reference types="node" />
/** Test helpers for the incremental write path (3C-4a): a migrated store, its V2 view, and one V2 write applied the way
 * the new-library mode applies it (V2 function on the view -> diffV2ToCommands -> planCommands -> applyChangeSet).
 * Only tracked neutral fixtures and invented values. Not imported by the App. */
import type { FormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import type { BridgeManifest } from '../canonical/storeBridgeIdentity.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import type { V2Write, V2WriteContext, V2WriteOutcome } from '../v2write/transaction.ts'
import { OFFICIAL_POLICY } from './officialDefinitions.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { diffV2ToCommands, memoryDiffReader, type StoreDiff } from './diffV2.ts'
import { migrateIntoEmptyStore } from './v2Store.fixture.ts'

export interface StoreUnderTest {
  state: FormalState
  /** The V2 view the App reads: serializeV2 of the projection (the cache after the first read). */
  view: V2Files
  readonly manifest: BridgeManifest
  /** Fresh ids of the diff (store rows), apart from the V2 write's ids. */
  readonly allocateId: () => string
}

/** The V2 view of a store: what the plugin's virtual module serves. */
export function viewOf(state: FormalState): V2Files {
  const { canonical, v2Meta } = projectStoreToCanonical(state, { source: 'local' })
  return serializeV2(canonical, v2Meta)
}

/** Migrate `files` into an empty store and read its view. */
export function storeFrom(files: V2Files, allocatorYear = 2031): StoreUnderTest {
  const { state, result } = migrateIntoEmptyStore(files)
  return { state, view: viewOf(state), manifest: result.manifest, allocateId: sequentialUuids(Date.UTC(allocatorYear, 0, 1)) }
}

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
