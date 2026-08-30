import {
  createMapSourceLayers as createOfficialMapSourceLayers,
  getInitialMapSource as getOfficialInitialMapSource,
  mapSourceOptions as officialMapSourceOptions,
} from '../data/mapSources'
import type { MapSourceId as OfficialMapSourceId } from '../data/mapSources'
import { createGoogleImagery, googleConfigured } from './googleImagery'

type MapSourceLayers = ReturnType<typeof createOfficialMapSourceLayers>

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
  description: 'Google 全球卫星影像',
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

export const createMapSourceLayers = (source: MapSourceId): MapSourceLayers => {
  if (source === 'google') {
    return { base: createGoogleImagery() }
  }

  return createOfficialMapSourceLayers(source)
}
