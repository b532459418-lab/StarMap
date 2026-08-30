import {
  Google2DImageryProvider,
  GoogleMaps,
  TileMapServiceImageryProvider,
  buildModuleUrl,
} from 'cesium'
import type { ImageryProvider } from 'cesium'

const googleMapsTilesKey = (import.meta.env.VITE_GOOGLE_MAPS_TILES_KEY ?? '').trim()

export const googleConfigured = Boolean(googleMapsTilesKey)

if (googleMapsTilesKey) {
  GoogleMaps.defaultApiKey = googleMapsTilesKey
}

// Google's session endpoint expects hyphenated IETF tags, unlike Cesium's en_US default.
const googleLanguage = 'zh-CN'
const googleRegion = 'CN'

const createLocalImagery = () => TileMapServiceImageryProvider.fromUrl(
  buildModuleUrl('Assets/Textures/NaturalEarthII'),
)

const describeFailure = (layer: string) => (
  `[starmap] Google ${layer} unavailable. Verify that VITE_GOOGLE_MAPS_TILES_KEY is valid, `
  + 'that billing is enabled, and that the Map Tiles API allows this origin.'
)

/**
 * Cesium's own providers type getTileCredits as returning `Credit[] | undefined`, which does not
 * satisfy the `ImageryProvider` interface they are handed to. The assertions below bridge that gap
 * and must stay until the upstream types are fixed.
 */
export const createGoogleImagery = (onFailure?: () => void): Promise<ImageryProvider> => {
  if (!googleMapsTilesKey) {
    return createLocalImagery()
  }

  return Google2DImageryProvider.fromUrl({
    key: googleMapsTilesKey,
    mapType: 'satellite',
    language: googleLanguage,
    region: googleRegion,
  }).catch((error: unknown) => {
    console.warn(`${describeFailure('satellite imagery')} Falling back to local low-resolution imagery.`, error)
    onFailure?.()
    return createLocalImagery()
  }) as Promise<ImageryProvider>
}

/**
 * Roads and Chinese place names, drawn on top of the satellite base. Resolving to `undefined` makes
 * Resium skip the layer entirely, which is what we want on failure: a local-imagery fallback would
 * paint an opaque world texture over the satellite base instead of labelling it.
 */
export const createGoogleRoadmapOverlay = (
  onFailure?: () => void,
): Promise<ImageryProvider> | undefined => {
  if (!googleMapsTilesKey) {
    return undefined
  }

  return Google2DImageryProvider.fromUrl({
    key: googleMapsTilesKey,
    overlayLayerType: 'layerRoadmap',
    language: googleLanguage,
    region: googleRegion,
  }).catch((error: unknown) => {
    console.warn(`${describeFailure('roadmap overlay')} Showing satellite imagery without labels.`, error)
    onFailure?.()
    return undefined
  }) as Promise<ImageryProvider>
}
