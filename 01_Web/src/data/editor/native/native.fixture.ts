/// <reference types="node" />
/** Test helpers for the store-native writes (3C-5 C1, C2): run one native write on a store, commit commands as they are,
 * and a user's own layers that refer to a place (the cross-layer acceptance, external review D3).
 * Only invented values. Not imported by the App. */
import type { FormalCommand, FormalState } from '../../../worldgraph/store/formal.ts'
import { applyChangeSet, planCommands } from '../../../worldgraph/store/planner.ts'
import { memoryReader } from '../../../worldgraph/store/reader.ts'
import { OFFICIAL, OFFICIAL_POLICY } from '../../store/officialDefinitions.ts'
import { projectStoreToCanonical } from '../../store/projectCanonical.ts'
import { editorRoute, nativeEngineOf, sameRequest, stepContext, type DoubleRunStore, type EngineOutcome } from '../doubleRun.fixture.ts'
import { NATIVE_WRITES } from './routes.ts'

const NOW = '2026-09-27T09:00:00.000Z'
const user = (id: string) => ({ sourceId: OFFICIAL.user, recordId: id, evidenceIds: [] })

/** The official view of a state. */
export const canonicalOf = (state: FormalState) => projectStoreToCanonical(state, { source: 'local', track: false, freeze: false }).canonical

/** Run the native write of `route` (`records`, `wanttogo/delete`, …) on the store as step `n`; the store moves on. */
export function runNative(store: DoubleRunStore, route: string, input: unknown, n: number): EngineOutcome {
  const outcome = nativeEngineOf(NATIVE_WRITES[editorRoute(route)])(store, sameRequest(route, editorRoute(route), input), stepContext(n))
  if (outcome.state) store.state = outcome.state
  return outcome
}

/** Commit commands as they are (a user's own layer, which the V2 files cannot hold). */
export function commitAsIs(store: DoubleRunStore, commands: readonly FormalCommand[]): void {
  const changeSet = planCommands(memoryReader(store.state), commands, { baseRevision: store.state.revision, now: NOW, policy: OFFICIAL_POLICY })
  store.state = applyChangeSet(store.state, changeSet)
}

/** A custom layer whose entity type refers to a place through a field (`near`), and one landmark near `placeId`. */
const LANDMARK_TYPE = '01990000-0000-7000-8000-00000000a001', LANDMARK_LAYER = '01990000-0000-7000-8000-00000000a002'
export const landmarkNear = (placeId: string): FormalCommand[] => [
  { op: 'create', table: 'entityTypes', value: { id: LANDMARK_TYPE, revision: 0, title: { names: { en: 'Synthetic landmark' } }, schemaVersion: 1, fields: [{ key: 'near', kind: 'entity_ref' }] } },
  { op: 'create', table: 'layers', value: { id: LANDMARK_LAYER, revision: 0, title: { names: { en: 'Synthetic landmarks' } }, schemaVersion: 1, acceptedEntityTypes: [LANDMARK_TYPE], entryFields: [] } },
  { op: 'create', table: 'entities', value: { id: '01990000-0000-7000-8000-00000000a003', revision: 0, typeId: LANDMARK_TYPE, title: { names: { en: 'Synthetic tower' } }, fields: { near: placeId }, source: user('01990000-0000-7000-8000-00000000a003'), visibility: 'private' } },
  { op: 'create', table: 'entries', value: { id: '01990000-0000-7000-8000-00000000a004', revision: 0, layerId: LANDMARK_LAYER, entityId: '01990000-0000-7000-8000-00000000a003', fields: {}, source: user('01990000-0000-7000-8000-00000000a004'), createdAt: NOW, updatedAt: NOW } },
]

/** A custom layer that holds places, with an entry on `placeId`. */
const PLACE_LAYER = '01990000-0000-7000-8000-00000000b001'
export const customEntryOn = (placeId: string): FormalCommand[] => [
  { op: 'create', table: 'layers', value: { id: PLACE_LAYER, revision: 0, title: { names: { en: 'Synthetic places' } }, schemaVersion: 1, acceptedEntityTypes: [OFFICIAL.place], entryFields: [] } },
  { op: 'create', table: 'entries', value: { id: '01990000-0000-7000-8000-00000000b002', revision: 0, layerId: PLACE_LAYER, entityId: placeId, fields: {}, source: user('01990000-0000-7000-8000-00000000b002'), createdAt: NOW, updatedAt: NOW } },
]
