import { GooglePhotorealistic3DTileset } from 'resium'
import { googleConfigured } from './googleImagery'

type GooglePhotorealisticTilesProps = {
  show: boolean
}

/**
 * Cesium's `createGooglePhotorealistic3DTileset` mutates the tileset options object it is handed --
 * it writes `cacheBytes`, `maximumCacheOverflowBytes` and `enableCollision` back into it. resium
 * passes its own props object as those options, so after the tileset is created resium's
 * previous-props snapshot holds keys that our JSX never supplied. On the next prop update the
 * diff sees `number -> undefined` and assigns it: `cacheBytes` and `maximumCacheOverflowBytes`
 * throw a DeveloperError (their setters reject non-numbers), and `enableCollision` is silently
 * cleared, disabling camera collision against the tiles. Passing the values explicitly keeps them
 * in our props, so the diff stays a no-op. These are Cesium's own defaults for this tileset.
 */
const CACHE_BYTES = 1536 * 1024 * 1024
const MAXIMUM_CACHE_OVERFLOW_BYTES = 1024 * 1024 * 1024

export function GooglePhotorealisticTiles({ show }: GooglePhotorealisticTilesProps) {
  if (!googleConfigured || !show) return null

  return (
    <GooglePhotorealistic3DTileset
      showCreditsOnScreen
      onlyUsingWithGoogleGeocoder
      cacheBytes={CACHE_BYTES}
      maximumCacheOverflowBytes={MAXIMUM_CACHE_OVERFLOW_BYTES}
      enableCollision
      onError={() => {
        console.warn('[starmap] Google Photorealistic 3D Tiles failed to load.')
      }}
    />
  )
}
