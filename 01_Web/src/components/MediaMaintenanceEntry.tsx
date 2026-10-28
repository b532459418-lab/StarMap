import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { isFinishedMediaJob } from '../data/mediaJobs'
import { mediaMaintenanceBlockOf, requestMediaReimport, requestMediaReread, type MediaMaintenanceBlock } from '../data/mediaMaintenanceUi.ts'
import { requestMediaRecovery } from '../data/mediaRecoveryUi.ts'
import { legacyUnmigrated, storeMigrationRequired, storeReadOnly, storeRecoveryRequired } from '../data/rawInputs'
import { useLocalEditorCoordination } from './useLocalEditorCoordination'
import { useMediaJobs } from './useMediaJobs'

/**
 * 3C-5 F: the entries of re-reading a city's descriptions and of re-importing its deleted photos, inside the city and
 * drone cards (local editor only; the callers render it behind `import.meta.env.DEV && localEditorAvailable`). It only
 * sends the open request; the dialogs, loaded on demand by App, answer it. When no write may start, both native buttons
 * are disabled and the reason is written next to them (a disabled button takes no focus).
 */
export function MediaMaintenanceEntry({ cityId, cityName }: { cityId: string; cityName: string }) {
  const { t } = useTranslation('mediaMaintenance')
  const mediaSession = useMediaJobs()
  const coordination = useLocalEditorCoordination()
  const reasonId = useId()
  const block = mediaMaintenanceBlockOf({
    storeReadOnly, storeMigrationRequired, legacyUnmigrated, storeRecoveryRequired,
    mediaTaskOpen: mediaSession.loading || mediaSession.busy || Boolean(mediaSession.error || mediaSession.status) || mediaSession.jobs.some((job) => !isFinishedMediaJob(job)),
    otherWriting: coordination.blocked,
  })
  const described = block ? reasonId : undefined
  const reason = (value: MediaMaintenanceBlock) => {
    switch (value) {
      case 'readOnly': return t('blocked_readOnly')
      case 'migration': return t('blocked_migration')
      case 'recovery': return t('blocked_recovery')
      case 'mediaTask': return t('blocked_mediaTask')
      case 'otherWriting': return t('blocked_otherWriting')
    }
  }
  return (
    <div className="atlas-media-maintenance-entry" data-testid="media-maintenance-entry">
      <button type="button" className="atlas-local-editor-restore" disabled={block !== undefined} aria-describedby={described}
        onClick={() => requestMediaReread({ scope: { cityId }, name: cityName })}>{t('rereadOpen')}</button>
      <button type="button" className="atlas-local-editor-restore" disabled={block !== undefined} aria-describedby={described}
        onClick={() => requestMediaReimport({ cityId, name: cityName })}>{t('reimportOpen')}</button>
      {block ? (
        <p id={reasonId} className="atlas-local-editor-notice atlas-local-editor-notice-dark">
          {reason(block)}
          {block === 'mediaTask' ? <> <button type="button" className="atlas-local-editor-restore" onClick={() => requestMediaRecovery()}>{t('openRecovery')}</button></> : null}
        </p>
      ) : null}
    </div>
  )
}
