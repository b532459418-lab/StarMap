import { useState } from 'react'
import { EyeOff, Heart, X } from 'lucide-react'
import { localEditorAvailable } from '../data/editorState'
import { reloadAfterLocalSave, updateLocalWantToGo } from '../data/localEditorApi'
import { plannedRecordByEntityId, wantToGoItemByEntityId } from '../data/wantToGo'
import type { EntityId } from '../worldgraph/types'

type WantToGoCardProps = {
  entityId: EntityId
  onClose: () => void
}

let regionNames: Intl.DisplayNames | undefined | null

/** 两位国家代码 → 中文国家名；环境不支持或代码不认识时回落为代码本身。 */
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
 * 想去详情卡（PRD FR-WTG-4 / §9.4），放在右侧栏最上方，与 InfoCard 并存。
 *
 * 数据只来自 wantToGoItemByEntityId（想去条目）或 plannedRecordByEntityId（planned 旅行记录）；
 * 两边都查不到时不渲染。planned 条目只读（FR-WTG-7）：没有任何操作按钮。
 * 「隐藏」只在私人模式下渲染（FR-PUB-2），写入只走 localEditorApi（D26）。
 */
export function WantToGoCard({ entityId, onClose }: WantToGoCardProps) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const item = wantToGoItemByEntityId.get(entityId)
  const planned = item ? undefined : plannedRecordByEntityId.get(entityId)

  if (!item && !planned) return null

  const nameZh = item ? item.place.nameZh : planned?.city || planned?.city_en || ''
  const nameEn = item ? item.place.nameEn : planned?.city_en || ''
  const countryName = item ? regionNameZh(item.place.countryCode) : planned?.country || planned?.country_en || ''
  const dateLabel = item ? `${item.addedAt} 加入` : planned?.start_date ?? ''
  const note = item ? item.note : planned?.notes || undefined

  const hideItem = () => {
    if (!item) return
    setBusy(true)
    setNotice('')
    void updateLocalWantToGo(item.id, { hidden: true })
      .then(reloadAfterLocalSave)
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : '隐藏失败。')
        setBusy(false)
      })
  }

  return (
    <aside className="atlas-wtg-card glass-panel pointer-events-auto" aria-label={`想去：${nameZh}`}>
      <div className="atlas-wtg-card-header">
        <div className="atlas-panel-body min-w-0">
          <p className="atlas-card-eyebrow text-xs font-semibold uppercase tracking-[0.24em] text-white">
            想去 · Want to Go
          </p>
          <h2 className="atlas-card-title mt-2 text-2xl font-semibold tracking-normal text-slate-950">
            {nameZh}
          </h2>
          {nameEn && nameEn !== nameZh ? (
            <p className="mt-1 text-sm font-medium text-slate-600">{nameEn}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="atlas-wtg-card-close"
          aria-label="关闭想去详情"
          title="关闭"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <p className="atlas-wtg-card-meta">
        <Heart aria-hidden="true" />
        <span>{[countryName, dateLabel].filter(Boolean).join(' · ')}</span>
      </p>

      {note ? <p className="atlas-wtg-card-note">“{note}”</p> : null}

      {planned ? <p className="atlas-wtg-card-readonly">来自旅行记录（只读）</p> : null}

      {item && localEditorAvailable ? (
        <button
          type="button"
          className="atlas-wtg-card-hide"
          disabled={busy}
          onClick={hideItem}
        >
          <EyeOff aria-hidden="true" />
          <span>{busy ? '正在隐藏…' : '隐藏'}</span>
        </button>
      ) : null}

      {notice ? <p className="atlas-wtg-card-notice" role="status">{notice}</p> : null}
    </aside>
  )
}
