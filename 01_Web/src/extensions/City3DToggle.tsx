import { Building2 } from 'lucide-react'
import { googleConfigured } from './googleImagery'
import './city3d.css'

type City3DToggleProps = {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function City3DToggle({ enabled, onChange }: City3DToggleProps) {
  if (!googleConfigured) return null

  return (
    <button
      type="button"
      className="atlas-dock-button atlas-city-3d-toggle pointer-events-auto"
      aria-pressed={enabled}
      aria-label={enabled ? '关闭城市 3D' : '开启城市 3D'}
      title={enabled ? '关闭 Google 城市 3D' : '开启 Google 城市 3D'}
      onClick={() => onChange(!enabled)}
    >
      <Building2 aria-hidden="true" />
    </button>
  )
}
