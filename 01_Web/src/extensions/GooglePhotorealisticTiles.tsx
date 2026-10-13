import { GooglePhotorealistic3DTileset } from 'resium'
import { googleConfigured } from './googleImagery'
import { city3DTilesPresence } from './city3dPreference'

type GooglePhotorealisticTilesProps = {
  /** City 3D is on. */
  enabled: boolean
  /** The Map page is showing. Other pages only hide the tiles; see city3DTilesPresence. */
  visible: boolean
  /** The tileset could not be created (invalid key, billing, origin not allowed): the caller turns City 3D off. */
  onUnavailable?: () => void
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
 *
 * `show` is one of resium's mutable props for this tileset: it is passed to the tileset on creation, and a change only
 * assigns `tileset.show`, so switching pages hides the existing tileset instead of creating a new one.
 */
const CACHE_BYTES = 1536 * 1024 * 1024
const MAXIMUM_CACHE_OVERFLOW_BYTES = 1024 * 1024 * 1024

export function GooglePhotorealisticTiles({ enabled, visible, onUnavailable }: GooglePhotorealisticTilesProps) {
  const { mounted, show } = city3DTilesPresence(enabled, googleConfigured, visible)
  if (!mounted) return null

  return (
    <GooglePhotorealistic3DTileset
      show={show}
      showCreditsOnScreen
      onlyUsingWithGoogleGeocoder
      cacheBytes={CACHE_BYTES}
      maximumCacheOverflowBytes={MAXIMUM_CACHE_OVERFLOW_BYTES}
      enableCollision
      onError={() => {
        console.warn('[starmap] Google Photorealistic 3D Tiles failed to load.')
        // The globe is hidden while City 3D is on; without tiles it must come back.
        onUnavailable?.()
      }}
    />
  )
}
