import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { previewMediaReread, rereadMedia } from '../data/localEditorClient'
import { isStalePreviewCode, rereadValueText, type MediaRereadPreview, type MediaRereadProblemReason, type MediaRereadScope } from '../data/mediaMaintenance.ts'
import { MEDIA_REREAD_OPEN_EVENT, type MediaRereadRequest } from '../data/mediaMaintenanceUi.ts'
import { formatEditorError } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useUiLocale } from '../i18n/useUiLocale'
import { useDialogFocus } from './useDialogFocus'

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'preview'; readonly preview: MediaRereadPreview }
  | { readonly kind: 'writing'; readonly preview: MediaRereadPreview }
  | { readonly kind: 'done'; readonly count: number }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

const codeOf = (error: unknown) => (error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined)
const fileName = (path: string) => path.split('/').at(-1) ?? path

/**
 * 3C-5 F: 「重新读取说明」. Mounted by App only in the local personal editor (loaded on first use); opened by
 * requestMediaReread (../data/mediaMaintenanceUi.ts) for one item or a city. It previews (the Inbox is read once,
 * nothing written): each item's changed fields with the value in the app now and the value of the folder and sidecar,
 * a warning that edits made in the app are replaced, the items not written with their reasons, and the others counted.
 * Confirming writes exactly that preview (its digest); the page then applies the changed rows without reloading. A
 * preview out of date is refused by the server and asked again here. Results are announced in a status region; focus
 * returns to the opener on close.
 */
export function MediaRereadDialog() {
  const { t } = useTranslation('mediaMaintenance')
  const { locale } = useUiLocale()
  const { name } = usePlaceNames()
  const [request, setRequest] = useState<MediaRereadRequest>()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const returnFocus = useRef<HTMLElement | null>(null)
  const previewAgainRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const ticket = useRef(0)
  const open = request !== undefined
  const { dialogRef, trapFocus } = useDialogFocus<HTMLDivElement>({ open, returnFocus })
  const placeName = (id: string) => name({ id, nameZh: id, nameEn: id })

  const load = useCallback(async (scope: MediaRereadScope) => {
    const mine = ++ticket.current
    setPhase({ kind: 'loading' })
    try {
      const preview = await previewMediaReread(scope)
      if (mine === ticket.current) setPhase({ kind: 'preview', preview })
    } catch (error) {
      if (mine === ticket.current) setPhase(isStalePreviewCode(codeOf(error)) ? { kind: 'stale' } : { kind: 'failed', error })
    }
  }, [])

  useEffect(() => {
    const openDialog = (event: Event) => {
      const detail = (event as CustomEvent<MediaRereadRequest>).detail
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setRequest(detail)
      void load(detail.scope)
    }
    window.addEventListener(MEDIA_REREAD_OPEN_EVENT, openDialog)
    return () => window.removeEventListener(MEDIA_REREAD_OPEN_EVENT, openDialog)
  }, [load])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  // After a refusal the next step is to preview again; after a write, to close.
  useEffect(() => {
    if (phase.kind === 'stale') previewAgainRef.current?.focus()
    if (phase.kind === 'done') closeRef.current?.focus()
  }, [phase.kind])

  if (!request) return null
  const writing = phase.kind === 'writing'
  const close = () => {
    if (writing) return
    ticket.current += 1
    setRequest(undefined)
  }
  const confirm = async (preview: MediaRereadPreview) => {
    setPhase({ kind: 'writing', preview })
    try {
      const result = await rereadMedia(preview)
      setPhase({ kind: 'done', count: result.updatedMediaIds.length })
    } catch (error) {
      setPhase(isStalePreviewCode(codeOf(error)) ? { kind: 'stale' } : { kind: 'failed', error })
    }
  }
  const text = (field: string, value: unknown) => rereadValueText(field, value, locale, placeName) ?? t('empty')
  const fieldLabel = (field: string) => {
    switch (field) {
      case 'place': return t('field_place')
      case 'title': return t('field_title')
      case 'kind': return t('field_kind')
      case 'date': return t('field_date')
      case 'resolution': return t('field_resolution')
      case 'captureType': return t('field_captureType')
      case 'description': return t('field_description')
      case 'position': return t('field_position')
      case 'altitudeMeters': return t('field_altitudeMeters')
      case 'relativeAltitudeMeters': return t('field_relativeAltitudeMeters')
      case 'status': return t('field_status')
      default: return field
    }
  }
  const problemText = (problem: { path: string; reason: MediaRereadProblemReason; detail: string }) => {
    switch (problem.reason) {
      case 'missing': return t('problem_missing', { path: problem.path })
      case 'content-changed': return t('problem_contentChanged', { path: problem.path })
      default: return t('problem_unreadable', { path: problem.path, detail: problem.detail })
    }
  }
  const preview = phase.kind === 'preview' || phase.kind === 'writing' ? phase.preview : undefined
  const status = phase.kind === 'loading' ? t('reading')
    : phase.kind === 'writing' ? t('writing')
      : phase.kind === 'done' ? (phase.count ? t('rereadDone', { count: phase.count }) : t('rereadNothing'))
        : phase.kind === 'stale' ? t('stale')
          : phase.kind === 'failed' ? t('failed', { reason: phase.error instanceof Error ? formatEditorError(phase.error, t) : String(phase.error) })
            : ''
  const writable = preview !== undefined && (preview.records.length > 0 || preview.registryOnly > 0)

  return createPortal(
    <div className="atlas-media-recovery-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="atlas-media-recovery-center atlas-media-maintenance" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="media-reread-title"
        data-testid="media-reread-dialog" tabIndex={-1} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          trapFocus(event)
        }}>
        <header className="atlas-media-recovery-header">
          <h2 id="media-reread-title">{t('rereadTitle', { name: request.name })}</h2>
          <button type="button" ref={closeRef} disabled={writing} onClick={close}>{t('close')}</button>
        </header>
        <p role="status" className={phase.kind === 'failed' || phase.kind === 'stale' ? 'atlas-media-recovery-error' : undefined}>{status}</p>
        {phase.kind === 'stale' || phase.kind === 'failed' ? (
          <div className="atlas-media-recovery-actions">
            <button type="button" ref={previewAgainRef} onClick={() => void load(request.scope)}>{t('previewAgain')}</button>
          </div>
        ) : null}
        {preview ? (
          <>
            {preview.records.length ? (
              <>
                <p className="atlas-media-maintenance-warning">{t('overwriteWarning')}</p>
                <h3>{t('changes', { count: preview.records.length })}</h3>
                <ul className="atlas-media-recovery-sources" data-testid="media-reread-changes">
                  {preview.records.map((record) => {
                    const place = record.changes.find((change) => change.field === 'place')
                    return (
                      <li key={record.mediaId} data-media-id={record.mediaId}>
                        <strong>{fileName(record.sources[0]?.path ?? record.mediaId)}</strong>
                        <ul>
                          {record.changes.map((change) => (
                            <li key={change.field}>{t('changeLine', { field: fieldLabel(change.field), from: text(change.field, change.from), to: text(change.field, change.to) })}</li>
                          ))}
                        </ul>
                        {place && typeof place.to === 'string' ? <small>{t('placeMove', { city: placeName(place.to) })}</small> : null}
                      </li>
                    )
                  })}
                </ul>
              </>
            ) : <p>{t('noChanges')}</p>}
            {preview.conflicts.length || preview.problems.length ? (
              <>
                <h3>{t('notWritten')}</h3>
                <ul className="atlas-media-recovery-sources">
                  {preview.conflicts.map((conflict) => <li key={`conflict-${conflict.mediaId}`}>{t('conflict', { paths: conflict.sources.map((source) => source.path).join(', ') })}</li>)}
                  {preview.problems.map((problem) => <li key={`problem-${problem.mediaId}-${problem.path}-${problem.reason}`}>{problemText(problem)}</li>)}
                </ul>
              </>
            ) : null}
            {preview.unchanged ? <p>{t('unchanged', { count: preview.unchanged })}</p> : null}
            {preview.registryOnly ? <p>{t('registryOnly', { count: preview.registryOnly })}</p> : null}
            {preview.withoutSource ? <p>{t('withoutSource', { count: preview.withoutSource })}</p> : null}
            <div className="atlas-media-recovery-actions">
              <button type="button" disabled={writing} onClick={close}>{t('cancel')}</button>
              <button type="button" data-testid="media-reread-confirm" disabled={!writable || writing} onClick={() => void confirm(preview)}>
                {preview.records.length ? t('confirmReread', { count: preview.records.length }) : t('confirmRegistry')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
