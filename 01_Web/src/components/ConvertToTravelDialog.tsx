import { LocalEditorError, editorErrorNotice, requiresEditorReload } from '../i18n/editorErrors.ts'
import { worldGraphSnapshot } from '../data/worldGraph'
import { WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'
import { PLANNED_SOURCE } from '../worldgraph/adapters/plannedRecords'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useUiLocale } from '../i18n/useUiLocale'
import { regionName } from '../i18n/placeNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { X } from 'lucide-react'
import { convertLocalWantToGoToTravel, reloadAfterLocalSave } from '../data/localEditorApi'
import type { LocalConvertToTravelInput, LocalConvertToTravelResult } from '../data/localEditorApi'
import { travelAtlasCountryCodes } from '../data/travelAtlas'
import { plannedRecordById, wantToGoItemById } from '../data/wantToGo'
import { useLocalEditorCoordination } from './useLocalEditorCoordination'

/**
 * 要转换的条目：想去条目，或来自旅行记录的 planned 条目（FR-WTG-7）。
 * `recordId` 是那条记录自己的 id（想去条目的 `item.id`、planned 记录的 `record.id`），即成员关系的 recordId。
 */
export type ConvertToTravelTarget =
  | { source: 'want-to-go'; recordId: string }
  | { source: 'planned'; recordId: string }

type ConvertToTravelDialogProps = {
  /** undefined 表示对话框关闭。 */
  target?: ConvertToTravelTarget
  onClose: () => void
  /** 转换成功、刷新之前调用：App 在这里写视图状态，刷新后直接落在新城市上（PR9 规格 §2 第 8 条）。 */
  onConverted: (result: LocalConvertToTravelResult) => void
}


/**
 * 「标记为去过」对话框（PRD S5 / R13，PR9 规格 §3.5）。只在私人模式下由 App 挂载一份。
 *
 * 想去条目：在足迹中新增这座城市，默认从想去列表移除（可勾选保留，表示还想再去）。
 * planned 条目：把这条旅行计划改为已去过。两种都只调用 localEditorApi 的同一个封装（D26）。
 *
 * 日期一律由用户填写，不预填今天。关闭时整个内容卸载，下次打开是一张干净的表单；
 * 成功后整页刷新，失败把服务端的 error 留在对话框里，不关闭（与 WantToGoAddDialog 相同）。
 * 部分写入或请求结果未知时，提交按钮换成「刷新页面」，避免再次提交可能已经写入的转换。
 */
export function ConvertToTravelDialog({ target, onClose, onConverted }: ConvertToTravelDialogProps) {
  return target ? (
    <ConvertToTravelDialogContent
      key={`${target.source}:${target.recordId}`}
      target={target}
      onClose={onClose}
      onConverted={onConverted}
    />
  ) : null
}

function ConvertToTravelDialogContent({
  target,
  onClose,
  onConverted,
}: ConvertToTravelDialogProps & { target: ConvertToTravelTarget }) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { locale } = useUiLocale()
  const { name, subtitle } = usePlaceNames()
  const coordination = useLocalEditorCoordination()
  const titleId = useId()
  const summaryId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [tripTitle, setTripTitle] = useState('')
  const [keepWantToGo, setKeepWantToGo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useLocalizedNotice()
  const [needsReload, setNeedsReload] = useState(false)
  const [showWriteResultWarning, setShowWriteResultWarning] = useState(false)

  const item = target.source === 'want-to-go' ? wantToGoItemById.get(target.recordId) : undefined
  const planned = target.source === 'planned' ? plannedRecordById.get(target.recordId) : undefined

  // 打开时焦点进入第一个输入框（到访日期）。
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [])

  // Esc 关闭；提交中不响应。
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  if (!item && !planned) return null

  const nameZh = item ? item.place.nameZh : planned?.city || planned?.city_en || ''
  const nameEn = item ? item.place.nameEn : planned?.city_en || ''
  // planned 记录的国家代码与 plannedRecords 适配器同一回落：记录自带 → display.countryCodes。
  const countryCode = item
    ? item.place.countryCode
    : planned?.country_code || travelAtlasCountryCodes[planned?.country_en ?? ''] || ''
  const countryName = countryCode
    ? regionName(countryCode, locale)
    : name({ nameZh: planned?.country, nameEn: planned?.country_en })
  const entityId = worldGraphSnapshot.memberships.find((member) => {
    if (member.layerId !== WANT_TO_GO_LAYER_ID || member.recordId !== target.recordId) return false
    return (member.metadata?.source === PLANNED_SOURCE) === (target.source === 'planned')
  })?.entityId
  const place = { id: entityId, nameZh, nameEn }
  const displayName = name(place)
  const placeLabel = [displayName, subtitle(place), countryName].filter(Boolean).join(' · ')
  const summary = item
    ? keepWantToGo
      ? t('editor:convertKeep')
      : t('editor:convertRemove')
    : t('editor:convertPlanned')
  const fieldsDisabled = busy || needsReload
  const canSubmit = !fieldsDisabled && Boolean(startDate)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    if (endDate && endDate < startDate) {
      setNotice({ key: 'editor:invalidDates' })
      return
    }

    let input: LocalConvertToTravelInput
    if (item) {
      input = {
        source: 'want-to-go',
        id: item.id,
        startDate,
        endDate: endDate || undefined,
        tripTitle: tripTitle.trim() || undefined,
        keepWantToGo,
      }
    } else if (planned) {
      input = { source: 'planned', recordId: planned.id, startDate, endDate: endDate || undefined }
    } else {
      return
    }

    setBusy(true)
    setNotice({ key: 'editor:saving' })
    try {
      const result = await convertLocalWantToGoToTravel(input)
      onConverted(result)
      reloadAfterLocalSave()
    } catch (error) {
      // 例如城市已在足迹里时服务端返回「这个城市已经在足迹里了……」，不写任何文件（规格 §2 第 3 条）。
      setNotice(editorErrorNotice(error, 'editor:convertFailed'))
      // 部分写入或响应结果无法确认时，先刷新核对，避免重复写入。
      const reloadRequired = requiresEditorReload(error, { afterWrite: true })
      setNeedsReload(reloadRequired)
      const noticeExplainsReload = error instanceof LocalEditorError
        && (error.code === 'E_PARTIAL_WRITE' || error.code === 'E_EDITOR_RESPONSE_INVALID')
      setShowWriteResultWarning(reloadRequired && !noticeExplainsReload)
      setBusy(false)
    }
  }

  return (
    <div
      className="atlas-wtg-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="atlas-wtg-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <header className="atlas-wtg-dialog-header">
          <div className="min-w-0">
            <p>{item ? t('editor:wantToGo') : t('editor:planned')}</p>
            <h2 id={titleId}>{t('editor:visited')}</h2>
            <p className="atlas-convert-place">{placeLabel}</p>
          </div>
          <button
            type="button"
            className="atlas-wtg-dialog-close"
            aria-label={t('editor:closeConvert')}
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <form ref={formRef} className="atlas-local-editor-form atlas-wtg-dialog-form" onSubmit={submit}>
          <p id={summaryId} className="atlas-convert-summary">{summary}</p>

          <div className="atlas-local-editor-form-grid">
            <label className="atlas-local-editor-date-field">
              <span>{t('editor:visitDate')}</span>
              <input
                required
                type="date"
                disabled={fieldsDisabled}
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value)
                  setNotice('')
                }}
              />
            </label>
            <label className="atlas-local-editor-date-field">
              <span>{t('editor:endDate')}</span>
              <input
                type="date"
                disabled={fieldsDisabled}
                min={startDate || undefined}
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value)
                  setNotice('')
                }}
              />
            </label>
          </div>

          {item ? (
            <>
              <label className="atlas-local-editor-date-field">
                <span>{t('editor:tripTitle')}</span>
                <input
                  disabled={fieldsDisabled}
                  value={tripTitle}
                  placeholder={[countryName, displayName].filter(Boolean).join(' · ')}
                  onChange={(event) => setTripTitle(event.target.value)}
                />
              </label>
              <label className="atlas-convert-keep">
                <input
                  type="checkbox"
                  disabled={fieldsDisabled}
                  checked={keepWantToGo}
                  onChange={(event) => setKeepWantToGo(event.target.checked)}
                />
                <span>{t('editor:keepWantToGo')}</span>
              </label>
            </>
          ) : null}

          {notice ? <p className="atlas-local-editor-notice atlas-wtg-dialog-notice" role="status">{notice}</p> : null}
          {showWriteResultWarning ? <p className="atlas-local-editor-notice atlas-wtg-dialog-notice" role="status">{t('editor:writeResultUnknown')}</p> : null}
          {needsReload && coordination.blocked ? <p className="atlas-local-editor-notice atlas-wtg-dialog-notice" role="status">{t(coordination.otherPending ? 'mediaImport:otherPending' : 'mediaImport:otherWriting')}</p> : null}

          {needsReload ? (
            // 被点击的提交按钮已经消失，焦点移到替代它的按钮上，键盘用户不会落到页面顶部。
            // 两个分支都是 <button>，不给不同的 key 时 React 会复用同一个元素，autoFocus 就不会生效。
            <button key="reload" type="button" autoFocus disabled={coordination.blocked} onClick={() => reloadAfterLocalSave()}>{t('editor:reload')}</button>
          ) : (
            <button key="submit" type="submit" disabled={!canSubmit}>{t('editor:visited')}</button>
          )}
        </form>
      </section>
    </div>
  )
}
