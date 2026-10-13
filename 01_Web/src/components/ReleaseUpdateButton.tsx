import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReleaseUpdateState } from '../data/releaseUpdates'

type ReleaseUpdateButtonProps = {
  active: boolean
  state: ReleaseUpdateState
  onToggle: () => void
}

/**
 * The updates button in the map dock. It is always on screen, while the updates page (./UpdateChecker.tsx) is loaded
 * only when it is first opened, so the button lives in its own module (batch 5B).
 */
export function ReleaseUpdateButton({ active, state, onToggle }: ReleaseUpdateButtonProps) {
  const { t } = useTranslation('appShell')
  return (
    <button
      type="button"
      className="atlas-dock-button atlas-release-button pointer-events-auto"
      aria-label={t(active ? 'returnPrevious' : 'updates')}
      aria-current={active ? 'page' : undefined}
      title={t(active ? 'returnPrevious' : state.hasUnseenUpdate ? 'unseenUpdate' : 'updates')}
      data-update-available={state.hasUnseenUpdate ? 'true' : 'false'}
      onClick={onToggle}
    >
      <RefreshCw aria-hidden="true" className={state.status === 'checking' ? 'is-spinning' : ''} />
      {state.hasUnseenUpdate ? <span className="atlas-release-signal" aria-hidden="true" /> : null}
    </button>
  )
}
