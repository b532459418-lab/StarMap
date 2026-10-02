import { Building2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { googleConfigured } from './googleImagery'
import './city3d.css'

type City3DToggleProps = {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function City3DToggle({ enabled, onChange }: City3DToggleProps) {
  const { t } = useTranslation('appShell')
  if (!googleConfigured) return null

  return (
    <button
      type="button"
      className="atlas-dock-button atlas-city-3d-toggle pointer-events-auto"
      aria-pressed={enabled}
      aria-label={t(enabled ? 'disableCity3D' : 'enableCity3D')}
      title={t(enabled ? 'disableGoogleCity3D' : 'enableGoogleCity3D')}
      onClick={() => onChange(!enabled)}
    >
      <Building2 aria-hidden="true" />
    </button>
  )
}
