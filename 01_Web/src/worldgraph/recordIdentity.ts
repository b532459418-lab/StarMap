/** Record IDs are opaque and only unique within their adapter's source. */
import { PLANNED_SOURCE } from './adapters/plannedRecords.ts'
import { WANT_TO_GO_SOURCE } from './adapters/wantToGo.ts'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from './layers.ts'
import type { LayerId, LayerMembership } from './types.ts'

export type RecordSourceKind = 'travel' | 'want-to-go' | 'planned' | 'country-visit'
export interface RecordRef {
  readonly sourceKind: RecordSourceKind
  readonly recordId: string
}

export const recordRefKey = (ref: RecordRef): string => JSON.stringify([ref.sourceKind, ref.recordId])

/** Only fixed adapter metadata defines provenance; arbitrary user source text does not. */
export const recordSourceKindOf = (layerId: LayerId, source: unknown): RecordSourceKind | undefined => {
  if (layerId === TRAVEL_LAYER_ID) return 'travel'
  if (layerId !== WANT_TO_GO_LAYER_ID) return undefined
  if (source === WANT_TO_GO_SOURCE) return 'want-to-go'
  if (source === PLANNED_SOURCE) return 'planned'
  return undefined
}

export const membershipRecordRef = (membership: LayerMembership): RecordRef | undefined => {
  const sourceKind = recordSourceKindOf(membership.layerId, membership.metadata?.source)
  return sourceKind !== undefined && membership.recordId !== undefined
    ? { sourceKind, recordId: membership.recordId } : undefined
}

/** Unknown/record-less memberships keep their existing first-wins identity. */
export const membershipIdentityKey = (membership: LayerMembership): string => JSON.stringify([
  membership.entityId, membership.layerId,
  recordSourceKindOf(membership.layerId, membership.metadata?.source) ?? '', membership.recordId ?? '',
])
