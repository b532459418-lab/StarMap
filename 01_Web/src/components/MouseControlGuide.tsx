import { useTranslation } from 'react-i18next'

type GestureAction = 'drag' | 'scroll' | 'tilt'

const controls: Array<{ action: GestureAction; key: string; label: string }> = [
  { action: 'drag', key: 'dragGesture', label: 'orbit' },
  { action: 'scroll', key: 'scrollGesture', label: 'zoom' },
  { action: 'tilt', key: 'tiltGesture', label: 'tilt' },
]

function GestureIcon({ action }: { action: GestureAction }) {
  return (
    <svg
      aria-hidden="true"
      className="atlas-mouse-control-icon"
      viewBox="0 0 28 36"
    >
      <rect
        className="atlas-mouse-control-shell"
        x="4.2"
        y="3.2"
        width="19.6"
        height="29.6"
        rx="4.8"
      />
      {action === 'drag' ? (
        <>
          <circle className="atlas-mouse-control-active" cx="14" cy="16.2" r="2.3" />
          <path className="atlas-mouse-control-motion" d="M8.2 16.2H6.1m15.8 0h-2.1M14 10.4V8.3m0 15.8v-2.1" />
        </>
      ) : null}
      {action === 'scroll' ? (
        <>
          <circle className="atlas-mouse-control-active" cx="11.1" cy="17" r="2.05" />
          <circle className="atlas-mouse-control-active" cx="16.9" cy="17" r="2.05" />
          <path className="atlas-mouse-control-motion" d="m14 8.2-2 2.4h4Zm0 19.6 2-2.4h-4Z" />
        </>
      ) : null}
      {action === 'tilt' ? (
        <>
          <rect
            className="atlas-mouse-control-modifier"
            x="6.6"
            y="9.4"
            width="14.8"
            height="8"
            rx="1.7"
          />
          <text className="atlas-mouse-control-modifier-label" x="14" y="15.1" textAnchor="middle">
            Ctrl
          </text>
          <path className="atlas-mouse-control-motion" d="M8.8 25.2h10.4m-2-2 2 2-2 2" />
        </>
      ) : null}
    </svg>
  )
}

export function MouseControlGuide() {
  const { t } = useTranslation('auxiliary')

  return (
    <footer
      aria-label={t('mapControls')}
      className="atlas-mouse-guide"
    >
      <div className="atlas-mouse-guide-heading" aria-hidden="true">
        <span>{t('trackpadControls')}</span>
        <span className="atlas-mouse-guide-line" />
      </div>
      <div className="atlas-mouse-guide-grid">
        {controls.map((control) => (
          <div className="atlas-mouse-guide-item" key={control.action}>
            <GestureIcon action={control.action} />
            <span className="atlas-mouse-guide-copy">
              <span>{t(control.key)}</span>
              <strong>{t(control.label)}</strong>
            </span>
          </div>
        ))}
      </div>
    </footer>
  )
}
