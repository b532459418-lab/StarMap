import { useTranslation } from 'react-i18next'
import type { MediaImportSessionState } from '../data/mediaImportSession.ts'
import { formatEditorError } from '../i18n/editorErrors.ts'

type Props = {
  state: MediaImportSessionState
  busy: boolean
  onRetry: () => void | Promise<void>
}

/** Recovery concerns files already delivered, independent of the current form draft. */
export function MediaImportRecovery({ state, busy, onRetry }: Props) {
  const { t } = useTranslation('mediaImport')
  if (!state.error && state.phase !== 'pending' && state.phase !== 'uncertain' && state.phase !== 'importing') return null
  const uncertain = state.phase === 'uncertain'
  const pending = state.sourcePaths.length > 0 && (state.phase === 'pending' || state.phase === 'importing')
  const diagnostic = state.error instanceof Error ? formatEditorError(state.error, t) : state.error ? t('failed') : undefined
  return (
    <div className="atlas-media-import-recovery" onClick={(event) => event.stopPropagation()}>
      <div className="atlas-local-editor-notice atlas-local-editor-notice-dark" role="status">
        {state.sourcePaths.length > 0 ? <p>{t('received', { count: state.sourcePaths.length })}</p> : null}
        {uncertain ? <p>{t('uncertain')}</p> : state.phase === 'importing' ? <p>{t('retrying')}</p> : pending ? <>
          <p>{t('pending')}</p>
          {state.sourcePaths.length < state.selectedCount ? <p>{t('partial')}</p> : null}
        </> : null}
        {diagnostic ? <p>{diagnostic}</p> : null}
      </div>
      {uncertain ? (
        <button type="button" className="atlas-local-editor-restore" disabled={busy} onClick={() => window.location.reload()}>{t('reload')}</button>
      ) : pending ? (
        <button type="button" className="atlas-local-editor-restore" disabled={busy || state.phase === 'importing'} onClick={() => void onRetry()}>
          {state.phase === 'importing' ? t('retrying') : t('retry')}
        </button>
      ) : null}
    </div>
  )
}
