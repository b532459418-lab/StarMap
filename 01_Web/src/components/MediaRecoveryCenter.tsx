import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useTravelAtlas } from '../data/travelAtlas'
import { useMediaCatalog } from '../data/mediaCatalog'
import { useWorldGraph } from '../data/worldGraph'
import { isFinishedMediaJob, type MediaJob, type MediaJobPreview } from '../data/mediaJobs.ts'
import { MEDIA_RECOVERY_OPEN_EVENT, requestMediaRecovery } from '../data/mediaRecoveryUi.ts'
import { formatEditorError, LocalEditorError } from '../i18n/editorErrors.ts'
import { domainErrorResources } from '../i18n/domainErrorResources.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useMediaJobs } from './useMediaJobs'
import { useDialogFocus } from './useDialogFocus'

/** The places of the graph and the media by id, of the data on the page. */
function useRecoveryLookups() {
  const { worldGraphSnapshot } = useWorldGraph()
  const { allImportedMediaItems } = useMediaCatalog()
  const places = useMemo(() => new Map(worldGraphSnapshot.entities.map((place) => [place.id, place])), [worldGraphSnapshot])
  const mediaById = useMemo(() => new Map(allImportedMediaItems.map((item) => [item.id, item])), [allImportedMediaItems])
  return { places, mediaById }
}

function ImportScope({ job, preview, disabled, onImport }: {
  job: MediaJob; preview: MediaJobPreview; disabled: boolean; onImport: (options: { acceptFolderBindings?: boolean; acceptSourceMatches?: boolean }) => Promise<unknown>
}) {
  const { t } = useTranslation('mediaRecovery')
  const { name } = usePlaceNames()
  const { places, mediaById } = useRecoveryLookups()
  const { countryIdOfCity } = useTravelAtlas()
  const [confirmed, setConfirmed] = useState(false)
  // Batch 2A: folders matched to a place only by name are confirmed here, in the same import step.
  const [bindingsConfirmed, setBindingsConfirmed] = useState(false)
  // 3C-4c (the new library): source matches are confirmed the same way, next to their list.
  const [matchesConfirmed, setMatchesConfirmed] = useState(false)
  const blockerDescriptions: Record<string, string> = {
    E_MEDIA_PLAN_READ: t('blockerRead'), E_MEDIA_PLAN_LINK: t('blockerLink'), E_MEDIA_PLAN_JSON: t('blockerJson'),
    E_MEDIA_PLAN_SCAN: t('blockerScan'), E_MEDIA_PLAN_UNCERTAIN: t('blockerUncertain'),
    E_MEDIA_PLAN_ID_COLLISION: t('blockerCollision'), E_MEDIA_PLAN_CONTENT_COLLISION: t('blockerCollision'), E_MEDIA_PLAN_PREFIX_COLLISION: t('blockerCollision'),
    E_MEDIA_PLAN_DATE: t('blockerDate'), E_MEDIA_PLAN_INTEGRITY: t('blockerCatalog'), E_MEDIA_PLAN_INDEX: t('blockerCatalog'),
    E_MEDIA_PLAN_CATALOG_INDEX: t('blockerCatalog'), E_MEDIA_PLAN_CATALOG: t('blockerCatalog'),
    E_MEDIA_PLAN_OUTPUT: t('blockerOutput'), E_MEDIA_PLAN_OWNERSHIP: t('blockerOwnership'), E_MEDIA_PLAN_CHANGED: t('blockerChanged'),
  }
  const summary = preview.plan.summary
  const largeSources = summary.sources.filter(source => source.bytes > (source.kind === 'panorama360' ? 40 : 16) * 1024 * 1024).length
  const sourcesById = new Map(summary.sources.map((source) => [source.id, source]))
  const placeLabel = (id: string | undefined) => id && places.has(id)
    ? name({ id }) || t('placeRecord', { id })
    : id ? t('placeRecord', { id }) : t('unknownPlace')
  const targetLabel = (cityId: string | undefined, countryId = cityId ? countryIdOfCity(cityId) : undefined) =>
    t('scopeTarget', { country: placeLabel(countryId), city: placeLabel(cityId) })
  const mediaLabel = (id: string) => {
    const item = mediaById.get(id)
    const source = sourcesById.get(id)
    const title = item ? name({ nameZh: item.titleZh, nameEn: item.titleEn }) : ''
    const fileName = item?.originalFileName || source?.sourcePath.split('/').at(-1)
    return {
      label: title && fileName ? `${title} · ${fileName}` : title || fileName || t('mediaRecord', { id }),
      target: targetLabel(item?.cityId ?? source?.placeId, item?.countryId),
    }
  }
  const impactGroups = [
    { testId: 'media-scope-added', title: t('planAdded', { count: summary.addedIds.length }), ids: summary.addedIds },
    { testId: 'media-scope-updated', title: t('planUpdated', { count: summary.updatedIds.length }), ids: summary.updatedIds },
    { testId: 'media-scope-removed', title: t('planRemoved', { count: summary.removedIds.length }), ids: summary.removedIds },
    { testId: 'media-scope-restored', title: t('planRestored', { count: summary.editorEffects.restoredMediaIds.length }), ids: summary.editorEffects.restoredMediaIds },
  ]
  const orderingCities = Object.entries(summary.editorEffects.orders).flatMap(([kind, byCity]) =>
    Object.entries(byCity).map(([cityId, ids]) => ({ kind, cityId, ids })))
  const unsent = job.files.filter((file) => file.status === 'not_received').length
  const stale = job.revision !== preview.revision
  const bindings = summary.pins
  const bindingsPending = bindings.length > 0 && !bindingsConfirmed
  const sourceMatches = summary.sourceMatches ?? []
  const matchesPending = sourceMatches.length > 0 && !matchesConfirmed
  const matchReason = { 'deleted-content': t('sourceMatchDeleted'), replaced: t('sourceMatchReplaced'), 'ambiguous-move': t('sourceMatchAmbiguous') }
  const bindingPlace = (names: Record<string, string>, placeId: string) =>
    [...new Set([names['zh-Hans'], names.en].filter(Boolean))].join(' / ') || t('placeRecord', { id: placeId })
  return <section className="atlas-media-recovery-preview" data-testid="media-import-preview" aria-label={t('planTitle')}>
    <h4>{t('planTitle')}</h4>
    {largeSources > 0 ? <p>{t('largeSourceHint', { count: largeSources })}</p> : null}
    <p>{t('planNotice')}</p>
    <p>{t('planCounts', { added: summary.addedIds.length, updated: summary.updatedIds.length, removed: summary.removedIds.length })}</p>
    <p>{t('planEffects', { restored: summary.editorEffects.restoredMediaIds.length, pins: summary.pins.length, outputs: summary.outputs.length })}</p>
    {unsent > 0 ? <p>{t('partial', { received: preview.selectedFileIds.length, unsent })}</p> : null}
    {summary.missing ? <p>{t('planMissing', { count: summary.missing })}</p> : null}
    {impactGroups.map((group) => <details key={group.testId} data-testid={group.testId} open={group.ids.length > 0}>
      <summary>{group.title}</summary>
      {group.ids.length > 0 ? <ul className="atlas-media-recovery-sources">
        {group.ids.map((id) => {
          const media = mediaLabel(id)
          return <li key={id} data-media-id={id}><span>{media.label}</span><small>{media.target}</small></li>
        })}
      </ul> : <p>{t('noImpactItems')}</p>}
    </details>)}
    <details data-testid="media-scope-orders" open={orderingCities.length > 0}>
      <summary>{t('planOrders', { count: orderingCities.length })}</summary>
      {orderingCities.length > 0 ? <>
        <p>{t('planOrderNotice')}</p>
        {orderingCities.map(({ kind, cityId, ids }) => <section key={`${kind}/${cityId}`} data-city-id={cityId} data-order-kind={kind}>
          <h4>{targetLabel(cityId)} · {kind === 'photos' ? t('kind_photo') : kind === 'drone' ? t('droneOrder') : t('mediaOrder')}</h4>
          {ids.length > 0 ? <ol className="atlas-media-recovery-sources">
            {ids.map((id) => <li key={id} data-media-id={id}>{mediaLabel(id).label}</li>)}
          </ol> : <p>{t('emptyOrder')}</p>}
        </section>)}
      </> : <p>{t('noImpactItems')}</p>}
    </details>
    <details open>
      <summary>{t('planSources', { count: summary.sources.length })}</summary>
      <ul className="atlas-media-recovery-sources">
        {summary.sources.map((source) => <li key={`${source.id}/${source.sourcePath}`}>
          <span>{source.sourcePath}</span>
          <small>{places.has(source.placeId) ? name({ id: source.placeId }) : t('unknownPlace')}{source.placeId !== job.cityId ? ` · ${t('otherCity')}` : ''}</small>
        </li>)}
      </ul>
    </details>
    {bindings.length > 0 ? <section data-testid="media-scope-bindings" aria-label={t('planBindings', { count: bindings.length })}>
      <h4>{t('planBindings', { count: bindings.length })}</h4>
      <p>{t('planBindingsNotice')}</p>
      <ul className="atlas-media-recovery-sources">
        {bindings.map((binding) => <li key={binding.sourcePath} data-place-id={binding.placeId} data-folder={binding.folder}>
          <span>{t('bindingRow', { folder: binding.folder, place: bindingPlace(binding.names, binding.placeId) })}</span>
          <small>{t(binding.subtype === 'country' ? 'bindingCountry' : 'bindingCity')} · {t(binding.source === 'country.json' ? 'bindingByCountryJson' : 'bindingByName')}</small>
        </li>)}
      </ul>
      <label className="atlas-media-recovery-checkbox">
        <input type="checkbox" checked={bindingsConfirmed} disabled={disabled || stale || preview.blockers.length > 0} onChange={(event) => setBindingsConfirmed(event.target.checked)} />
        <span>{t('bindingsConfirm')}</span>
      </label>
    </section> : null}
    {sourceMatches.length > 0 ? <section data-testid="media-scope-source-matches" aria-label={t('planSourceMatches', { count: sourceMatches.length })}>
      <h4>{t('planSourceMatches', { count: sourceMatches.length })}</h4>
      <p>{t('planSourceMatchesNotice')}</p>
      <ul className="atlas-media-recovery-sources">
        {sourceMatches.map((match) => <li key={match.sourcePath} data-source-path={match.sourcePath} data-match-kind={match.kind}>
          <span>{match.sourcePath}</span>
          <small>{matchReason[match.kind]} · {t(match.proposal === 'move' ? 'sourceMatchMove' : 'sourceMatchNew')}</small>
        </li>)}
      </ul>
      <label className="atlas-media-recovery-checkbox">
        <input type="checkbox" checked={matchesConfirmed} disabled={disabled || stale || preview.blockers.length > 0} onChange={(event) => setMatchesConfirmed(event.target.checked)} />
        <span>{t('sourceMatchesConfirm')}</span>
      </label>
    </section> : null}
    {preview.blockers.length > 0 ? <div role="status">
      <p>{t('blockers')}</p>
      <ul>{preview.blockers.map((blocker, index) => <li key={`${blocker.code}/${index}`}>
        {blockerDescriptions[blocker.code] ?? t('blockerGeneric')}{blocker.sourcePath ? <small>{blocker.sourcePath}</small> : null}
      </li>)}</ul>
    </div> : null}
    {stale ? <p role="status">{t('stalePreview')}</p> : null}
    <label className="atlas-media-recovery-checkbox">
      <input type="checkbox" checked={confirmed} disabled={disabled || stale || preview.blockers.length > 0} onChange={(event) => setConfirmed(event.target.checked)} />
      <span>{t('scopeConfirm')}</span>
    </label>
    <button type="button" disabled={disabled || stale || !confirmed || bindingsPending || matchesPending || preview.blockers.length > 0}
      onClick={() => void onImport({
        ...(bindings.length > 0 ? { acceptFolderBindings: bindingsConfirmed } : {}),
        ...(sourceMatches.length > 0 ? { acceptSourceMatches: matchesConfirmed } : {}),
      })}>{t('import')}</button>
  </section>
}

function MediaJobCard({ job, state, selected, onOpenTarget, run }: {
  job: MediaJob; state: ReturnType<typeof useMediaJobs>; selected: boolean;
  onOpenTarget?: (countryId: string, cityId: string) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation('mediaRecovery')
  const { name } = usePlaceNames()
  const { places } = useRecoveryLookups()
  const { cityById, countryById } = useTravelAtlas()
  const [files, setFiles] = useState<File[]>([])
  const [confirmedFiles, setConfirmedFiles] = useState(false)
  const statusText: Record<MediaJob['status'], string> = {
    not_received: t('status_not_received'), pending: t('status_pending'), needs_review: t('status_needs_review'),
    completed: t('status_completed'), closed: t('status_closed'), abandoned: t('status_abandoned'),
  }
  const kindText: Record<MediaJob['kind'], string> = {
    photo: t('kind_photo'), aerialPhoto: t('kind_aerialPhoto'), panorama360: t('kind_panorama360'),
  }
  const fileStatusText: Record<MediaJob['files'][number]['status'], string> = {
    not_received: t('file_not_received'), pending: t('file_pending'), needs_review: t('file_needs_review'), completed: t('file_completed'),
  }
  const fileInput = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLElement>(null)
  const country = countryById[job.countryId]
  const city = cityById[job.cityId]
  // Hidden places still exist in the graph; a missing entity must never borrow the current target.
  const targetExists = places.has(job.countryId) && places.has(job.cityId)
  const blocked = state.busy || state.loading || !!state.error || state.status !== undefined
  const completed = job.status === 'completed'
  const uncertain = job.status === 'needs_review'
  const received = job.files.filter((file) => file.status === 'pending' || file.status === 'completed').length
  const unsent = job.files.filter((file) => file.status === 'not_received').length
  const needsReview = job.files.filter((file) => file.status === 'needs_review').length
  // A partially received task is pending, so its aggregate canUpload is false.
  // Only each original, never-started file intent can authorize explicit reselection.
  const canReceive = targetExists && (job.status === 'pending' || job.status === 'not_received')
    && (job.phase === 'open' || job.phase === 'paused') && job.files.some((file) => file.canReceive)
  const preview = state.currentPreview?.jobId === job.jobId ? state.currentPreview : undefined

  useEffect(() => { if (selected) card.current?.scrollIntoView({ block: 'nearest' }) }, [selected])

  return <article ref={card} className="atlas-media-recovery-job" data-testid="media-job-card" data-job-id={job.jobId} data-selected={selected}>
    <header>
      <h3>{t('target', {
        country: places.has(job.countryId) ? name(country ?? { id: job.countryId }) : t('unknownPlace'),
        city: places.has(job.cityId) ? name(city ?? { id: job.cityId }) : t('unknownPlace'),
      })}</h3>
      <strong>{statusText[job.status]}</strong>
    </header>
    <p>{kindText[job.kind]}</p>
    {!targetExists ? <p role="status">{t('missingTarget')}</p> : null}
    <p>{t('fileCounts', { received, unsent, uncertain: needsReview })}</p>
    <ul className="atlas-media-recovery-files">
      {job.files.map((file) => <li key={file.fileId}><span>{file.fileName}</span><small>{completed && file.status === 'not_received' ? t('file_retainedUnsent') : fileStatusText[file.status]}</small></li>)}
    </ul>
    {job.paused && !completed ? <p>{t('paused')}</p> : null}
    {uncertain ? <p role="status">{t('reviewNotice')}</p> : null}
    {completed ? <>
      <p>{t('completeNotice')}</p>
      {unsent > 0 ? <p>{t('completedUnsent', { count: unsent })}</p> : null}
      {job.completion ? <>
        <p>{t('completedAt', { date: job.completion.completedAt })}</p>
        <p>{t('completionCounts', { count: job.completion.mediaIds.length, restored: job.completion.restoredMediaIds.length })}</p>
      </> : null}
      {job.warnings?.length ? <p role="status">{t('changedResources')}</p> : null}
      <p>{t('closeNotice')}</p>
    </> : null}
    <div className="atlas-media-recovery-actions">
      {targetExists && country && city && onOpenTarget ? <button type="button" onClick={() => onOpenTarget(job.countryId, job.cityId)}>{t('openTarget')}</button> : null}
      {completed ? <>
        {/* 3C-5 D: the imported media are on the page without a reload (the dev server pushes the new revision). */}
        <button type="button" disabled={blocked || !job.canClose} onClick={() => void run(() => state.close(job.jobId))}>{t('closeTask')}</button>
      </> : !uncertain && targetExists ? <>
        <button type="button" disabled={blocked || !job.canPreview} onClick={() => void run(() => state.preview(job.jobId))}>{t('preview')}</button>
        {!job.paused ? <button type="button" disabled={blocked} onClick={() => void run(() => state.pause(job.jobId))}>{t('pause')}</button> : null}
      </> : null}
      {job.canAbandon && !isFinishedMediaJob(job) ? <button type="button" data-testid="media-job-abandon" disabled={blocked} onClick={() => {
        if (!window.confirm(t('abandonConfirm'))) return
        void run(() => state.abandon(job.jobId))
      }}>{t('abandonTask')}</button> : null}
    </div>
    {canReceive ? <section className="atlas-media-recovery-reselect">
      <p>{t('reselection')}</p>
      <label className="atlas-media-recovery-file-input">
        <span>{t('selectFiles')}</span>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple aria-label={t('selectFiles')} disabled={blocked} onChange={(event) => {
          setFiles(Array.from(event.target.files ?? []))
          setConfirmedFiles(false)
        }} />
      </label>
      {files.length > 0 ? <p>{t('selectedFiles', { count: files.length })}</p> : null}
      <label className="atlas-media-recovery-checkbox">
        <input type="checkbox" checked={confirmedFiles} disabled={blocked || files.length === 0} onChange={(event) => setConfirmedFiles(event.target.checked)} />
        <span>{t('confirmFiles')}</span>
      </label>
      <button type="button" disabled={blocked || files.length === 0 || !confirmedFiles} onClick={() => void run(async () => {
        await state.receiveMissing(job.jobId, files)
        setFiles([])
        setConfirmedFiles(false)
        if (fileInput.current) fileInput.current.value = ''
      })}>{t('receive')}</button>
    </section> : null}
    {preview ? <ImportScope key={`${preview.jobId}/${preview.revision}/${preview.plan.digest}`} job={job} preview={preview} disabled={blocked || !targetExists || uncertain || completed} onImport={(options) => run(() => state.importJob(job.jobId, preview, options))} /> : null}
  </article>
}

/** Mounted only in the local personal editor. Opening or checking never starts a write. */
export function MediaRecoveryCenter({ onOpenTarget }: { onOpenTarget?: (countryId: string, cityId: string) => void }) {
  const { t } = useTranslation('mediaRecovery')
  const state = useMediaJobs()
  const refresh = state.refresh
  const [open, setOpen] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string>()
  const [localError, setLocalError] = useState<unknown>()
  const returnFocus = useRef<HTMLElement | null>(null)
  const { dialogRef, trapFocus } = useDialogFocus<HTMLDivElement>({ open, returnFocus })
  const jobs = state.jobs.filter((job) => job.phase !== 'closed' && job.phase !== 'abandoned')
  const error = state.error ?? localError
  const diagnostic = error instanceof LocalEditorError && error.code && Object.hasOwn(domainErrorResources.en, error.code)
    ? formatEditorError(new LocalEditorError({ code: error.code, params: error.params }), t)
    : error ? t('failed') : undefined

  useEffect(() => {
    const openPanel = (event: Event) => {
      const hint = (event as CustomEvent<{ jobId?: string }>).detail
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setSelectedJobId(hint?.jobId)
      setOpen(true)
      // Entering recovery explicitly checks fresh facts, without creating or resuming work.
      setLocalError(undefined)
      void refresh().catch((cause: unknown) => setLocalError(cause))
    }
    window.addEventListener(MEDIA_RECOVERY_OPEN_EVENT, openPanel)
    return () => window.removeEventListener(MEDIA_RECOVERY_OPEN_EVENT, openPanel)
  }, [refresh])

  // Focus moves into the panel on open and back to the opener on close through useDialogFocus.
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  async function run(action: () => Promise<unknown>) {
    setLocalError(undefined)
    try { await action() } catch (cause) { setLocalError(cause) }
  }

  const hasEntry = jobs.length > 0 || state.loading || !!state.error || state.status !== undefined
  return <>
    {hasEntry ? <button className="atlas-media-recovery-entry" type="button" data-testid="media-recovery-entry" onClick={() => requestMediaRecovery()}>{t('title')}</button> : null}
    {open ? createPortal(<div className="atlas-media-recovery-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <div className="atlas-media-recovery-center" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('title')} data-testid="media-recovery-center" tabIndex={-1} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
        trapFocus(event)
      }}>
        <header className="atlas-media-recovery-header">
          <h2>{t('title')}</h2>
          <button type="button" onClick={() => setOpen(false)}>{t('closePanel')}</button>
        </header>
        <p>{t('introduction')}</p>
        <button type="button" disabled={state.loading} onClick={() => void run(state.refresh)}>{t('check')}</button>
        {state.loading ? <p role="status">{t('loading')}</p> : null}
        {state.busy ? <p role="status">{t('checking')}</p> : null}
        {state.status ? <p role="status">{t(state.status === 'processing' ? 'busyLibrary' : 'reviewLibrary')}</p> : null}
        {diagnostic ? <p className="atlas-media-recovery-error" role="status">{diagnostic}</p> : null}
        {!state.loading && !state.status && !error && jobs.length === 0 ? <p>{t('empty')}</p> : null}
        {jobs.map((job) => <MediaJobCard key={job.jobId} job={job} state={state} selected={selectedJobId === job.jobId} run={run} onOpenTarget={onOpenTarget ? (countryId, cityId) => {
          onOpenTarget(countryId, cityId)
          setOpen(false)
        } : undefined} />)}
      </div>
    </div>, document.body) : null}
  </>
}
