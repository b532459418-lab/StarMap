import { useId, useMemo, useState } from 'react'
import { Eye, EyeOff, Heart, LocateFixed, PencilLine, Plus, Search, Trash2 } from 'lucide-react'
import { localEditorAvailable } from '../data/editorState'
import { deleteHiddenLocalWantToGo, reloadAfterLocalSave, updateLocalWantToGo } from '../data/localEditorApi'
import { wantToGoDataSource, wantToGoItemByEntityId } from '../data/wantToGo'
import { PLANNED_SOURCE } from '../worldgraph/adapters/plannedRecords'
import { filterCollection } from '../worldgraph/collection'
import type { CollectionEntry, CollectionSort, CollectionStatusFilter } from '../worldgraph/collection'
import { officialLayers, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'

type CollectionPageProps = {
  /** 想去图层的全部条目（App 用 queryCollection 算好，含已隐藏与无坐标）。 */
  entries: CollectionEntry[]
  /** 「在地图上查看」：只对有坐标且未隐藏的条目调用。 */
  onViewOnMap: (entry: CollectionEntry) => void
  /** 「＋ 添加想去的地方」：打开与图层面板同一个对话框。 */
  onAddWantToGo?: () => void
}

const noteMaxLength = 200

/**
 * 写入是否可用（PR7 规格 §1，沿用 PR6 双重门控）：私人模式的本地编辑器可用，【且】想去数据来自私有文件。
 * 公开构建里 localEditorAvailable 恒为 false，写入控件根本不渲染，不靠 CSS 隐藏（AC-10）。
 */
const writeAvailable = localEditorAvailable && wantToGoDataSource === 'local'

const wantToGoLayer = officialLayers.find((layer) => layer.id === WANT_TO_GO_LAYER_ID)

const statusOptions: { id: CollectionStatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'visible', label: '显示中' },
  { id: 'hidden', label: '已隐藏' },
]

const sortOptions: { id: CollectionSort; label: string }[] = [
  { id: 'recent', label: '最近加入' },
  { id: 'name', label: '名称' },
  { id: 'country', label: '国家' },
]

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

const isFromTravelLog = (entry: CollectionEntry) => entry.readOnly && entry.source === PLANNED_SOURCE

/**
 * Collection 视图（PRD R10，PR7 规格 §3.4）：以列表管理想去图层的全部条目，
 * 包括地图上看不到的（已隐藏、没有坐标、被并进足迹城市的）。
 *
 * 页面按"图层分节"设计，V0.4 只渲染想去一节。搜索、筛选、排序只存在组件 state 里，不持久化。
 * 写入只走 localEditorApi（D26）；成功后整页刷新，失败把错误留在卡片里。
 */
export function CollectionPage({ entries, onViewOnMap, onAddWantToGo }: CollectionPageProps) {
  const searchId = useId()
  const sortId = useId()
  const sectionTitleId = useId()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<CollectionStatusFilter>('all')
  const [sort, setSort] = useState<CollectionSort>('recent')
  const showAdd = writeAvailable && onAddWantToGo !== undefined

  const visibleEntries = useMemo(
    () => filterCollection(entries, { text, status, sort }),
    [entries, sort, status, text],
  )

  const stats = useMemo(() => [
    { value: entries.length, label: 'Total / 全部' },
    { value: entries.filter((entry) => entry.location && !entry.hidden).length, label: 'On map / 地图上' },
    { value: entries.filter((entry) => entry.hidden).length, label: 'Hidden / 已隐藏' },
    { value: entries.filter((entry) => !entry.location).length, label: 'No location / 无坐标' },
    { value: entries.filter(isFromTravelLog).length, label: 'From travel log / 来自旅行记录' },
  ], [entries])

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
      <span>添加想去的地方</span>
    </button>
  ) : null

  return (
    <div className="atlas-journey-scroll selector-scrollbar h-full overflow-y-auto overscroll-contain">
      <div className="atlas-journey-shell mx-auto w-full max-w-7xl px-5 pb-20 sm:px-8">
        <section className="journey-command-panel collection-command-panel">
          <div className="journey-command-copy">
            <p className="journey-kicker">Collection</p>
            <h2>Places you want to go</h2>
            <p>想去图层里的全部地点，包括地图上暂时看不到的。</p>
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
              <span>{wantToGoLayer?.label.zh ?? '想去'}</span>
              <small>{wantToGoLayer?.label.en ?? 'Want to Go'}</small>
            </h3>
            <p className="collection-section-count">
              {visibleEntries.length === entries.length
                ? `${entries.length} 个地点`
                : `${visibleEntries.length} / ${entries.length} 个地点`}
            </p>
          </header>

          <div className="collection-toolbar">
            <div className="collection-search">
              <label htmlFor={searchId} className="sr-only">搜索想去的地方</label>
              <Search aria-hidden="true" />
              <input
                id={searchId}
                type="search"
                value={text}
                placeholder="搜索名称、国家代码或备注"
                onChange={(event) => setText(event.target.value)}
              />
            </div>

            <div className="collection-segmented" role="group" aria-label="按状态筛选">
              {availableStatusOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={status === option.id}
                  onClick={() => setStatus(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="collection-sort">
              <label htmlFor={sortId}>排序</label>
              <select
                id={sortId}
                value={sort}
                onChange={(event) => setSort(event.target.value as CollectionSort)}
              >
                {sortOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </div>

            {addButton}
          </div>

          {entries.length === 0 ? (
            <div className="collection-empty">
              <p>{writeAvailable ? '还没有想去的地方。' : '暂时没有想去的地方。'}</p>
              {addButton}
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="collection-empty">
              <p>没有符合条件的地点。</p>
              <button type="button" className="collection-clear" onClick={clearFilters}>清除筛选</button>
            </div>
          ) : (
            <ul className="collection-grid">
              {visibleEntries.map((entry) => (
                <CollectionCard key={entry.entityId} entry={entry} onViewOnMap={onViewOnMap} />
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
}

function CollectionCard({ entry, onViewOnMap }: CollectionCardProps) {
  const noteId = useId()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')

  const item = wantToGoItemByEntityId.get(entry.entityId)
  const nameZh = entry.title.zh
  const nameEn = entry.title.en
  const fromTravelLog = isFromTravelLog(entry)
  const isSample = item?.source === 'sample'
  // 写入 id 只能来自私有想去文件里的条目；planned 记录查不到，就不渲染任何写入按钮。
  const writableId = writeAvailable && !entry.readOnly ? item?.id : undefined
  const canViewOnMap = entry.location !== undefined && !entry.hidden

  const countryName = entry.countryCode ? regionNameZh(entry.countryCode) : ''
  // planned 记录的日期是计划出发日，不是加入日期（与 WantToGoCard 的写法一致）。
  const dateLabel = fromTravelLog ? entry.addedAt : `${entry.addedAt} 加入`

  const tags: { id: string; label: string }[] = []
  if (entry.subtype === 'country') tags.push({ id: 'country', label: '整个国家' })
  if (entry.hidden) tags.push({ id: 'hidden', label: '已隐藏' })
  if (!entry.location) tags.push({ id: 'no-location', label: '无坐标' })
  if (fromTravelLog) tags.push({ id: 'travel-log', label: '来自旅行记录 · 只读' })
  if (isSample) tags.push({ id: 'sample', label: '样例' })

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
    runWrite(() => updateLocalWantToGo(writableId, { note: noteDraft }), '保存备注失败。')
  }

  const hideEntry = () => {
    if (!writableId) return
    runWrite(() => updateLocalWantToGo(writableId, { hidden: true }), '隐藏失败。')
  }

  const restoreEntry = () => {
    if (!writableId) return
    runWrite(() => updateLocalWantToGo(writableId, { hidden: false }), '恢复失败。')
  }

  const deleteEntry = () => {
    if (!writableId) return
    if (!window.confirm(`确定彻底删除「${nameZh}」吗？此操作无法撤销。`)) return
    runWrite(() => deleteHiddenLocalWantToGo([writableId]), '彻底删除失败。')
  }

  return (
    <li className="collection-card" data-hidden={entry.hidden ? 'true' : 'false'}>
      <div className="collection-card-heading">
        <h4 className="collection-card-title">{nameZh}</h4>
        {nameEn && nameEn !== nameZh ? <p className="collection-card-subtitle">{nameEn}</p> : null}
      </div>

      <p className="collection-card-meta">{[countryName, dateLabel].filter(Boolean).join(' · ')}</p>

      {tags.length > 0 ? (
        <ul className="collection-tags" aria-label={`${nameZh}的标签`}>
          {tags.map((tag) => (
            <li key={tag.id} className="collection-tag" data-tag={tag.id}>{tag.label}</li>
          ))}
        </ul>
      ) : null}

      {editingNote ? (
        <div className="collection-note-editor">
          <label htmlFor={noteId} className="sr-only">{`${nameZh}的备注`}</label>
          <textarea
            id={noteId}
            value={noteDraft}
            maxLength={noteMaxLength}
            rows={3}
            placeholder="为什么想去？"
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
                aria-label={`取消编辑备注：${nameZh}`}
                onClick={() => setEditingNote(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="collection-action collection-action-primary"
                disabled={busy}
                aria-label={`保存备注：${nameZh}`}
                onClick={saveNote}
              >
                {busy ? '正在保存…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : entry.note ? (
        <p className="collection-card-note">“{entry.note}”</p>
      ) : null}

      {canViewOnMap || (writableId && !editingNote) ? (
        <div className="collection-card-actions">
          {canViewOnMap ? (
            <button
              type="button"
              className="collection-action collection-action-primary"
              disabled={busy}
              aria-label={`在地图上查看：${nameZh}`}
              onClick={() => onViewOnMap(entry)}
            >
              <LocateFixed aria-hidden="true" />
              <span>在地图上查看</span>
            </button>
          ) : null}

          {writableId && !editingNote ? (
            <>
              <button
                type="button"
                className="collection-action"
                disabled={busy}
                aria-label={`编辑备注：${nameZh}`}
                onClick={startEditingNote}
              >
                <PencilLine aria-hidden="true" />
                <span>编辑备注</span>
              </button>
              {entry.hidden ? (
                <>
                  <button
                    type="button"
                    className="collection-action"
                    disabled={busy}
                    aria-label={`恢复：${nameZh}`}
                    onClick={restoreEntry}
                  >
                    <Eye aria-hidden="true" />
                    <span>恢复</span>
                  </button>
                  <button
                    type="button"
                    className="collection-action collection-action-danger"
                    disabled={busy}
                    aria-label={`彻底删除：${nameZh}`}
                    onClick={deleteEntry}
                  >
                    <Trash2 aria-hidden="true" />
                    <span>彻底删除</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="collection-action"
                  disabled={busy}
                  aria-label={`隐藏：${nameZh}`}
                  onClick={hideEntry}
                >
                  <EyeOff aria-hidden="true" />
                  <span>隐藏</span>
                </button>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {notice ? <p className="collection-card-notice" role="status">{notice}</p> : null}
    </li>
  )
}
