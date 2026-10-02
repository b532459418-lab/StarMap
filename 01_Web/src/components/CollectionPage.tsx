import { useId, useMemo, useState } from 'react'
import { Eye, EyeOff, Footprints, Heart, LocateFixed, PencilLine, Plus, Search, Trash2 } from 'lucide-react'
import { localEditorAvailable } from '../data/editorState'
import { deleteHiddenLocalWantToGo, reloadAfterLocalSave, updateLocalWantToGo } from '../data/localEditorApi'
import { travelAtlasDataSource } from '../data/travelAtlas'
import {
  plannedConvertBlockReason,
  plannedRecordById,
  wantToGoConvertBlockReason,
  wantToGoDataSource,
  wantToGoItemById,
} from '../data/wantToGo'
import { PLANNED_SOURCE } from '../worldgraph/adapters/plannedRecords'
import { filterCollection } from '../worldgraph/collection'
import { originalNameSubtitle, resolveName } from '../worldgraph/localizedText'
import { useUiLocale } from '../i18n/useUiLocale'
import { useTranslation } from 'react-i18next'
import type { CollectionEntry, CollectionSort, CollectionStatusFilter } from '../worldgraph/collection'
import { officialLayers, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'
import type { ConvertToTravelTarget } from './ConvertToTravelDialog'

type CollectionPageProps = {
  /** 想去图层的全部条目（App 用 queryCollection 算好，含已隐藏与无坐标）。 */
  entries: CollectionEntry[]
  /** 「在地图上查看」：只对有坐标且未隐藏的条目调用。 */
  onViewOnMap: (entry: CollectionEntry) => void
  /** 「＋ 添加想去的地方」：打开与图层面板同一个对话框。 */
  onAddWantToGo?: () => void
  /** 「标记为去过」（PR9）：打开 App 里唯一的转换对话框。 */
  onConvertToTravel?: (target: ConvertToTravelTarget) => void
}

const noteMaxLength = 200

/**
 * 写入是否可用（PR7 规格 §1，沿用 PR6 双重门控）：私人模式的本地编辑器可用，【且】想去数据来自私有文件。
 * 公开构建与强制样例下 localEditorAvailable 恒为 false，写入控件根本不渲染，不靠 CSS 隐藏（AC-10）。
 */
const writeAvailable = localEditorAvailable && wantToGoDataSource === 'local'

/**
 * 添加是否可用：与图层面板的添加入口同一规则（只排除样例）。私有想去文件还不存在（'none'）时
 * 也要能添加，否则第一次使用的人在 Collection 里加不进第一条。其余写入仍用上面更严的 writeAvailable。
 */
const addAvailable = localEditorAvailable && wantToGoDataSource !== 'sample'

/**
 * planned 条目「标记为去过」的门控（PR9 规格 §3.6）：写的是旅行记录，所以看足迹的数据来源，
 * 而不是想去的。强制样例模式下 travelAtlasDataSource 恒为 'sample'。
 */
const plannedConvertAvailable = localEditorAvailable && travelAtlasDataSource === 'local'

const wantToGoLayer = officialLayers.find((layer) => layer.id === WANT_TO_GO_LAYER_ID)

const statusOptions: { id: CollectionStatusFilter }[] = [
  { id: 'all' }, { id: 'visible' }, { id: 'hidden' },
]
const sortOptions: { id: CollectionSort }[] = [
  { id: 'recent' }, { id: 'name' }, { id: 'country' },
]
const regionNames = new Map<string, Intl.DisplayNames>()
const regionName = (countryCode: string, locale: string) => {
  try {
    let names = regionNames.get(locale)
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: 'region' })
      regionNames.set(locale, names)
    }
    return names.of(countryCode) ?? countryCode
  } catch { return countryCode }
}

const isFromTravelLog = (entry: CollectionEntry) => entry.readOnly && entry.source === PLANNED_SOURCE

/** 列表里每一行的 key：同一实体在想去图层可以有几条记录，所以连同 recordId 一起（与 Core 的成员关系去重键同一口径）。 */
const collectionEntryKey = (entry: CollectionEntry) => JSON.stringify([entry.entityId, entry.recordId ?? ''])

/**
 * Collection 视图（PRD R10，PR7 规格 §3.4）：以列表管理想去图层的全部条目，
 * 包括地图上看不到的（已隐藏、没有坐标、被并进足迹城市的）。
 *
 * 页面按"图层分节"设计，V0.4 只渲染想去一节。搜索、筛选、排序只存在组件 state 里，不持久化。
 * 写入只走 localEditorApi（D26）；成功后整页刷新，失败把错误留在卡片里。
 */
export function CollectionPage({ entries, onViewOnMap, onAddWantToGo, onConvertToTravel }: CollectionPageProps) {
  const { locale } = useUiLocale()
  const { t } = useTranslation('collection')
  const searchId = useId()
  const sortId = useId()
  const sectionTitleId = useId()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<CollectionStatusFilter>('all')
  const [sort, setSort] = useState<CollectionSort>('recent')
  const showAdd = addAvailable && onAddWantToGo !== undefined

  const visibleEntries = useMemo(
    () => filterCollection(entries, { text, status, sort }, locale),
    [entries, locale, sort, status, text],
  )

  const stats = useMemo(() => [
    { value: entries.length, label: t('total') },
    { value: entries.filter((entry) => entry.location && !entry.hidden).length, label: t('onMap') },
    { value: entries.filter((entry) => entry.hidden).length, label: t('hidden') },
    { value: entries.filter((entry) => !entry.location).length, label: t('noLocation') },
    { value: entries.filter(isFromTravelLog).length, label: t('fromTravelLog') },
  ], [entries, t])

  // 公开样例没有隐藏项：写入不可用时只给「全部 / 显示中」。
  const availableStatusOptions = writeAvailable
    ? statusOptions
    : statusOptions.filter((option) => option.id !== 'hidden')

  const clearFilters = () => {
    setText('')
    setStatus('all')
  }

  const addButton = showAdd ? (
    <button type="button" className="collection-add" onClick={onAddWantToGo}>
      <Plus aria-hidden="true" />
      <span>{t('add')}</span>
    </button>
  ) : null

  return (
    <div className="atlas-journey-scroll selector-scrollbar h-full overflow-y-auto overscroll-contain">
      <div className="atlas-journey-shell mx-auto w-full max-w-7xl px-5 pb-20 sm:px-8">
        <section className="journey-command-panel collection-command-panel">
          <div className="journey-command-copy">
            <p className="journey-kicker">{t('title')}</p>
            <h2>{t('heading')}</h2>
            <p>{t('description')}</p>
          </div>

          <div className="journey-stats-grid collection-stats-grid">
            {stats.map((stat) => (
              <div key={stat.label} className="journey-stat-card">
                <p className="journey-stat-value">{stat.value}</p>
                <p className="journey-stat-label">{stat.label}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="collection-section" aria-labelledby={sectionTitleId}>
          <header className="collection-section-header">
            <h3 id={sectionTitleId}>
              <Heart aria-hidden="true" style={{ color: wantToGoLayer?.accent }} />
              <span>{t('wantToGo')}</span>
            </h3>
            <p className="collection-section-count">
              {visibleEntries.length === entries.length
                ? t('places', { count: entries.length })
                : t('filteredPlaces', { visible: visibleEntries.length, count: entries.length })}
            </p>
          </header>

          <div className="collection-toolbar">
            <div className="collection-search">
              <label htmlFor={searchId} className="sr-only">{t('search')}</label>
              <Search aria-hidden="true" />
              <input
                id={searchId}
                type="search"
                value={text}
                placeholder={t('searchPlaceholder')}
                onChange={(event) => setText(event.target.value)}
              />
            </div>

            <div className="collection-segmented" role="group" aria-label={t('status')}>
              {availableStatusOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={status === option.id}
                  onClick={() => setStatus(option.id)}
                >
                  {t(option.id)}
                </button>
              ))}
            </div>

            <div className="collection-sort">
              <label htmlFor={sortId}>{t('sort')}</label>
              <select
                id={sortId}
                value={sort}
                onChange={(event) => setSort(event.target.value as CollectionSort)}
              >
                {sortOptions.map((option) => (
                  <option key={option.id} value={option.id}>{t(option.id)}</option>
                ))}
              </select>
            </div>

            {addButton}
          </div>

          {entries.length === 0 ? (
            <div className="collection-empty">
              <p>{t(showAdd ? 'emptyEditable' : 'empty')}</p>
              {addButton}
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="collection-empty">
              <p>{t('noResults')}</p>
              <button type="button" className="collection-clear" onClick={clearFilters}>{t('clear')}</button>
            </div>
          ) : (
            <ul className="collection-grid">
              {visibleEntries.map((entry) => (
                <CollectionCard
                  key={collectionEntryKey(entry)}
                  entry={entry}
                  onViewOnMap={onViewOnMap}
                  onConvertToTravel={onConvertToTravel}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

type CollectionCardProps = {
  entry: CollectionEntry
  onViewOnMap: (entry: CollectionEntry) => void
  onConvertToTravel?: (target: ConvertToTravelTarget) => void
}

function CollectionCard({ entry, onViewOnMap, onConvertToTravel }: CollectionCardProps) {
  const { locale } = useUiLocale()
  const { t } = useTranslation('collection')
  const noteId = useId()
  const convertHintId = useId()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')

  const fromTravelLog = isFromTravelLog(entry)
  // 按这一行背后的记录 id 查（Core 方案 C3）：想去条目只查想去表，planned 条目只查 planned 表。
  const item = !fromTravelLog && entry.recordId !== undefined ? wantToGoItemById.get(entry.recordId) : undefined
  const planned = fromTravelLog && entry.recordId !== undefined ? plannedRecordById.get(entry.recordId) : undefined
  const name = resolveName(entry.title, locale)
  const subtitle = originalNameSubtitle(entry.title, locale)
  const isSample = item?.source === 'sample'
  // 写入 id 只能来自私有想去文件里的条目；planned 记录查不到，就不渲染任何写入按钮。
  const writableId = writeAvailable && !entry.readOnly ? item?.id : undefined
  const canViewOnMap = entry.location !== undefined && !entry.hidden

  // 「标记为去过」（PR9 规格 §3.6）：未隐藏的想去条目看想去的写入门控，planned 条目看足迹的写入门控。
  // 整个国家 / 无坐标的条目仍显示按钮，但禁用并写明原因。
  const convertSource: ConvertToTravelTarget['source'] | undefined = onConvertToTravel === undefined
    ? undefined
    : writableId && item && !entry.hidden
      ? 'want-to-go'
      : planned && plannedConvertAvailable ? 'planned' : undefined
  const convertBlockReason = convertSource === 'want-to-go' && item
    ? wantToGoConvertBlockReason(item)
    : convertSource === 'planned' && planned ? plannedConvertBlockReason(planned) : undefined
  // 「标记为去过」传这一行背后那条记录的 id。
  const convertRecordId = convertSource === 'want-to-go' ? item?.id : convertSource === 'planned' ? planned?.id : undefined
  const showConvert = convertSource !== undefined && !editingNote

  const countryName = entry.countryCode ? regionName(entry.countryCode, locale) : ''
  // planned 记录的日期是计划出发日，不是加入日期（与 WantToGoCard 的写法一致）。
  const dateLabel = fromTravelLog ? entry.addedAt : t('added', { date: entry.addedAt })

  const tags: { id: string; label: string }[] = []
  if (entry.subtype === 'country') tags.push({ id: 'country', label: t('wholeCountry') })
  if (entry.hidden) tags.push({ id: 'hidden', label: t('hidden') })
  if (!entry.location) tags.push({ id: 'no-location', label: t('noLocation') })
  if (fromTravelLog) tags.push({ id: 'travel-log', label: t('readOnlyTravel') })
  if (isSample) tags.push({ id: 'sample', label: t('sample') })

  const runWrite = (action: () => Promise<unknown>, failureMessage: string) => {
    setBusy(true)
    setNotice('')
    void action()
      .then(reloadAfterLocalSave)
      .catch((error: unknown) => {
        // 失败留在卡片里说明，不刷新。
        setNotice(error instanceof Error ? error.message : failureMessage)
        setBusy(false)
      })
  }

  const startEditingNote = () => {
    setNoteDraft(entry.note ?? '')
    setNotice('')
    setEditingNote(true)
  }

  const saveNote = () => {
    if (!writableId) return
    // 空串即删除备注（端点负责 trim 与删除）。
    runWrite(() => updateLocalWantToGo(writableId, { note: noteDraft }), t('saveFailed'))
  }

  const hideEntry = () => {
    if (!writableId) return
    runWrite(() => updateLocalWantToGo(writableId, { hidden: true }), t('hideFailed'))
  }

  const restoreEntry = () => {
    if (!writableId) return
    runWrite(() => updateLocalWantToGo(writableId, { hidden: false }), t('restoreFailed'))
  }

  const deleteEntry = () => {
    if (!writableId) return
    if (!window.confirm(t('deleteConfirm', { name }))) return
    runWrite(() => deleteHiddenLocalWantToGo([writableId]), t('deleteFailed'))
  }

  return (
    <li className="collection-card" data-hidden={entry.hidden ? 'true' : 'false'}>
      <div className="collection-card-heading">
        <h4 className="collection-card-title">{name}</h4>
        {subtitle ? <p className="collection-card-subtitle">{subtitle}</p> : null}
      </div>

      <p className="collection-card-meta">{[countryName, dateLabel].filter(Boolean).join(' · ')}</p>

      {tags.length > 0 ? (
        <ul className="collection-tags" aria-label={t('tags', { name })}>
          {tags.map((tag) => (
            <li key={tag.id} className="collection-tag" data-tag={tag.id}>{tag.label}</li>
          ))}
        </ul>
      ) : null}

      {editingNote ? (
        <div className="collection-note-editor">
          <label htmlFor={noteId} className="sr-only">{t('note', { name })}</label>
          <textarea
            id={noteId}
            value={noteDraft}
            maxLength={noteMaxLength}
            rows={3}
            placeholder={t('notePlaceholder')}
            disabled={busy}
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className="collection-note-footer">
            <small>{noteDraft.length}/{noteMaxLength}</small>
            <div className="collection-note-buttons">
              <button
                type="button"
                className="collection-action"
                disabled={busy}
                aria-label={t('cancelNoteFor', { name })}
                onClick={() => setEditingNote(false)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="collection-action collection-action-primary"
                disabled={busy}
                aria-label={t('saveNoteFor', { name })}
                onClick={saveNote}
              >
                {t(busy ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        </div>
      ) : entry.note ? (
        <p className="collection-card-note">“{entry.note}”</p>
      ) : null}

      {canViewOnMap || showConvert || (writableId && !editingNote) ? (
        <div className="collection-card-actions">
          {canViewOnMap ? (
            <button
              type="button"
              className="collection-action collection-action-primary"
              disabled={busy}
              aria-label={t('viewFor', { name })}
              onClick={() => onViewOnMap(entry)}
            >
              <LocateFixed aria-hidden="true" />
              <span>{t('view')}</span>
            </button>
          ) : null}

          {showConvert && convertSource && convertRecordId ? (
            <button
              type="button"
              className="collection-action"
              data-blocked={convertBlockReason ? 'true' : undefined}
              disabled={busy || convertBlockReason !== undefined}
              title={convertBlockReason}
              aria-label={t('visitedFor', { name })}
              aria-describedby={convertBlockReason ? convertHintId : undefined}
              onClick={() => onConvertToTravel?.({ source: convertSource, recordId: convertRecordId })}
            >
              <Footprints aria-hidden="true" />
              <span>{t('visited')}</span>
            </button>
          ) : null}

          {writableId && !editingNote ? (
            <>
              <button
                type="button"
                className="collection-action"
                disabled={busy}
                aria-label={t('editNoteFor', { name })}
                onClick={startEditingNote}
              >
                <PencilLine aria-hidden="true" />
                <span>{t('editNote')}</span>
              </button>
              {entry.hidden ? (
                <>
                  <button
                    type="button"
                    className="collection-action"
                    disabled={busy}
                    aria-label={t('restoreFor', { name })}
                    onClick={restoreEntry}
                  >
                    <Eye aria-hidden="true" />
                    <span>{t('restore')}</span>
                  </button>
                  <button
                    type="button"
                    className="collection-action collection-action-danger"
                    disabled={busy}
                    aria-label={t('deleteFor', { name })}
                    onClick={deleteEntry}
                  >
                    <Trash2 aria-hidden="true" />
                    <span>{t('delete')}</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="collection-action"
                  disabled={busy}
                  aria-label={t('hideFor', { name })}
                  onClick={hideEntry}
                >
                  <EyeOff aria-hidden="true" />
                  <span>{t('hide')}</span>
                </button>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {showConvert && convertBlockReason ? (
        <p id={convertHintId} className="collection-card-hint">{convertBlockReason}</p>
      ) : null}

      {notice ? <p className="collection-card-notice" role="status">{notice}</p> : null}
    </li>
  )
}
