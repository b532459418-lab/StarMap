import { Signpost } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import './labels.css'

type LabelsToggleProps = {
  available: boolean
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function LabelsToggle({ available, enabled, onChange }: LabelsToggleProps) {
  const { t } = useTranslation('appShell')
  if (!available) return null

  return (
    <button
      type="button"
      className="atlas-dock-button atlas-map-labels-toggle pointer-events-auto"
      aria-pressed={enabled}
      aria-label={t(enabled ? 'hideLabels' : 'showLabels')}
      title={t(enabled ? 'hideLabels' : 'showLabels')}
      onClick={() => onChange(!enabled)}
    >
      <Signpost aria-hidden="true" />
    </button>
  )
}
