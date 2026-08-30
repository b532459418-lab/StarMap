import { GooglePhotorealistic3DTileset } from 'resium'
import { googleConfigured } from './googleImagery'

type GooglePhotorealisticTilesProps = {
  show: boolean
}

export function GooglePhotorealisticTiles({ show }: GooglePhotorealisticTilesProps) {
  if (!googleConfigured || !show) return null

  return (
    <GooglePhotorealistic3DTileset
      showCreditsOnScreen
      onError={() => {
        console.warn('[starmap] Google Photorealistic 3D Tiles failed to load.')
      }}
    />
  )
}
