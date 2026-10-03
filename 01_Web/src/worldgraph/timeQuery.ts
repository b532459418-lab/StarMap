/** Pure query inputs: original date evidence and adjacency, supplied by the app. */
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from './layers.ts'
import { recordRefKey, type RecordRef } from './recordIdentity.ts'
import { matchDateEvidence, type DateEvidence, type DateMatchResult, type TimeFilter } from './timeFilter.ts'
import type { LayerId } from './types.ts'
import type { Route } from '../types/travel.ts'

export interface TimeQueryRecord extends RecordRef {
  readonly placeId: string
  readonly countryId?: string
  readonly journeyId?: string
  readonly date: DateEvidence
  readonly browsable: boolean
  readonly navigationHidden?: boolean
}

export interface OriginalRouteCandidate {
  readonly id: string
  readonly journeyId: string
  readonly fromRecordId: string
  readonly toRecordId: string
  readonly fromPlaceId: string
  readonly toPlaceId: string
  readonly kind: Route['type']
}

export interface TimeQueryContext {
  readonly records: readonly TimeQueryRecord[]
  readonly originalRoutes: readonly OriginalRouteCandidate[]
}

export type LayerTimeFilters = Readonly<Partial<Record<LayerId, TimeFilter>>>
export interface MatchedTimeRecord {
  readonly record: TimeQueryRecord
  readonly result: DateMatchResult
}

export const timeRecordLayer = (record: RecordRef): LayerId =>
  record.sourceKind === 'travel' || record.sourceKind === 'country-visit' ? TRAVEL_LAYER_ID : WANT_TO_GO_LAYER_ID

/** Hidden records are not browse candidates or uncertain-date notifications. */
export const evaluateTimeQueryRecords = (
  context: TimeQueryContext, filters: LayerTimeFilters,
): MatchedTimeRecord[] => {
  const seen = new Set<string>()
  const results: MatchedTimeRecord[] = []
  for (const record of context.records) {
    const key = recordRefKey(record)
    if (seen.has(key)) continue
    seen.add(key)
    if (!record.browsable) continue
    const filter = filters[timeRecordLayer(record)] ?? { includeUncertain: false }
    results.push({ record, result: matchDateEvidence(record.date, filter) })
  }
  return results
}
