import { useRef, useState } from 'react'
import { Heart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { localEditorAvailable } from '../data/editorState'
import { addLocalWantToGo, reloadAfterLocalSave } from '../data/localEditorApi'
import { wantToGoDataSource } from '../data/wantToGo'
import { wantToGoSnapshot } from '../data/worldGraph'
import { LocalEditorError, editorErrorNotice, requiresEditorReload } from '../i18n/editorErrors.ts'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useLocalEditorCoordination } from './useLocalEditorCoordination'

/** Save the selected place by identity, including entries hidden from the map. */
export function CityWantToGoAction({ cityId, disabled = false }: { cityId: string; disabled?: boolean }) {
  const { t } = useTranslation(['details', 'editor'])
  const coordination = useLocalEditorCoordination()
  const existing = wantToGoSnapshot.memberships.find((membership) => membership.entityId === cityId)
  const [saved, setSaved] = useState(Boolean(existing))
  const [busy, setBusy] = useState(false)
  const [reloadRequired, setReloadRequired] = useState(false)
  const [notice, setNotice] = useLocalizedNotice()
  const submitting = useRef(false)

  if (!localEditorAvailable || wantToGoDataSource !== 'local') return null

  const add = async () => {
    if (submitting.current || saved || disabled || coordination.blocked || reloadRequired) return
    submitting.current = true
    setBusy(true)
    setNotice('')
    let written = false
    try {
      await addLocalWantToGo({ placeId: cityId })
      written = true
      setSaved(true)
      reloadAfterLocalSave()
    } catch (error) {
      if (error instanceof LocalEditorError && error.code === 'E_WTG_EXISTS') setSaved(true)
      setReloadRequired(written || requiresEditorReload(error, { afterWrite: true }))
      setNotice(editorErrorNotice(error, 'editor:addFailed'))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <div className="atlas-city-wtg shrink-0">
      <button
        type="button"
        className="atlas-city-wtg-button"
        data-saved={saved}
        disabled={saved || busy || disabled || coordination.blocked || reloadRequired}
        onClick={() => void add()}
      >
        <Heart aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
        <span>{busy ? t('editor:adding') : saved ? t('details:alreadyWantToGo') : t('details:markWantToGo')}</span>
      </button>
      {existing?.metadata?.hidden === true ? <p className="atlas-city-wtg-hint">{t('details:hiddenWantToGoHint')}</p> : null}
      {notice ? <p className="atlas-local-editor-notice" role="status">{notice}</p> : null}
      {reloadRequired ? <p className="atlas-city-wtg-hint" role="status">{t('details:wantToGoReloadRequired')}</p> : null}
    </div>
  )
}
