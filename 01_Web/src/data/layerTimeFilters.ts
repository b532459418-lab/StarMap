import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers.ts'
import { normalizeTimeFilter } from '../worldgraph/timeFilter.ts'
import type { LayerTimeFilters } from '../worldgraph/timeQuery.ts'

export const LAYER_TIME_FILTERS_STORAGE_KEY = 'starmap.layerTimeFilters.v1'
export type TimeFilterStorage = Pick<Storage, 'getItem' | 'setItem'>
const layerIds = [TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID] as const
const defaults = (): LayerTimeFilters => ({
  [TRAVEL_LAYER_ID]: { includeUncertain: false },
  [WANT_TO_GO_LAYER_ID]: { includeUncertain: false },
})
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Browser access stays outside Core; the optional store makes failures testable. */
export function readLayerTimeFilters(storage?: TimeFilterStorage | null): { filters: LayerTimeFilters; warning: boolean; restored: boolean } {
  const filters = { ...defaults() }
  try {
    const store = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
    if (!store) return { filters, restored: false, warning: typeof window !== 'undefined' || storage === null }
    const text = store.getItem(LAYER_TIME_FILTERS_STORAGE_KEY)
    if (text === null) return { filters, restored: false, warning: false }
    const saved: unknown = JSON.parse(text)
    if (!isObject(saved) || saved.version !== 1 || !isObject(saved.filters)) return { filters, restored: false, warning: true }
    let warning = false
    let restored = false
    for (const layerId of layerIds) {
      if (!Object.hasOwn(saved.filters, layerId)) continue
      const normalized = normalizeTimeFilter(saved.filters[layerId])
      if (normalized.ok) {
        filters[layerId] = normalized.filter
        restored ||= normalized.filter.from !== undefined || normalized.filter.to !== undefined || normalized.filter.includeUncertain
      }
      else warning = true
    }
    return { filters, warning, restored }
  } catch {
    return { filters, restored: false, warning: true }
  }
}

/** Saves effective preferences only, with neither raw drafts nor record data. */
export function rememberLayerTimeFilters(filters: LayerTimeFilters, storage?: TimeFilterStorage | null): boolean {
  try {
    const store = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
    if (!store || !isObject(filters)) return false
    const clean = { ...defaults() }
    for (const layerId of layerIds) {
      const normalized = normalizeTimeFilter(filters[layerId] === undefined ? { includeUncertain: false } : filters[layerId])
      if (!normalized.ok) return false
      clean[layerId] = normalized.filter
    }
    store.setItem(LAYER_TIME_FILTERS_STORAGE_KEY, JSON.stringify({ version: 1, filters: clean }))
    return true
  } catch {
    return false
  }
}
