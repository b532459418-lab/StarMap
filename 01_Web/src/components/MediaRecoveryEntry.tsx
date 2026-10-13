import { useTranslation } from 'react-i18next'
import { requestMediaRecovery } from '../data/mediaRecoveryUi.ts'
import { useMediaJobs } from './useMediaJobs'

/**
 * The media recovery entry inside the city and drone cards. It only sends the open request; MediaRecoveryCenter, which
 * App loads on demand in the local personal editor, answers it. Kept apart from that module (batch 5B) so the cards do
 * not pull the whole recovery center in statically.
 */
export function MediaRecoveryEntry({ countryId, cityId }: { countryId?: string; cityId?: string }) {
  const { t } = useTranslation('mediaRecovery')
  const state = useMediaJobs()
  const active = state.jobs.filter((job) => job.phase !== 'closed' && job.phase !== 'abandoned')
  const relevant = active.find((job) => job.countryId === countryId && job.cityId === cityId)
  if (!active.length && !state.error && !state.status) return null
  return <button type="button" className="atlas-local-editor-restore" onClick={() => requestMediaRecovery(relevant?.jobId)}>
    {t('open')}
  </button>
}
