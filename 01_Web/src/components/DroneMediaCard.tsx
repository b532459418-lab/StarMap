import { useTranslation } from 'react-i18next'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { editorErrorNotice } from '../i18n/editorErrors.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Drone, GripVertical, Maximize2, X } from 'lucide-react'
import { localEditorAvailable, travelAtlasEditorState } from '../data/editorState'
import { allImportedMediaItems } from '../data/mediaCatalog'
import { deleteHiddenLocalMedia, importLocalMedia, reloadAfterLocalSave, updateLocalEditorState, uploadLocalMedia } from '../data/localEditorApi'
import { readDroneFileMetadata } from '../data/droneMetadata'
import { cityById } from '../data/travelAtlas'
import { getMediaImportSession } from '../data/mediaImportSession'
import type { DroneMediaItem } from '../data/droneMedia'
import { getDroneMediaForCity } from '../data/droneMedia'
import type { CityId } from '../types/travel'
import { LocalEditorToolbar } from './LocalEditorToolbar'
import { MediaImportRecovery } from './MediaImportRecovery'
import { useMediaImportSession } from './useMediaImportSession'
import { useFlipLayout } from './useFlipLayout'

type DroneMediaCardProps = {
  cityId?: CityId
  activeItemId?: string
  onSelectItem: (item: DroneMediaItem) => void
  onOpenPanorama: (item: DroneMediaItem) => void
}

type DroneFileDraft = {
  id: string
  file: File
  status: 'reading' | 'ready'
  error?: string
  errorKeys?: string[]
  date: string
  lat: string
  lng: string
  altitudeMeters: string
  relativeAltitudeMeters: string
  camera?: string
  width?: number
  height?: number
  fromFile: {
    date: boolean
    lat: boolean
    lng: boolean
    altitudeMeters: boolean
    relativeAltitudeMeters: boolean
  }
}

const displayNumber = (value?: number) => value === undefined ? '' : String(Number(value.toFixed(7)))

const readImageDimensions = (file: File) => new Promise<{ width: number; height: number }>((resolve, reject) => {
  const source = URL.createObjectURL(file)
  const image = new Image()
  image.onload = () => {
    URL.revokeObjectURL(source)
    resolve({ width: image.naturalWidth, height: image.naturalHeight })
  }
  image.onerror = () => {
    URL.revokeObjectURL(source)
    reject(new Error('无法读取图片尺寸。'))
  }
  image.src = source
})

const isLikelyEquirectangularPanorama = (width?: number, height?: number) => {
  if (!width || !height) return false
  const ratio = width / height
  return ratio >= 1.9 && ratio <= 2.1
}

const pendingDraft = (file: File, index: number): DroneFileDraft => ({
  id: `${file.name}:${file.size}:${file.lastModified}:${index}`,
  file,
  status: 'reading',
  date: '',
  lat: '',
  lng: '',
  altitudeMeters: '',
  relativeAltitudeMeters: '',
  fromFile: {
    date: false,
    lat: false,
    lng: false,
    altitudeMeters: false,
    relativeAltitudeMeters: false,
  },
})

export function DroneMediaCard({ cityId, activeItemId, onSelectItem, onOpenPanorama }: DroneMediaCardProps) {
  const { t } = useTranslation('droneEditor')
  const { name } = usePlaceNames()
  const city = cityId ? cityById[cityId] : undefined
  const importTarget = city ? JSON.stringify([city.countryId, city.id, 'drone']) : undefined
  const session = useMediaImportSession(importTarget)
  const sessionLocked = session.state.phase !== 'idle' || session.blocked
  const items = useMemo(() => getDroneMediaForCity(cityId), [cityId])
  const metadataRunRef = useRef(0)
  const mountedRef = useRef(true)
  const [editing, setEditing] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useLocalizedNotice()
  const [draggedItemId, setDraggedItemId] = useState<string>()
  const [draftItemIds, setDraftItemIds] = useState(items.map((item) => item.id))
  const [draftHiddenIds, setDraftHiddenIds] = useState(travelAtlasEditorState.hiddenDroneMediaIds)
  const [uploadForm, setUploadForm] = useState({
    kind: 'panorama360' as 'panorama360' | 'aerialPhoto',
  })
  const [fileDrafts, setFileDrafts] = useState<DroneFileDraft[]>([])
  const itemById = new Map(items.map((item) => [item.id, item]))
  const displayedItems = editing
    ? draftItemIds.map((id) => itemById.get(id)).filter(Boolean)
    : items
  const droneGridRef = useFlipLayout<HTMLDivElement>(draftItemIds.join('|'))
  const hiddenIdsForCity = city
    ? draftHiddenIds.filter((id) => allImportedMediaItems.some((item) => (
        item.id === id && item.cityId === city.id && (item.kind === 'panorama360' || item.kind === 'aerialPhoto')
      )))
    : []
  const panoramaMismatchCount = uploadForm.kind === 'panorama360'
    ? fileDrafts.filter((draft) => draft.status === 'ready' && !isLikelyEquirectangularPanorama(draft.width, draft.height)).length
    : 0
  const aerialPanoramaHintCount = uploadForm.kind === 'aerialPhoto'
    ? fileDrafts.filter((draft) => draft.status === 'ready' && isLikelyEquirectangularPanorama(draft.width, draft.height)).length
    : 0

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      metadataRunRef.current += 1
    }
  }, [])

  if (!city || (items.length === 0 && !localEditorAvailable)) return null

  // Saved bilingual titles are stable metadata, independent of the interface language.
  const mediaTitle = `${city.nameZh}无人机影像`

  const saveDraft = async () => {
    if (busy || sessionLocked) return
    setBusy(true)
    setNotice({ key: 'droneEditor:saving' })
    try {
      await updateLocalEditorState((current) => ({
        ...current,
        droneOrderByCity: { ...current.droneOrderByCity, [city.id]: draftItemIds },
        hiddenDroneMediaIds: draftHiddenIds,
      }))
      reloadAfterLocalSave()
    } catch (error) {
      setNotice(editorErrorNotice(error, 'droneEditor:saveFailed'))
      setBusy(false)
    }
  }

  const uploadDroneFiles = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || sessionLocked) return
    if (!fileDrafts.length) {
      setNotice({ key: 'droneEditor:selectFirst' })
      return
    }
    if (fileDrafts.some((draft) => draft.status === 'reading')) {
      setNotice({ key: 'droneEditor:waitReading' })
      return
    }
    if (fileDrafts.some((draft) => !/^\d{4}-\d{2}-\d{2}$/.test(draft.date))) {
      setNotice({ key: 'droneEditor:dateRequired' })
      return
    }
    if (panoramaMismatchCount > 0) {
      setNotice({ key: 'droneEditor:panoramaMismatch', values: { count: panoramaMismatchCount } })
      return
    }
    const selectedKind = uploadForm.kind
    const selectedCity = city
    const titleZh = mediaTitle
    const titleEn = `${city.nameEn} Drone Media`
    const capturedDrafts = new Map(fileDrafts.map((draft) => [draft.file, { ...draft }]))
    const selectedFiles = fileDrafts.map((draft) => draft.file)
    metadataRunRef.current += 1
    setBusy(true)
    setNotice({ key: 'droneEditor:receiving', values: { count: fileDrafts.length } })
    try {
      await session.upload(selectedFiles, async (file, permit) => {
        const draft = capturedDrafts.get(file)!
        const lat = draft.lat.trim() ? Number(draft.lat) : undefined
        const lng = draft.lng.trim() ? Number(draft.lng) : undefined
        const altitudeMeters = draft.altitudeMeters.trim() ? Number(draft.altitudeMeters) : undefined
        const relativeAltitudeMeters = draft.relativeAltitudeMeters.trim() ? Number(draft.relativeAltitudeMeters) : undefined
        return uploadLocalMedia({
          countryId: selectedCity.countryId ?? '',
          cityId: selectedCity.id,
          kind: selectedKind,
          file,
          date: draft.date,
          lat,
          lng,
          altitudeMeters,
          relativeAltitudeMeters,
          titleZh,
          titleEn,
        }, permit)
      })
      if (!mountedRef.current) return
      setNotice({ key: 'droneEditor:importing' })
      await session.importMedia(importLocalMedia)
      if (mountedRef.current) reloadAfterLocalSave()
    } catch {
      if (mountedRef.current) setNotice('')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const retryDroneImport = async () => {
    if (busy || session.blocked || session.state.phase !== 'pending') return
    setBusy(true)
    setNotice('')
    try {
      await session.importMedia(importLocalMedia)
      if (mountedRef.current) reloadAfterLocalSave()
    } catch {
      if (mountedRef.current) setNotice('')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const readSelectedFiles = async (files: FileList | null) => {
    if (busy || sessionLocked) return
    const selectedFiles = Array.from(files ?? [])
    const runId = metadataRunRef.current + 1
    metadataRunRef.current = runId
    const pending = selectedFiles.map(pendingDraft)
    setFileDrafts(pending)
    if (!pending.length) {
      setNotice('')
      return
    }

    setNotice({ key: 'droneEditor:readingFiles', values: { count: pending.length } })
    const resolved = await Promise.all(pending.map(async (draft) => {
      try {
        const [metadataResult, dimensionsResult] = await Promise.allSettled([
          readDroneFileMetadata(draft.file),
          readImageDimensions(draft.file),
        ])
        const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : {}
        const dimensions = dimensionsResult.status === 'fulfilled' ? dimensionsResult.value : undefined
        const readErrors = [
          metadataResult.status === 'rejected' ? 'readExifError' : undefined,
          dimensionsResult.status === 'rejected' ? 'readDimensionsError' : undefined,
        ].filter((key): key is string => key !== undefined)
        return {
          ...draft,
          status: 'ready' as const,
          date: metadata.date ?? '',
          lat: displayNumber(metadata.lat),
          lng: displayNumber(metadata.lng),
          altitudeMeters: displayNumber(metadata.altitudeMeters),
          relativeAltitudeMeters: displayNumber(metadata.relativeAltitudeMeters),
          camera: metadata.camera,
          ...dimensions,
          ...(readErrors.length > 0 ? { errorKeys: readErrors } : {}),
          fromFile: {
            date: metadata.date !== undefined,
            lat: metadata.lat !== undefined,
            lng: metadata.lng !== undefined,
            altitudeMeters: metadata.altitudeMeters !== undefined,
            relativeAltitudeMeters: metadata.relativeAltitudeMeters !== undefined,
          },
        }
      } catch (error) {
        return {
          ...draft,
          status: 'ready' as const,
          ...(error instanceof Error ? { error: error.message } : { errorKeys: ['readFileError'] }),
        }
      }
    }))

    if (!mountedRef.current || metadataRunRef.current !== runId || !importTarget
      || getMediaImportSession(importTarget).getSnapshot().phase !== 'idle') return
    setFileDrafts(resolved)
    const missingDates = resolved.filter((draft) => !draft.date).length
    setNotice(missingDates
      ? { key: 'droneEditor:missingDates', values: { count: missingDates } }
      : { key: 'droneEditor:lockedFields' })
  }

  const updateFileDraft = (
    id: string,
    field: 'date' | 'lat' | 'lng' | 'altitudeMeters' | 'relativeAltitudeMeters',
    value: string,
  ) => {
    if (busy || sessionLocked) return
    setFileDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, [field]: value } : draft))
  }

  return (
    <aside className="drone-media-card glass-panel relative z-10 w-full p-[18px] text-left">
      <div className="atlas-panel-body drone-media-card-layout">
        <div className="drone-media-card-heading">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/55 bg-white/45 text-sky-600">
            <Drone className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase leading-4 tracking-[0.22em] text-white">{t('heading')}</p>
            <h2 className="mt-1 truncate text-[22px] font-semibold leading-[1.15] tracking-normal text-slate-950">{t('cityHeading', { name: name(city) })}</h2>
          </div>
          {localEditorAvailable ? (
            <LocalEditorToolbar
              editing={editing}
              busy={busy || sessionLocked}
              label={t('heading')}
              onToggle={() => {
                if (busy || sessionLocked) return
                metadataRunRef.current += 1
                setEditing((current) => !current)
                setShowUpload(false)
                setDraftItemIds(items.map((item) => item.id))
                setDraftHiddenIds(travelAtlasEditorState.hiddenDroneMediaIds)
                setFileDrafts([])
                setNotice('')
              }}
              onReset={() => {
                if (busy || sessionLocked) return
                metadataRunRef.current += 1
                setDraftItemIds(items.map((item) => item.id))
                setDraftHiddenIds(travelAtlasEditorState.hiddenDroneMediaIds)
                setShowUpload(false)
                setFileDrafts([])
                setNotice({ key: 'droneEditor:undo' })
              }}
              onAdd={() => {
                if (busy || sessionLocked) return
                setShowUpload((open) => !open)
              }}
              onSave={saveDraft}
            />
          ) : null}
        </div>

        {editing && showUpload ? (
          <form className="atlas-local-editor-form atlas-local-editor-form-dark" onSubmit={uploadDroneFiles}>
            <p>{t('importHelp')}</p>
            <div className="atlas-local-editor-form-grid">
              <select disabled={busy || sessionLocked} aria-label={t('kind')} className="atlas-local-media-kind" value={uploadForm.kind} onChange={(event) => {
                if (busy || sessionLocked) return
                setUploadForm((form) => ({ ...form, kind: event.target.value as 'panorama360' | 'aerialPhoto' }))
              }}>
                <option value="panorama360">{t('panorama')}</option>
                <option value="aerialPhoto">{t('aerialPhoto')}</option>
              </select>
              <label className="atlas-local-file-picker">
                <input type="file" disabled={busy || sessionLocked} multiple accept="image/jpeg,image/png,image/webp,image/avif" aria-label={t('images')} onChange={(event) => void readSelectedFiles(event.target.files)} />
                <span className="atlas-local-file-picker-button">{t('chooseFiles')}</span>
                <span className="atlas-local-file-picker-status" data-empty={fileDrafts.length === 0}>
                  {fileDrafts.length === 0
                    ? t('noFiles')
                    : fileDrafts.length === 1 ? fileDrafts[0].file.name : t('selectedFiles', { count: fileDrafts.length })}
                </span>
              </label>
            </div>
            {panoramaMismatchCount > 0 ? (
              <p className="atlas-local-editor-warning" role="alert">
                {t('panoramaWarning', { count: panoramaMismatchCount })}
              </p>
            ) : aerialPanoramaHintCount > 0 ? (
              <p className="atlas-local-editor-warning" role="status">
                {t('aerialPanoramaHint', { count: aerialPanoramaHintCount })}
              </p>
            ) : null}
            {fileDrafts.length > 0 ? (
              <div className="atlas-drone-metadata-list">
                {fileDrafts.map((draft, index) => (
                  <article key={draft.id} className="atlas-drone-metadata-card" data-status={draft.status}>
                    <header>
                      <div>
                        <strong>{String(index + 1).padStart(2, '0')} · {draft.file.name}</strong>
                        <span>{(draft.file.size / 1024 / 1024).toFixed(2)} MiB{draft.camera ? ` · ${draft.camera}` : ''}</span>
                      </div>
                      <span>{draft.status === 'reading' ? t('reading') : t('ready')}</span>
                    </header>
                    {draft.error || draft.errorKeys?.length ? (
                      <p>{t('parseWarning', { error: draft.error ?? draft.errorKeys?.map((key) => t(key)).join(t('errorSeparator')) })}</p>
                    ) : null}
                    <div className="atlas-drone-metadata-fields">
                      <label>
                        <span>{t('date')} <em>{draft.fromFile.date ? t('fromFile') : t('missingRequired')}</em></span>
                        <input type="date" required disabled={busy || sessionLocked} readOnly={draft.fromFile.date} value={draft.date} onChange={(event) => updateFileDraft(draft.id, 'date', event.target.value)} />
                      </label>
                      <label>
                        <span>{t('latitude')} <em>{draft.fromFile.lat ? t('fromFile') : t('missingOptional')}</em></span>
                        <input type="number" disabled={busy || sessionLocked} step="any" min="-90" max="90" readOnly={draft.fromFile.lat} placeholder={t('optionalCoordinate')} value={draft.lat} onChange={(event) => updateFileDraft(draft.id, 'lat', event.target.value)} />
                      </label>
                      <label>
                        <span>{t('longitude')} <em>{draft.fromFile.lng ? t('fromFile') : t('missingOptional')}</em></span>
                        <input type="number" disabled={busy || sessionLocked} step="any" min="-180" max="180" readOnly={draft.fromFile.lng} placeholder={t('optionalCoordinate')} value={draft.lng} onChange={(event) => updateFileDraft(draft.id, 'lng', event.target.value)} />
                      </label>
                      <label>
                        <span>{t('altitude')} <em>{draft.fromFile.altitudeMeters ? t('fromFile') : t('missingOptional')}</em></span>
                        <input type="number" disabled={busy || sessionLocked} step="any" readOnly={draft.fromFile.altitudeMeters} placeholder={t('optionalMeters')} value={draft.altitudeMeters} onChange={(event) => updateFileDraft(draft.id, 'altitudeMeters', event.target.value)} />
                      </label>
                      <label>
                        <span>{t('relativeAltitude')} <em>{draft.fromFile.relativeAltitudeMeters ? t('fromFile') : t('missingOptional')}</em></span>
                        <input type="number" disabled={busy || sessionLocked} step="any" readOnly={draft.fromFile.relativeAltitudeMeters} placeholder={t('optionalMeters')} value={draft.relativeAltitudeMeters} onChange={(event) => updateFileDraft(draft.id, 'relativeAltitudeMeters', event.target.value)} />
                      </label>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
            <button className="atlas-local-import-submit" type="submit" disabled={busy || sessionLocked || panoramaMismatchCount > 0}>{t('confirmImport')}</button>
          </form>
        ) : null}

        {notice ? <p className="atlas-local-editor-notice atlas-local-editor-notice-dark" role="status">{notice}</p> : null}
        {localEditorAvailable && session.blocked ? (
          <p className="atlas-local-editor-notice atlas-local-editor-notice-dark" role="status">
            {t(session.otherWriting ? 'mediaImport:otherWriting' : 'mediaImport:otherPending')}
          </p>
        ) : null}
        {localEditorAvailable ? <MediaImportRecovery state={session.state} busy={busy || session.blocked} onRetry={retryDroneImport} /> : null}

        {editing && hiddenIdsForCity.length > 0 ? (
          <div className="atlas-local-editor-hidden-actions">
            <button
              type="button"
              className="atlas-local-editor-restore"
              disabled={busy || sessionLocked}
              onClick={() => {
                if (busy || sessionLocked) return
                setBusy(true)
                void updateLocalEditorState((current) => ({
                  ...current,
                  hiddenDroneMediaIds: current.hiddenDroneMediaIds.filter((id) => !hiddenIdsForCity.includes(id)),
                })).then(reloadAfterLocalSave).catch((error: unknown) => {
                  setNotice(editorErrorNotice(error, 'droneEditor:restoreFailed'))
                  setBusy(false)
                })
              }}
            >
              {t('restoreHidden', { count: hiddenIdsForCity.length })}
            </button>
            <button
              type="button"
              className="atlas-local-editor-delete"
              disabled={busy || sessionLocked}
              onClick={() => {
                if (busy || sessionLocked) return
                const confirmed = window.confirm(t('deleteConfirm', { count: hiddenIdsForCity.length }))
                if (!confirmed) return
                setBusy(true)
                setNotice({ key: 'droneEditor:deleting' })
                void updateLocalEditorState((current) => ({
                  ...current,
                  hiddenDroneMediaIds: [...new Set([...current.hiddenDroneMediaIds, ...hiddenIdsForCity])],
                }))
                  .then(() => deleteHiddenLocalMedia(city.id, hiddenIdsForCity))
                  .then(reloadAfterLocalSave)
                  .catch((error: unknown) => {
                    setNotice(editorErrorNotice(error, 'droneEditor:deleteFailed'))
                    setBusy(false)
                  })
              }}
            >
              {t('deleteHidden')}
            </button>
          </div>
        ) : null}

        {displayedItems.length === 0 ? (
          <div className="atlas-local-editor-empty">{t('emptyEditable')}</div>
        ) : (
          <div ref={droneGridRef} className="drone-media-track selector-scrollbar min-w-0 flex-1">
            {displayedItems.map((item, index) => {
              if (!item) return null
              const itemNumber = String(index + 1).padStart(2, '0')
              return (
                <article
                  key={item.id}
                  data-flip-id={item.id}
                  role="button"
                  tabIndex={0}
                  draggable={editing}
                  data-editing={editing}
                  data-dragging={draggedItemId === item.id}
                  data-active={item.id === activeItemId}
                  aria-pressed={item.id === activeItemId}
                  aria-label={t('openItem', { name: name(city), number: itemNumber })}
                  onDragStart={(event) => {
                    if (!editing) return
                    setDraggedItemId(item.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item.id)
                  }}
                  onDragOver={(event) => {
                    if (!editing || !draggedItemId || draggedItemId === item.id) return
                    event.preventDefault()
                    setDraftItemIds((current) => {
                      const next = current.filter((id) => id !== draggedItemId)
                      next.splice(next.indexOf(item.id), 0, draggedItemId)
                      return next
                    })
                  }}
                  onDragEnd={() => setDraggedItemId(undefined)}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!editing) onSelectItem(item)
                  }}
                  onKeyDown={(event) => {
                    if (!editing && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      event.stopPropagation()
                      onSelectItem(item)
                    }
                  }}
                  className="drone-media-item-card drone-media-item-card-thumbnail rounded-xl border border-white/65 bg-white/52 p-2 shadow-[0_8px_18px_rgba(15,23,42,0.07)]"
                >
                  <div className="drone-media-thumbnail-frame">
                    <img src={`${item.thumbSrc}?starmapMedia=${encodeURIComponent(item.id)}`} alt={t('previewAlt', { name: name(city), number: itemNumber })} loading="lazy" decoding="async" />
                    <span className="drone-media-thumbnail-shade" aria-hidden="true" />
                    {item.type === 'panorama360' ? (
                      <span className="drone-media-panorama-badge" aria-label={t('panoramaBadge')} title={t('panoramaBadge')}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <ellipse cx="12" cy="12" rx="9" ry="4.5" />
                          <path d="M3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8-9-3.6-9-8Z" />
                          <path d="m7 10-2 2 2 2M17 10l2 2-2 2" />
                        </svg>
                        <span>360°</span>
                      </span>
                    ) : null}
                  </div>
                  <span className="drone-media-item-number drone-media-thumbnail-number">{itemNumber}</span>
                  {editing ? (
                    <span className="atlas-local-media-tools" onClick={(event) => event.stopPropagation()}>
                      <span className="atlas-local-editor-drag" aria-label={t('drag')}><GripVertical /></span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('hide')}
                        title={t('hideTitle')}
                        onClick={() => {
                          setDraftItemIds((current) => current.filter((id) => id !== item.id))
                          setDraftHiddenIds((current) => [...new Set([...current, item.id])])
                        }}
                      ><X /></span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenPanorama(item)
                      }}
                      aria-label={t('openViewer', { name: name(city), number: itemNumber })}
                      className="drone-media-view-button mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-lg bg-slate-950 px-1.5 py-1.5 font-semibold text-white transition hover:bg-sky-500 hover:text-slate-950"
                    >
                      <Maximize2 aria-hidden="true" />
                      {t('view')}
                    </button>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
