import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { X } from 'lucide-react'
import { convertLocalWantToGoToTravel, reloadAfterLocalSave } from '../data/localEditorApi'
import type { LocalConvertToTravelInput, LocalConvertToTravelResult } from '../data/localEditorApi'
import { travelAtlasCountryCodes } from '../data/travelAtlas'
import { plannedRecordByEntityId, wantToGoItemByEntityId } from '../data/wantToGo'
import type { EntityId } from '../worldgraph/types'

/** 要转换的条目：想去条目，或来自旅行记录的 planned 条目（FR-WTG-7）。 */
export type ConvertToTravelTarget =
  | { source: 'want-to-go'; entityId: EntityId }
  | { source: 'planned'; entityId: EntityId }

type ConvertToTravelDialogProps = {
  /** undefined 表示对话框关闭。 */
  target?: ConvertToTravelTarget
  onClose: () => void
  /** 转换成功、刷新之前调用：App 在这里写视图状态，刷新后直接落在新城市上（PR9 规格 §2 第 8 条）。 */
  onConverted: (result: LocalConvertToTravelResult) => void
}

let regionNames: Intl.DisplayNames | undefined | null

/** 两位国家代码 → 中文国家名；环境不支持或代码不认识时回落为代码本身（与 WantToGoCard 同一规则）。 */
const regionNameZh = (countryCode: string) => {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
    } catch {
      regionNames = null
    }
  }
  try {
    return regionNames?.of(countryCode) ?? countryCode
  } catch {
    return countryCode
  }
}

/**
 * 「标记为去过」对话框（PRD S5 / R13，PR9 规格 §3.5）。只在私人模式下由 App 挂载一份。
 *
 * 想去条目：在足迹中新增这座城市，默认从想去列表移除（可勾选保留，表示还想再去）。
 * planned 条目：把这条旅行计划改为已去过。两种都只调用 localEditorApi 的同一个封装（D26）。
 *
 * 日期一律由用户填写，不预填今天。关闭时整个内容卸载，下次打开是一张干净的表单；
 * 成功后整页刷新，失败把服务端的 error 留在对话框里，不关闭（与 WantToGoAddDialog 相同）。
 */
export function ConvertToTravelDialog({ target, onClose, onConverted }: ConvertToTravelDialogProps) {
  return target ? (
    <ConvertToTravelDialogContent
      key={`${target.source}:${target.entityId}`}
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
  const titleId = useId()
  const summaryId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [tripTitle, setTripTitle] = useState('')
  const [keepWantToGo, setKeepWantToGo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const item = target.source === 'want-to-go' ? wantToGoItemByEntityId.get(target.entityId) : undefined
  const planned = target.source === 'planned' ? plannedRecordByEntityId.get(target.entityId) : undefined

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
    ? regionNameZh(countryCode.toUpperCase())
    : planned?.country || planned?.country_en || ''
  const placeLabel = [nameZh, nameEn && nameEn !== nameZh ? nameEn : '', countryName].filter(Boolean).join(' · ')
  const summary = item
    ? keepWantToGo
      ? '会在足迹中新增这座城市，想去条目会保留。'
      : '会在足迹中新增这座城市，并从想去列表移除。'
    : '这条旅行计划会改为已去过，日期以你填写的为准。'
  const canSubmit = !busy && Boolean(startDate)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    if (endDate && endDate < startDate) {
      setNotice('结束日期不能早于到访日期。')
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
    setNotice('正在保存…')
    try {
      const result = await convertLocalWantToGoToTravel(input)
      onConverted(result)
      reloadAfterLocalSave()
    } catch (error) {
      // 例如城市已在足迹里时服务端返回「这个城市已经在足迹里了……」，不写任何文件（规格 §2 第 3 条）。
      setNotice(error instanceof Error ? error.message : '标记为去过失败。')
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
            <p>{item ? '想去 · Want to Go' : '旅行计划 · Planned'}</p>
            <h2 id={titleId}>标记为去过</h2>
            <p className="atlas-convert-place">{placeLabel}</p>
          </div>
          <button
            type="button"
            className="atlas-wtg-dialog-close"
            aria-label="关闭标记为去过"
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
              <span>到访日期</span>
              <input
                required
                type="date"
                disabled={busy}
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value)
                  setNotice('')
                }}
              />
            </label>
            <label className="atlas-local-editor-date-field">
              <span>结束日期（可选）</span>
              <input
                type="date"
                disabled={busy}
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
                <span>行程标题（可选）</span>
                <input
                  disabled={busy}
                  value={tripTitle}
                  placeholder={[countryName, nameZh].filter(Boolean).join(' · ')}
                  onChange={(event) => setTripTitle(event.target.value)}
                />
              </label>
              <label className="atlas-convert-keep">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={keepWantToGo}
                  onChange={(event) => setKeepWantToGo(event.target.checked)}
                />
                <span>保留在想去列表（还想再去）</span>
              </label>
            </>
          ) : null}

          {notice ? <p className="atlas-local-editor-notice atlas-wtg-dialog-notice" role="status">{notice}</p> : null}

          <button type="submit" disabled={!canSubmit}>标记为去过</button>
        </form>
      </section>
    </div>
  )
}
