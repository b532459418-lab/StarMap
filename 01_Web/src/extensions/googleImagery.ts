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

const createLocalImagery = () => TileMapServiceImageryProvider.fromUrl(
  buildModuleUrl('Assets/Textures/NaturalEarthII'),
)

export const createGoogleImagery = (): Promise<ImageryProvider> => {
  if (!googleMapsTilesKey) {
    return createLocalImagery()
  }

  return Google2DImageryProvider.fromUrl({
    key: googleMapsTilesKey,
    mapType: 'satellite',
    language: 'zh_CN',
  }).catch(createLocalImagery) as Promise<ImageryProvider>
}
