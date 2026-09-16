import { Signpost } from 'lucide-react'
import './labels.css'

type LabelsToggleProps = {
  available: boolean
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function LabelsToggle({ available, enabled, onChange }: LabelsToggleProps) {
  if (!available) return null

  return (
    <button
      type="button"
      className="atlas-dock-button atlas-map-labels-toggle pointer-events-auto"
      aria-pressed={enabled}
      aria-label={enabled ? '隐藏地名/路网' : '显示地名/路网'}
      title={enabled ? '隐藏地名/路网' : '显示地名/路网'}
      onClick={() => onChange(!enabled)}
    >
      <Signpost aria-hidden="true" />
    </button>
  )
}
