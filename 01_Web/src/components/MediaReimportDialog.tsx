import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { listMediaReimportCandidates, previewMediaReimport, reimportMedia } from '../data/localEditorClient'
import { isStalePreviewCode, type MediaReimportCandidate, type MediaReimportCandidates, type MediaReimportPreview } from '../data/mediaMaintenance.ts'
import { MEDIA_REIMPORT_OPEN_EVENT, type MediaReimportRequest } from '../data/mediaMaintenanceUi.ts'
import { formatEditorError } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useDialogFocus } from './useDialogFocus'

type Listing = { readonly listed: MediaReimportCandidates; readonly allCities: boolean }
type Phase =
  | { readonly kind: 'checking'; readonly allCities: boolean }
  | { readonly kind: 'list'; readonly listing: Listing; readonly notice?: 'reimported' }
  | { readonly kind: 'previewing'; readonly listing: Listing; readonly candidate: MediaReimportCandidate }
  | { readonly kind: 'preview'; readonly listing: Listing; readonly candidate: MediaReimportCandidate; readonly preview: MediaReimportPreview }
  | { readonly kind: 'writing'; readonly listing: Listing; readonly candidate: MediaReimportCandidate; readonly preview: MediaReimportPreview }
  | { readonly kind: 'stale'; readonly listing: Listing; readonly candidate: MediaReimportCandidate }
  | { readonly kind: 'failed'; readonly listing?: Listing; readonly candidate?: MediaReimportCandidate; readonly error: unknown }

const codeOf = (error: unknown) => (error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined)
const errorText = (error: unknown, t: Parameters<typeof formatEditorError>[1]) => (error instanceof Error ? formatEditorError(error, t) : String(error))

/**
 * 3C-5 F: 「重新导入删除过的照片」. Mounted by App only in the local personal editor; opened by requestMediaReimport
 * (../data/mediaMaintenanceUi.ts) for a city. Opening it checks the Inbox once (the user's request; nothing scans it when
 * a page opens): the files deleted for good and back, of this city or all. Each is re-imported on its own: a preview of
 * the item it becomes (a new id, at the end of its city's order; other new Inbox files are only counted and stay for the
 * next import), then a write of exactly that preview. The page applies the changed rows without reloading.
 */
export function MediaReimportDialog() {
  const { t } = useTranslation('mediaMaintenance')
  const { name } = usePlaceNames()
  const [request, setRequest] = useState<MediaReimportRequest>()
  const [phase, setPhase] = useState<Phase>({ kind: 'checking', allCities: false })
  const [bindingsConfirmed, setBindingsConfirmed] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const focusAfter = useRef<string | undefined>(undefined)
  const statusFocus = useRef<HTMLButtonElement>(null)
  const ticket = useRef(0)
  const open = request !== undefined
  const { dialogRef, trapFocus } = useDialogFocus<HTMLDivElement>({ open, returnFocus })
  const placeName = (id: string | null) => (id ? name({ id, nameZh: id, nameEn: id }) : t('allCities'))

  const check = useCallback(async (cityId: string, allCities: boolean) => {
    const mine = ++ticket.current
    setPhase({ kind: 'checking', allCities })
    try {
      const listed = await listMediaReimportCandidates(allCities ? undefined : cityId)
      if (mine === ticket.current) setPhase({ kind: 'list', listing: { listed, allCities } })
    } catch (error) {
      if (mine === ticket.current) setPhase({ kind: 'failed', error })
    }
  }, [])

  const previewOf = useCallback(async (listing: Listing, candidate: MediaReimportCandidate) => {
    const mine = ++ticket.current
    setBindingsConfirmed(false)
    setPhase({ kind: 'previewing', listing, candidate })
    try {
      const preview = await previewMediaReimport(candidate.path)
      if (mine === ticket.current) setPhase({ kind: 'preview', listing, candidate, preview })
    } catch (error) {
      if (mine !== ticket.current) return
      setPhase(isStalePreviewCode(codeOf(error)) ? { kind: 'stale', listing, candidate } : { kind: 'failed', listing, candidate, error })
    }
  }, [])

  useEffect(() => {
    const openDialog = (event: Event) => {
      const detail = (event as CustomEvent<MediaReimportRequest>).detail
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setRequest(detail)
      void check(detail.cityId, false)
    }
    window.addEventListener(MEDIA_REIMPORT_OPEN_EVENT, openDialog)
    return () => window.removeEventListener(MEDIA_REIMPORT_OPEN_EVENT, openDialog)
  }, [check])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  // Focus follows the step: the file's next step, back to the list (the next file, else "Check again"), or "Preview again".
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (phase.kind === 'stale') { statusFocus.current?.focus(); return }
    if (phase.kind === 'list' && focusAfter.current !== undefined) {
      const target = focusAfter.current
      focusAfter.current = undefined
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-reimport-path]')]
      const next = buttons.find((button) => button.dataset.reimportPath === target) ?? buttons[0] ?? dialog.querySelector<HTMLButtonElement>('[data-testid="media-reimport-recheck"]')
      next?.focus()
    }
    if (phase.kind === 'preview') dialog.querySelector<HTMLElement>('[data-testid="media-reimport-preview"] h3')?.focus()
  }, [phase, dialogRef])

  if (!request) return null
  const writing = phase.kind === 'writing'
  const close = () => {
    if (writing) return
    ticket.current += 1
    setRequest(undefined)
  }
  const backToList = (listing: Listing, focusPath?: string, notice?: 'reimported') => {
    ticket.current += 1
    focusAfter.current = focusPath ?? ''
    setPhase({ kind: 'list', listing, ...(notice ? { notice } : {}) })
  }
  const confirm = async (listing: Listing, candidate: MediaReimportCandidate, preview: MediaReimportPreview) => {
    setPhase({ kind: 'writing', listing, candidate, preview })
    try {
      await reimportMedia(preview, { acceptFolderBindings: bindingsConfirmed })
      const remaining = listing.listed.candidates.filter((item) => item.path !== candidate.path)
      const index = listing.listed.candidates.findIndex((item) => item.path === candidate.path)
      backToList({ ...listing, listed: { ...listing.listed, candidates: remaining } }, remaining[Math.min(index, remaining.length - 1)]?.path, 'reimported')
    } catch (error) {
      setPhase(isStalePreviewCode(codeOf(error)) ? { kind: 'stale', listing, candidate } : { kind: 'failed', listing, candidate, error })
    }
  }
  const kindText = (kind: string) => {
    switch (kind) {
      case 'photo': return t('kind_photo')
      case 'aerialPhoto': return t('kind_aerialPhoto')
      case 'panorama360': return t('kind_panorama360')
      case 'video': return t('kind_video')
      default: return kind
    }
  }
  const reasonText = (candidate: MediaReimportCandidate) => (candidate.reason === 'same-path' ? t('reason_samePath') : t('reason_newPath'))

  const listing = phase.kind === 'checking' ? undefined : phase.listing
  const status = phase.kind === 'checking' ? t('checking')
    : phase.kind === 'previewing' ? t('reading')
      : phase.kind === 'writing' ? t('writing')
        : phase.kind === 'stale' ? t('stale')
          : phase.kind === 'failed' ? t('failed', { reason: errorText(phase.error, t) })
            : phase.kind === 'list' && phase.notice === 'reimported' ? t('reimported')
              : phase.kind === 'list' ? t('checked', { count: phase.listing.listed.scannedFiles })
                : ''
  const inPreview = phase.kind === 'preview' || phase.kind === 'writing' ? phase : undefined
  const blocked = inPreview !== undefined && (inPreview.preview.blockers.errors.length > 0 || inPreview.preview.blockers.uncertain.length > 0 || inPreview.preview.record === null)
  const needsBindings = inPreview !== undefined && inPreview.preview.folderBindings.length > 0

  return createPortal(
    <div className="atlas-media-recovery-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="atlas-media-recovery-center atlas-media-maintenance" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="media-reimport-title"
        data-testid="media-reimport-dialog" tabIndex={-1} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          trapFocus(event)
        }}>
        <header className="atlas-media-recovery-header">
          <h2 id="media-reimport-title">{t('reimportTitle', { name: listing?.allCities ? t('allCities') : request.name })}</h2>
          <button type="button" disabled={writing} onClick={close}>{t('close')}</button>
        </header>
        <p role="status" className={phase.kind === 'failed' || phase.kind === 'stale' ? 'atlas-media-recovery-error' : undefined}>{status}</p>
        {phase.kind === 'stale' ? (
          <div className="atlas-media-recovery-actions">
            <button type="button" ref={statusFocus} onClick={() => void previewOf(phase.listing, phase.candidate)}>{t('previewAgain')}</button>
            <button type="button" onClick={() => backToList(phase.listing, phase.candidate.path)}>{t('cancel')}</button>
          </div>
        ) : null}
        {phase.kind === 'failed' && phase.listing ? (
          <div className="atlas-media-recovery-actions">
            <button type="button" onClick={() => backToList(phase.listing!, phase.candidate?.path)}>{t('cancel')}</button>
          </div>
        ) : null}

        {phase.kind === 'list' ? (
          <section data-testid="media-reimport-list">
            {phase.listing.listed.candidates.length ? (
              <>
                <p>{t('candidatesIntro')}</p>
                <ul className="atlas-media-recovery-sources">
                  {phase.listing.listed.candidates.map((candidate) => (
                    <li key={candidate.path}>
                      <strong>{candidate.path}</strong>
                      <small>{reasonText(candidate)}</small>
                      {phase.listing.allCities ? <small>{placeName(candidate.cityId)}</small> : null}
                      {candidate.pendingDeletion ? <small>{t('pendingDeletion')}</small> : null}
                      <button type="button" data-reimport-path={candidate.path} aria-label={t('reimportFor', { path: candidate.path })}
                        onClick={() => void previewOf(phase.listing, candidate)}>{t('reimportOne')}</button>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p>{t('noCandidates')}</p>}
            {!phase.listing.allCities && phase.listing.listed.otherCities ? <p>{t('otherCities', { count: phase.listing.listed.otherCities })}</p> : null}
            <div className="atlas-media-recovery-actions">
              <button type="button" data-testid="media-reimport-recheck" onClick={() => void check(request.cityId, phase.listing.allCities)}>{t('recheck')}</button>
              <button type="button" onClick={() => void check(request.cityId, !phase.listing.allCities)}>{phase.listing.allCities ? t('showCity') : t('showAll')}</button>
            </div>
          </section>
        ) : null}

        {inPreview ? (
          <section data-testid="media-reimport-preview">
            <h3 tabIndex={-1}>{t('reimportFileTitle', { path: inPreview.preview.file.path })}</h3>
            {inPreview.preview.record ? (
              <>
                <p>{t('willBecome', { city: placeName(inPreview.preview.record.cityId) })}</p>
                <p>{t('recordKind', { kind: kindText(inPreview.preview.record.kind) })}{inPreview.preview.record.date ? <><br />{t('recordDate', { date: inPreview.preview.record.date })}</> : null}</p>
                <p>{inPreview.preview.record.reusesFiles ? t('reusesFiles') : t('regenerates')}</p>
              </>
            ) : <p>{t('noRecord')}</p>}
            {inPreview.preview.file.pendingDeletion ? <p>{t('pendingDeletion')}</p> : null}
            {inPreview.preview.otherNewFiles ? <p>{t('otherNewFiles', { count: inPreview.preview.otherNewFiles })}</p> : null}
            {inPreview.preview.blockers.errors.length || inPreview.preview.blockers.uncertain.length ? (
              <>
                <h4>{t('blockersTitle')}</h4>
                <ul className="atlas-media-recovery-sources">
                  {[...inPreview.preview.blockers.errors, ...inPreview.preview.blockers.uncertain].map((line) => <li key={line}>{line}</li>)}
                </ul>
              </>
            ) : null}
            {needsBindings ? (
              <>
                <h4>{t('bindingsTitle')}</h4>
                <ul className="atlas-media-recovery-sources">
                  {inPreview.preview.folderBindings.map((binding) => <li key={binding.folder}>{t('binding', { folder: binding.folder, place: placeName(binding.placeId) })}</li>)}
                </ul>
                <label className="atlas-media-recovery-checkbox">
                  <input type="checkbox" checked={bindingsConfirmed} disabled={writing} onChange={(event) => setBindingsConfirmed(event.currentTarget.checked)} />
                  <span>{t('confirmBindings')}</span>
                </label>
              </>
            ) : null}
            <div className="atlas-media-recovery-actions">
              <button type="button" disabled={writing} onClick={() => backToList(inPreview.listing, inPreview.candidate.path)}>{t('cancel')}</button>
              <button type="button" data-testid="media-reimport-confirm" disabled={writing || blocked || (needsBindings && !bindingsConfirmed)}
                onClick={() => void confirm(inPreview.listing, inPreview.candidate, inPreview.preview)}>{t('confirmReimport')}</button>
            </div>
          </section>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
