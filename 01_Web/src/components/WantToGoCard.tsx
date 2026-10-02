import { editorErrorNotice, localizedConversionReason } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useUiLocale } from '../i18n/useUiLocale'
import { regionName } from '../i18n/placeNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { useId, useState } from 'react'
import { EyeOff, Footprints, Heart, X } from 'lucide-react'
import { localEditorAvailable } from '../data/editorState'
import { reloadAfterLocalSave, updateLocalWantToGo } from '../data/localEditorApi'
import { travelAtlasDataSource } from '../data/travelAtlas'
import { wantToGoCardRecordOf } from '../data/derive/wantToGo'
import {
  plannedConvertBlockReason,
  plannedRecordById,
  wantToGoConvertBlockReason,
  wantToGoDataSource,
  wantToGoItemById,
} from '../data/wantToGo'
import { worldGraphSnapshot } from '../data/worldGraph'
import type { EntityId } from '../worldgraph/types'
import type { ConvertToTravelTarget } from './ConvertToTravelDialog'

type WantToGoCardProps = {
  entityId: EntityId
  onClose: () => void
  /** 「标记为去过」（PR9）：打开 App 里唯一的转换对话框。 */
  onConvertToTravel?: (target: ConvertToTravelTarget) => void
}


/**
 * 想去详情卡（PRD FR-WTG-4 / §9.4），放在右侧栏最上方，与 InfoCard 并存。
 *
 * 卡片收到的是地点的实体 id（RFC-LOC-1 Core-A：实体 id 就是地点 id），一个地点在想去图层可能有几条记录，
 * 卡片只显示一条：有可见的想去条目就显示第一条想去条目，否则显示第一条 planned 记录（wantToGoCardRecordOf），
 * 再按记录 id 查 wantToGoItemById / plannedRecordById；都查不到时不渲染。planned 条目只读（FR-WTG-7），唯一的写入操作是「标记为去过」（PR9）。
 * 「隐藏」只在私人模式、且条目来自私有文件（wantToGoDataSource === 'local'）时渲染（FR-PUB-2）：
 * 样例条目不在私有文件里，隐藏请求必然失败。写入只走 localEditorApi（D26）。
 * 「标记为去过」的门控：想去条目同「隐藏」；planned 条目写的是旅行记录，看 travelAtlasDataSource。
 * 转换对话框收到的是卡片所显示那条记录的 id（想去条目的 id 或 planned 记录的 id），对话框按记录 id 查找。
 */
export function WantToGoCard({ entityId, onClose, onConvertToTravel }: WantToGoCardProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { locale } = useUiLocale()
  const { name, subtitle } = usePlaceNames()
  const convertHintId = useId()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useLocalizedNotice()
  const record = wantToGoCardRecordOf(worldGraphSnapshot.memberships, entityId)
  const item = record?.source === 'want-to-go' ? wantToGoItemById.get(record.recordId) : undefined
  const planned = record?.source === 'planned' ? plannedRecordById.get(record.recordId) : undefined

  if (!item && !planned) return null

  const canWriteItem = Boolean(item) && localEditorAvailable && wantToGoDataSource === 'local'
  const convertSource: ConvertToTravelTarget['source'] | undefined = onConvertToTravel === undefined
    ? undefined
    : item
      ? canWriteItem ? 'want-to-go' : undefined
      : planned && localEditorAvailable && travelAtlasDataSource === 'local' ? 'planned' : undefined
  const convertBlockReason = convertSource === 'want-to-go' && item
    ? wantToGoConvertBlockReason(item)
    : convertSource === 'planned' && planned ? plannedConvertBlockReason(planned) : undefined
  // 「标记为去过」传卡片显示的那条记录的 id（想去条目或 planned 记录）。
  const convertRecordId = item ? item.id : planned?.id

  const nameZh = item ? item.place.nameZh : planned?.city || planned?.city_en || ''
  const nameEn = item ? item.place.nameEn : planned?.city_en || ''
  const place = { id: entityId, nameZh, nameEn }
  const displayName = name(place)
  const originalName = subtitle(place)
  const countryName = item ? regionName(item.place.countryCode, locale) : name({ nameZh: planned?.country, nameEn: planned?.country_en })
  const dateLabel = item ? t('details:added', { date: item.addedAt }) : planned?.start_date ?? ''
  const note = item ? item.note : planned?.notes || undefined

  const hideItem = () => {
    if (!item) return
    setBusy(true)
    setNotice('')
    void updateLocalWantToGo(item.id, { hidden: true })
      .then(reloadAfterLocalSave)
      .catch((error: unknown) => {
        setNotice(editorErrorNotice(error, 'details:hideFailed'))
        setBusy(false)
      })
  }

  return (
    <aside className="atlas-wtg-card glass-panel pointer-events-auto" aria-label={t('details:wantToGoFor', { name: displayName })}>
      <div className="atlas-wtg-card-header">
        <div className="atlas-panel-body min-w-0">
          <p className="atlas-card-eyebrow text-xs font-semibold uppercase tracking-[0.24em] text-white">
            {t('details:wantToGo')}</p>
          <h2 className="atlas-card-title mt-2 text-2xl font-semibold tracking-normal text-slate-950">
            {displayName}
          </h2>
          {originalName ? (
            <p className="mt-1 text-sm font-medium text-slate-600">{originalName}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="atlas-wtg-card-close"
          aria-label={t('details:closeWantToGo')}
          title={t('details:close')}
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

      {planned ? <p className="atlas-wtg-card-readonly">{t('details:readOnlyTravel')}</p> : null}

      {canWriteItem || convertSource ? (
        <div className="atlas-wtg-card-actions">
          {canWriteItem ? (
            <button
              type="button"
              className="atlas-wtg-card-hide"
              disabled={busy}
              onClick={hideItem}
            >
              <EyeOff aria-hidden="true" />
              <span>{busy ? t('details:hiding') : t('details:hide')}</span>
            </button>
          ) : null}
          {convertSource && convertRecordId ? (
            <button
              type="button"
              className="atlas-wtg-card-convert"
              disabled={busy || convertBlockReason !== undefined}
              title={localizedConversionReason(convertBlockReason, t)}
              aria-describedby={convertBlockReason ? convertHintId : undefined}
              onClick={() => onConvertToTravel?.({ source: convertSource, recordId: convertRecordId })}
            >
              <Footprints aria-hidden="true" />
              <span>{t('details:visited')}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {convertBlockReason ? <p id={convertHintId} className="atlas-wtg-card-hint">{localizedConversionReason(convertBlockReason, t)}</p> : null}

      {notice ? <p className="atlas-wtg-card-notice" role="status">{notice}</p> : null}
    </aside>
  )
}
