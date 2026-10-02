import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Viewer } from '@photo-sphere-viewer/core'
import '@photo-sphere-viewer/core/index.css'
import type { DroneMediaItem } from '../data/droneMedia'
import { useUiLocale } from '../i18n/useUiLocale'
import { DEFAULT_UI_LOCALE } from '../data/uiLocale'
import { panoramaCaption, panoramaLanguageKeys } from '../i18n/mediaViewerOptions.ts'

type DronePanoramaModalProps = {
  item?: DroneMediaItem
  onClose: () => void
}

type PanoramaLoadState = 'loading' | 'ready' | 'missing'

type PanoramaLoadResult = {
  itemId?: string
  state: PanoramaLoadState
  src?: string
}

export function DronePanoramaModal({ item, onClose }: DronePanoramaModalProps) {
  const { t } = useTranslation('mediaViewer')
  const { locale } = useUiLocale()
  const title = item ? (locale === DEFAULT_UI_LOCALE ? item.titleZh || item.titleEn : item.titleEn || item.titleZh) : ''
  const viewerOptions = useMemo(() => ({
    caption: panoramaCaption(title),
    lang: Object.fromEntries(panoramaLanguageKeys.map((key) => [key, t(key)])),
  }), [t, title])
  const viewerOptionsRef = useRef(viewerOptions)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const [loadResult, setLoadResult] = useState<PanoramaLoadResult>({ state: 'loading' })

  useEffect(() => {
    viewerOptionsRef.current = viewerOptions
    viewerRef.current?.setOptions(viewerOptions)
  }, [viewerOptions])

  useEffect(() => {
    if (!item) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (viewerRef.current?.isFullscreenEnabled()) return
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [item, onClose])

  useEffect(() => {
    if (!item) return

    let cancelled = false
    viewerRef.current?.destroy()
    viewerRef.current = null

    const image = new Image()
    let retryTimer: number | undefined
    let attempt = 0

    const loadPanorama = () => {
      const source = item.type === 'aerialPhoto' ? item.previewSrc : item.src
      const separator = source.includes('?') ? '&' : '?'
      image.src = `${source}${separator}starmapLoad=${Date.now()}-${attempt}`
    }

    image.onload = () => {
      if (cancelled || !containerRef.current) return

      if (item.type === 'aerialPhoto') {
        setLoadResult({ itemId: item.id, state: 'ready', src: image.src })
        return
      }

      viewerRef.current = new Viewer({
        container: containerRef.current,
        panorama: image.src,
        ...viewerOptionsRef.current,
        defaultZoomLvl: 35,
        keyboard: 'always',
        mousewheel: true,
        navbar: ['zoom', 'move', 'fullscreen'],
      })
      setLoadResult({ itemId: item.id, state: 'ready' })
    }

    image.onerror = () => {
      if (cancelled) return
      attempt += 1
      if (attempt < 5) {
        retryTimer = window.setTimeout(loadPanorama, 450)
        return
      }
      setLoadResult({ itemId: item.id, state: 'missing' })
    }

    loadPanorama()

    return () => {
      cancelled = true
      image.onload = null
      image.onerror = null
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      viewerRef.current?.destroy()
      viewerRef.current = null
    }
  }, [item])

  if (!item) return null

  const loadState = loadResult.itemId === item.id ? loadResult.state : 'loading'

  return (
    <div
      aria-modal="true"
      aria-labelledby="drone-panorama-title"
      className="drone-panorama-modal fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 text-white backdrop-blur-sm sm:p-6"
      role="dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="drone-panorama-dialog relative z-10 flex flex-col overflow-hidden rounded-[14px] border border-white/12 bg-[#080d14] shadow-[0_30px_100px_rgba(0,0,0,0.58)]">
        <div className="drone-panorama-header flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-300">
              {t(item.type === 'panorama360' ? 'dronePanorama' : 'droneAerialPhoto')}
            </p>
            <h2 id="drone-panorama-title" className="mt-1 truncate text-xl font-semibold tracking-normal">
              {title}
            </h2>
            <p className="drone-panorama-meta mt-1 text-sm">
              {item.fileName} · {item.resolution}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('closeDroneMedia')}
            onClick={onClose}
            className="grid size-11 shrink-0 place-items-center rounded-full border border-white/10 bg-white/10 text-white transition hover:bg-white/18"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} className="drone-panorama-viewer absolute inset-0">
            {item.type === 'aerialPhoto' && loadResult.itemId === item.id && loadResult.src ? (
              <img className="drone-aerial-preview" src={loadResult.src} alt={title} />
            ) : null}
            {item.type === 'panorama360' ? (
              <button
                type="button"
                className="panorama-fullscreen-back"
                aria-label={t('exitFullscreen')}
                onClick={() => viewerRef.current?.exitFullscreen()}
              >
                <ArrowLeft aria-hidden="true" strokeWidth={1.8} />
              </button>
            ) : null}
          </div>

          {loadState !== 'ready' ? (
            <div className="absolute inset-0 grid place-items-center bg-slate-950">
              <div className="max-w-md px-6 text-center">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-300">
                  {loadState === 'loading'
                    ? t(item.type === 'panorama360' ? 'loadingPanorama' : 'loadingAerialPhoto')
                    : t(item.type === 'panorama360' ? 'missingPanorama' : 'missingAerialPhoto')}
                </p>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                  {loadState === 'loading'
                    ? t(item.type === 'panorama360' ? 'loadingPanoramaDescription' : 'loadingAerialDescription')
                    : t('retryDescription')}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
