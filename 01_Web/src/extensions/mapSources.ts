import type { ImageryProvider } from 'cesium'
import {
  createMapSourceLayers as createOfficialMapSourceLayers,
  getInitialMapSource as getOfficialInitialMapSource,
  mapSourceOptions as officialMapSourceOptions,
} from '../data/mapSources'
import type { MapSourceId as OfficialMapSourceId } from '../data/mapSources'
import { createGoogleImagery, createGoogleRoadmapOverlay, googleConfigured } from './googleImagery'

type OfficialMapSourceLayers = ReturnType<typeof createOfficialMapSourceLayers>

// Google's label overlay can only be built asynchronously, so the official synchronous
// `labels` type is widened here. Resium's ImageryLayer already accepts a promise.
export type MapSourceLayers = Omit<OfficialMapSourceLayers, 'labels'> & {
  labels?: ImageryProvider | Promise<ImageryProvider>
}

export type ExtendedMapSourceId = OfficialMapSourceId | 'google'
export type MapSourceId = ExtendedMapSourceId

export type MapSourceOption = {
  id: MapSourceId
  label: string
  description: string
  configured: boolean
}

const mapSourceStorageKey = 'starmap:map-source'
const configuredDefault = (import.meta.env.VITE_MAP_SOURCE ?? 'auto').trim().toLowerCase()

const googleOption: MapSourceOption = {
  id: 'google',
  label: '谷歌',
  description: 'Google 卫星影像与中文注记',
  configured: googleConfigured,
}

export const mapSourceOptions: MapSourceOption[] = [
  ...officialMapSourceOptions.filter((option) => option.id !== 'local'),
  googleOption,
  ...officialMapSourceOptions.filter((option) => option.id === 'local'),
]

const configuredMapSourceIds = new Set<MapSourceId>(
  mapSourceOptions.filter((option) => option.configured).map((option) => option.id),
)

const isConfiguredMapSource = (value: string | null): value is MapSourceId => (
  value !== null && configuredMapSourceIds.has(value as MapSourceId)
)

export const getInitialMapSource = (): MapSourceId => {
  if (typeof window !== 'undefined') {
    try {
      const storedSource = window.localStorage.getItem(mapSourceStorageKey)
      if (isConfiguredMapSource(storedSource)) return storedSource
    } catch {
      // Storage can be unavailable in privacy-focused browser modes.
    }
  }

  if (configuredDefault === 'google' && googleConfigured) {
    return 'google'
  }

  return getOfficialInitialMapSource()
}

export const rememberMapSource = (source: MapSourceId) => {
  if (!isConfiguredMapSource(source) || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(mapSourceStorageKey, source)
  } catch {
    // The selected source still works for this session when storage is blocked.
  }
}

/**
 * Providers are reused across switches so that returning to a source does not open a second Google
 * session. Cesium's ImageryLayer.destroy() leaves the provider intact, so a cached provider stays
 * usable after Resium removes its layer. Failed creations evict themselves to allow a later retry.
 */
const layerCache = new Map<MapSourceId, MapSourceLayers>()

export const createMapSourceLayers = (source: MapSourceId): MapSourceLayers => {
  const cachedLayers = layerCache.get(source)
  if (cachedLayers) return cachedLayers

  const forget = () => {
    layerCache.delete(source)
  }

  const layers: MapSourceLayers = source === 'google'
    ? { base: createGoogleImagery(forget), labels: createGoogleRoadmapOverlay(forget) }
    : createOfficialMapSourceLayers(source)

  layerCache.set(source, layers)
  return layers
}
