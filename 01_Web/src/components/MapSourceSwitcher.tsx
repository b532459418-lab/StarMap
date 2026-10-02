import { useEffect, useRef, useState } from 'react'
import { Check, Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mapSourceOptions } from '../extensions/mapSources'
import type { MapSourceId } from '../extensions/mapSources'

type MapSourceSwitcherProps = {
  value: MapSourceId
  onChange: (source: MapSourceId) => void
}

export function MapSourceSwitcher({ value, onChange }: MapSourceSwitcherProps) {
  const { t } = useTranslation('mapMenu')
  const [open, setOpen] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const activeOption = mapSourceOptions.find((option) => option.id === value)
  const activeLabel = t(`source.${activeOption?.id ?? 'local'}.label`)

  return (
    <div ref={shellRef} className="atlas-map-source-switcher">
      {open ? (
        <div className="atlas-map-source-menu" role="menu" aria-label={t('selectSource')}>
          <p>{t('sources')}</p>
          {mapSourceOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === value}
              aria-disabled={!option.configured}
              data-active={option.id === value ? 'true' : 'false'}
              data-configured={option.configured ? 'true' : 'false'}
              disabled={!option.configured}
              title={t(option.id === 'local' ? 'bundledSource' : option.configured ? 'credentialsPresent' : 'missingCredentials')}
              onClick={() => {
                onChange(option.id)
                setOpen(false)
              }}
            >
              <span className="atlas-map-source-status" aria-hidden="true" />
              <span className="atlas-map-source-copy">
                <strong>{t(`source.${option.id}.label`)}</strong>
                <small>
                  {option.configured ? t(`source.${option.id}.description`) : t('missingCredentials')}
                </small>
              </span>
              {option.id === value ? <Check aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="atlas-dock-button atlas-map-source-button pointer-events-auto"
        aria-label={t('switchSource', { name: activeLabel })}
        aria-expanded={open}
        title={t('sourceTitle', { name: activeLabel })}
        onClick={() => setOpen((visible) => !visible)}
      >
        <Layers3 aria-hidden="true" />
      </button>
    </div>
  )
}
