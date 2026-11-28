import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useAppSelector } from '../data/appStore'
import { writeLocalInterest } from '../data/localEditorClient'
import { commonFields, defaultLayerId, interestKindOf, interestKinds, interestPlaceSubtype, interestTemplates,
  type ActivityInput, type InterestInput, type InterestKind, type InterestWrite, type InterestWriteResult, type PlaceChoice, type RowVersion,
} from '../data/interest/templates'
import { fieldText, filterInterests, interestPins, interestTitle, readInterests,
  type InterestFilters, type InterestPin, type InterestRecord,
} from '../data/interest/read'
import { readWikidataInterest } from '../data/interest/wikidata'
import type { StoreEntity } from '../worldgraph/store/types'
import { LocalEditorError } from '../i18n/editorErrors'
import { useUiLocale } from '../i18n/useUiLocale'
import './interestCollection.css'

type Translate = (zh: string, en: string) => string
type Data = ReturnType<typeof readInterests>
type Draft =
  | { mode: 'add'; kind: InterestKind; layerId: string; object?: InterestInput }
  | { mode: 'object'; kind: InterestKind; entity: StoreEntity }
  | { mode: 'activity'; kind: InterestKind; entity: StoreEntity; layerId: string; record?: InterestRecord }
type Blocker = { id: string; table: string; field: string; title?: string; date?: string }

const string = (form: FormData, key: string) => String(form.get(key) ?? '').trim()
const recordFields = (kind: InterestKind) => [...interestTemplates[kind].fields, ...commonFields]
const initialLayer = (kind: InterestKind) => defaultLayerId(kind)
const seenTitle = (item: StoreEntity, tr: Translate) => interestTitle(item, tr('zh', 'en') === 'zh')
const version = ({ id, revision }: RowVersion): RowVersion => ({ id, revision })
const entryStatus = (value: string, kind: InterestKind, tr: Translate): string => {
  if (value === 'done') return tr(interestTemplates[kind].status.zh, interestTemplates[kind].status.en)
  if (value === 'planned') return tr('计划中', 'Planned')
  return tr('已收藏', 'Saved')
}

function PlaceField({ places, label, prefix, defaultValue, tr }: {
  places: Data['places']; label: string; prefix: string; defaultValue?: PlaceChoice; tr: Translate
}) {
  const point = typeof defaultValue === 'object' ? defaultValue : undefined
  const [choice, setChoice] = useState(typeof defaultValue === 'string' ? defaultValue : point ? 'new' : '')
  return <div className="interest-place-field">
    <label>{label}
      <select aria-label={label} name={prefix} value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="">{tr('未设置', 'Unset')}</option>
        {places.map(({ entity }) => <option key={entity.id} value={entity.id}>{seenTitle(entity, tr)}</option>)}
        <option value="new">{tr('新建地点（经纬度）', 'New place (coordinates)')}</option>
      </select>
    </label>
    {choice === 'new' && <div className="interest-form-grid interest-coordinates">
      <label>{tr('地点名称', 'Place name')}<input name={prefix + 'Name'} defaultValue={point?.name} maxLength={250} required /></label>
      <label>{tr('纬度', 'Latitude')}<input name={prefix + 'Lat'} type="number" step="any" min={-90} max={90} defaultValue={point?.lat} required /></label>
      <label>{tr('经度', 'Longitude')}<input name={prefix + 'Lng'} type="number" step="any" min={-180} max={180} defaultValue={point?.lng} required /></label>
    </div>}
  </div>
}

function placeValue(form: FormData, key: string): PlaceChoice | undefined {
  const choice = string(form, key)
  return choice === 'new'
    ? { name: string(form, key + 'Name'), lat: Number(string(form, key + 'Lat')), lng: Number(string(form, key + 'Lng')) }
    : choice || undefined
}

function ObjectFields({ draft, places, tr }: { draft: Extract<Draft, { mode: 'add' | 'object' }>; places: Data['places']; tr: Translate }) {
  const fromImport = draft.mode === 'add' ? draft.object : undefined
  const existing = draft.mode === 'object' ? draft.entity : undefined
  return <fieldset className="interest-form-grid">
    <legend>{tr('对象资料', 'Details')}</legend>
    <label>{tr('名称', 'Name')}<input name="title" defaultValue={fromImport?.title ?? (existing && seenTitle(existing, tr))} required maxLength={250} /></label>
    {recordFields(draft.kind).map((field) => <label key={field.key}>{tr(field.label.zh, field.label.en)}
      <input name={field.key} type={field.kind ?? 'text'} maxLength={2000}
        readOnly={field.key === 'sourceUrl' && Boolean(fromImport?.imported)}
        defaultValue={fromImport?.details[field.key] ?? (existing && fieldText(existing, field.key))} />
    </label>)}
    {draft.kind !== 'movie' && <PlaceField
      places={places} label={tr('对象默认地点', 'Default place')} prefix="objectPlace" tr={tr}
      defaultValue={fromImport?.place ?? (existing && fieldText(existing, 'placeId'))}
    />}
  </fieldset>
}

function ActivityFields({ draft, places, tr }: { draft: Extract<Draft, { mode: 'add' | 'activity' }>; places: Data['places']; tr: Translate }) {
  const existing = draft.mode === 'activity' ? draft.record?.entry : undefined
  const config = interestTemplates[draft.kind]
  return <fieldset className="interest-form-grid">
    <legend>{tr('我的记录', 'My record')}</legend>
    <label>{tr('状态', 'Status')}<select name="status" defaultValue={existing ? fieldText(existing, 'status') : draft.mode === 'add' ? 'saved' : 'done'}>
      <option value="saved">{entryStatus('saved', draft.kind, tr)}</option>
      <option value="planned">{entryStatus('planned', draft.kind, tr)}</option>
      <option value="done">{entryStatus('done', draft.kind, tr)}</option>
    </select></label>
    <label>{tr(config.activity.zh + '日期', config.activity.en + ' date')}<input type="date" name="date" defaultValue={existing && fieldText(existing, 'date')} /></label>
    <label>{tr('我的评分（0–5）', 'My rating (0–5)')}
      <input type="number" min={0} max={5} step="0.1" name="rating" defaultValue={typeof existing?.fields.rating === 'number' ? existing.fields.rating : undefined} />
    </label>
    {draft.kind === 'race' && <label>{tr('完赛成绩', 'Finish time')}<input name="finish" maxLength={2000} defaultValue={existing && fieldText(existing, 'finish')} /></label>}
    <label className="interest-full">{tr('我的评价', 'My notes')}<textarea name="note" maxLength={2000} defaultValue={existing && fieldText(existing, 'note')} /></label>
    <PlaceField places={places} label={draft.kind === 'movie' ? tr('观看地点', 'Viewing place') : tr('本次活动地点', 'Place for this activity')}
      prefix="activityPlace" tr={tr} defaultValue={existing && fieldText(existing, config.placeField)} />
  </fieldset>
}

function InterestEditor({ draft, places, layers, tr, busy, setDraft, onSave, onCancel }: {
  draft: Draft; places: Data['places']; layers: Data['layers']; tr: Translate; busy: boolean
  setDraft: (draft: Draft) => void; onSave: (request: InterestWrite) => void; onCancel: () => void
}) {
  const [link, setLink] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewMessage, setPreviewMessage] = useState('')
  const [fromLink, setFromLink] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const running = useRef<AbortController | undefined>(undefined)
  const config = interestTemplates[draft.kind]
  const preview = async () => {
    if (draft.mode !== 'add' || previewing || !link.trim()) return
    const controller = new AbortController()
    running.current = controller
    setPreviewing(true)
    setPreviewMessage('')
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    try {
      const candidate = await readWikidataInterest(link.trim(), draft.kind, tr('zh', 'en') === 'zh', controller.signal)
      if (candidate) {
        setDraft({ ...draft, object: candidate })
        setFormKey((key) => key + 1)
        setPreviewMessage(tr('已预填 Wikidata 资料，请核对后保存。', 'Wikidata fields are ready to review before saving.'))
      } else {
        setPreviewMessage(tr('此链接或条目类型暂未支持。可以手动填写资料及来源链接。', 'This link or item type is unsupported. Enter its details and source URL manually.'))
      }
    } catch {
      if (running.current === controller) setPreviewMessage(tr('读取来源失败，可以重试或手动填写。', 'The source could not be read. Retry or enter the details manually.'))
    } finally {
      window.clearTimeout(timeout)
      if (running.current === controller) {
        setPreviewing(false)
        running.current = undefined
      }
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (draft.mode === 'activity' || draft.mode === 'add') {
      const rating = string(form, 'rating')
      const activity: ActivityInput = {
        status: string(form, 'status') as ActivityInput['status'], date: string(form, 'date') || undefined,
        note: string(form, 'note'), finish: string(form, 'finish'), place: placeValue(form, 'activityPlace'),
        rating: rating === '' ? undefined : Number(rating),
      }
      if (draft.mode === 'activity') {
        onSave(draft.record
          ? { op: 'edit-activity', entry: version(draft.record.entry), activity }
          : { op: 'add-activity', entity: version(draft.entity), layerId: draft.layerId, activity })
        return
      }
      onSave({
        op: 'add', kind: draft.kind, layerId: draft.layerId, activity,
        object: {
          title: string(form, 'title'), details: Object.fromEntries(recordFields(draft.kind).map(({ key }) => [key, string(form, key)])),
          place: placeValue(form, 'objectPlace'), imported: draft.object?.imported,
        },
      })
    } else {
      onSave({
        op: 'edit-object', entity: version(draft.entity),
        object: {
          title: string(form, 'title'), details: Object.fromEntries(recordFields(draft.kind).map(({ key }) => [key, string(form, key)])),
          place: placeValue(form, 'objectPlace'),
        },
      })
    }
  }
  return <section className="interest-editor" aria-label={tr('兴趣编辑', 'Edit interest')}>
    <h3>{draft.mode === 'add' ? tr('新增兴趣', 'Add interest')
      : draft.mode === 'object' ? tr('编辑对象资料', 'Edit details')
      : draft.record ? tr('编辑这次' + config.activity.zh, 'Edit ' + config.activity.en.toLowerCase())
        : tr('新增一次' + config.activity.zh, 'Add ' + config.activity.en.toLowerCase())}</h3>
    {draft.mode === 'add' && <>
      <div className="interest-toolbar">
        <label>{tr('模板', 'Template')}<select value={draft.kind} disabled={busy || previewing} onChange={(event) => {
          const kind = event.target.value as InterestKind
          setDraft({ mode: 'add', kind, layerId: initialLayer(kind) })
          setFormKey((key) => key + 1)
          setPreviewMessage('')
        }}>
          {interestKinds.map((kind) => <option key={kind} value={kind}>{tr(interestTemplates[kind].title.zh, interestTemplates[kind].title.en)}</option>)}
        </select></label>
        <label>{tr('保存到图层', 'Save to layer')}<select value={draft.layerId} disabled={busy || previewing}
          onChange={(event) => setDraft({ ...draft, layerId: event.target.value })}>
          {!layers.some((layer) => layer.id === initialLayer(draft.kind)) && <option value={initialLayer(draft.kind)}>{tr(config.title.zh, config.title.en)}</option>}
          {layers.filter((layer) => interestKindOf(layer.acceptedEntityTypes[0]) === draft.kind)
            .map((layer) => <option key={layer.id} value={layer.id}>{interestTitle(layer, tr('zh', 'en') === 'zh')}</option>)}
        </select></label>
        <button type="button" aria-expanded={fromLink} onClick={() => setFromLink(!fromLink)}>{tr('从网页预填', 'Fill from a link')}</button>
      </div>
      {fromLink && <div className="interest-preview">
        <label>{tr('Wikidata 链接', 'Wikidata URL')}<input type="url" value={link} onChange={(event) => setLink(event.target.value)} disabled={previewing || busy} /></label>
        <button type="button" onClick={() => void preview()} disabled={!link.trim() || previewing || busy}>
          {previewing ? tr('读取中…', 'Reading…') : tr('读取预填', 'Preview import')}
        </button>
        {previewMessage && <p role="status">{previewMessage}</p>}
      </div>}
    </>}
    <form onSubmit={submit}>
      {draft.mode !== 'activity' && <ObjectFields key={formKey} draft={draft} places={places} tr={tr} />}
      {draft.mode !== 'object' && <ActivityFields key={draft.kind} draft={draft} places={places} tr={tr} />}
      <div className="interest-actions">
        <button type="submit" className="interest-primary" disabled={busy || previewing}>{tr('确认保存', 'Save')}</button>
        <button type="button" disabled={busy} onClick={() => {
          const controller = running.current
          running.current = undefined
          controller?.abort()
          onCancel()
        }}>{tr('取消', 'Cancel')}</button>
      </div>
    </form>
  </section>
}

function InterestCard({ record, tr, onMap, onEditObject, onEditActivity, onAdd, onChange, busy }: {
  record: InterestRecord; tr: Translate; onMap: (pin: InterestPin) => void
  onEditObject: () => void; onEditActivity: () => void; onAdd: () => void
  onChange: (op: 'hide' | 'restore' | 'remove-activity') => void; busy: boolean
}) {
  const { entity, entry, kind, layer, place, hidden } = record
  const title = seenTitle(entity, tr)
  const pins = interestPins([record], tr('zh', 'en') === 'zh')
  const date = fieldText(entry, 'date')
  const note = fieldText(entry, 'note')
  const finish = fieldText(entry, 'finish')
  const source = fieldText(entity, 'sourceUrl')
  const image = fieldText(entity, 'imageUrl')
  const safeLink = (url: string) => /^https:\/\//i.test(url)
  return <article className="interest-card" id={'interest-' + entry.id}>
    <span className="interest-card-layer">{interestTitle(layer, tr('zh', 'en') === 'zh')} · {hidden ? tr('已隐藏', 'Hidden') : entryStatus(fieldText(entry, 'status'), kind, tr)}</span>
    <h3>{title}</h3>
    <p>{[date, place ? seenTitle(place.entity, tr) : tr('未设置地点', 'No place'), typeof entry.fields.rating === 'number' ? entry.fields.rating + ' / 5' : '', finish].filter(Boolean).join(' · ')}</p>
    {note && <p className="interest-note">{note}</p>}
    <details>
      <summary>{tr('资料与来源', 'Details and source')}</summary>
      <dl>{recordFields(kind).filter((field) => !['sourceUrl', 'imageUrl'].includes(field.key) && fieldText(entity, field.key)).map((field) =>
        <div key={field.key}><dt>{tr(field.label.zh, field.label.en)}</dt><dd>{fieldText(entity, field.key)}</dd></div>)}</dl>
      <div className="interest-actions">
        {safeLink(source) && <a href={source} target="_blank" rel="noreferrer">{tr('打开来源', 'Open source')}</a>}
        {safeLink(image) && <a href={image} target="_blank" rel="noreferrer">{tr('查看图片', 'Open image')}</a>}
      </div>
      {fieldText(entity, 'retrievedAt') && <p>{tr('导入时间', 'Imported')} {fieldText(entity, 'retrievedAt').slice(0, 10)}</p>}
    </details>
    <div className="interest-actions">
      {pins[0] && <button type="button" onClick={() => onMap(pins[0])}>{tr('在地图上查看', 'View on map')}</button>}
      <button type="button" disabled={busy} onClick={onEditActivity}>{tr('编辑这条记录', 'Edit this record')}</button>
      <button type="button" disabled={busy} onClick={onAdd}>{tr('新增一次' + interestTemplates[kind].activity.zh, 'Add ' + interestTemplates[kind].activity.en.toLowerCase())}</button>
      <button type="button" disabled={busy} onClick={onEditObject}>{tr('编辑对象', 'Edit object')}</button>
      <button type="button" disabled={busy} onClick={() => onChange(hidden ? 'restore' : 'hide')}>{hidden ? tr('恢复显示', 'Restore') : tr('隐藏', 'Hide')}</button>
      <button type="button" disabled={busy} onClick={() => onChange('remove-activity')}>{tr('删除记录', 'Delete record')}</button>
    </div>
  </article>
}

function InterestLayerOrder({ layers, zh, tr, busy, onSave }: {
  layers: Data['layers']
  zh: boolean
  tr: Translate
  busy: boolean
  onSave: (ids: readonly string[], baseline: readonly string[]) => void
}) {
  const baseline = layers.map(({ id }) => id)
  const [ids, setIds] = useState(() => baseline)
  const [draggedId, setDraggedId] = useState<string>()
  const changed = ids.some((id, index) => id !== baseline[index])
  const layerById = new Map(layers.map((layer) => [layer.id, layer]))
  const move = (id: string, to: number) => {
    setIds((current) => {
      const from = current.indexOf(id)
      if (from < 0 || from === to || to < 0 || to >= current.length) return current
      const next = [...current]
      next.splice(from, 1)
      next.splice(to, 0, id)
      return next
    })
  }

  return <fieldset className="interest-layer-order">
    <legend>{tr('图层顺序', 'Layer order')}</legend>
    <ol aria-label={tr('图层顺序', 'Layer order')}>
      {ids.map((id, index) => {
        const layer = layerById.get(id)
        if (!layer) return null
        const name = interestTitle(layer, zh)
        return <li key={id} draggable={!busy} data-dragging={draggedId === id}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', id)
            setDraggedId(id)
          }}
          onDragOver={(event) => {
            if (!draggedId || busy) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(event) => {
            if (!draggedId || busy) return
            event.preventDefault()
            move(draggedId, index)
            setDraggedId(undefined)
          }}
          onDragEnd={() => setDraggedId(undefined)}>
          <span>{name}</span>
          <button type="button" aria-label={tr('上移 ' + name, 'Move ' + name + ' up')} disabled={busy || index === 0}
            onClick={() => move(id, index - 1)}>↑</button>
          <button type="button" aria-label={tr('下移 ' + name, 'Move ' + name + ' down')} disabled={busy || index === ids.length - 1}
            onClick={() => move(id, index + 1)}>↓</button>
        </li>
      })}
    </ol>
    <div className="interest-actions">
      <button type="button" className="interest-primary" disabled={busy || !changed}
        onClick={() => onSave(ids, baseline)}>{tr('保存图层顺序', 'Save layer order')}</button>
      {changed && <button type="button" disabled={busy} onClick={() => setIds(baseline)}>{tr('取消排序', 'Cancel reordering')}</button>}
    </div>
  </fieldset>
}

export function InterestCollection({ filters, onFilters, onMap, selection }: {
  filters: InterestFilters; onFilters: (filters: InterestFilters) => void; onMap: (pin: InterestPin) => void
  selection?: { id: string }
}) {
  const { locale } = useUiLocale()
  const zh = locale === 'zh-Hans'
  const tr: Translate = (cn, en) => zh ? cn : en
  const model = useAppSelector((snapshot) => snapshot.model)
  const data = useMemo(() => readInterests(model), [model])
  const [draft, setDraft] = useState<Draft>()
  const [sort, setSort] = useState('recent')
  const [list, setList] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [notice, setNotice] = useState<{ error?: boolean; text: string; references?: Blocker[] }>()
  const [manage, setManage] = useState(false)
  const editor = useRef<HTMLDivElement>(null)
  const [draftKey, setDraftKey] = useState(0)
  useEffect(() => {
    if (!selection) return
    const card = document.getElementById('interest-' + selection.id)
    card?.scrollIntoView({ block: 'center' })
    card?.querySelector('button')?.focus({ preventScroll: true })
  }, [selection])
  const start = (next: Draft) => {
    setDraft(next)
    setDraftKey((key) => key + 1)
    setNotice(undefined)
    requestAnimationFrame(() => editor.current?.scrollIntoView({ block: 'start' }))
  }
  const request = async (input: InterestWrite): Promise<InterestWriteResult | undefined> => {
    if (sending.current) return undefined
    sending.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await writeLocalInterest(input)
      setNotice({ text: result.existingMatch ? tr('已有这条收藏。原有资料和个人记录已保留。', 'Already saved. Existing details and personal records were kept.')
        : tr('已保存', 'Saved') })
      return result
    } catch (error) {
      const references = error instanceof LocalEditorError && Array.isArray(error.params.references) ? error.params.references as Blocker[] : undefined
      setNotice({ error: true, text: references ? tr('地点仍被下列记录引用。', 'These records still refer to the place.')
        : error instanceof LocalEditorError && error.code === 'E_STALE'
          ? tr('资料已被修改，请重新打开编辑。草稿仍可复制。', 'The library changed. Reopen the editor. Your draft remains available to copy.')
          : error instanceof Error ? error.message : tr('保存失败', 'Save failed'), references })
      return undefined
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  const saveDraft = async (input: InterestWrite) => {
    const result = await request(input)
    if (result) setDraft(undefined)
  }
  const change = (record: InterestRecord, op: 'hide' | 'restore' | 'remove-activity') => {
    if (op === 'remove-activity' && !window.confirm(tr('删除这条记录？', 'Delete this record?'))) return
    void request({ op, entry: version(record.entry) })
  }
  const changeFilter = (key: keyof InterestFilters, value: string) => onFilters({ ...filters, [key]: value })
  const records = filterInterests(data.records, filters).sort((a, b) => sort === 'name'
    ? seenTitle(a.entity, tr).localeCompare(seenTitle(b.entity, tr), locale)
    : b.entry.updatedAt.localeCompare(a.entry.updatedAt))
  const selectedLayer = data.layers.find((layer) => layer.id === filters.layer)
  const unused = data.entities.filter((entity) => !data.records.some((record) => record.entity.id === entity.id))
  const locationOptions = [...data.places].sort((a, b) => seenTitle(a.entity, tr).localeCompare(seenTitle(b.entity, tr), locale))
  const management = (event: FormEvent<HTMLFormElement>, name: string) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (name === 'new') {
      void request({ op: 'create-layer', kind: string(form, 'kind') as InterestKind, name: string(form, 'name') })
        .then((result) => { if (result) changeFilter('layer', result.id) })
    } else if (selectedLayer) {
      void request({ op: 'rename-layer', layer: version(selectedLayer), name: string(form, 'name') })
    }
  }
  const renderBlocker = (item: Blocker): ReactNode => {
    const record = item.table === 'entries' ? data.records.find(({ entry }) => entry.id === item.id) : undefined
    const entity = item.table === 'entities' ? data.entities.find(({ id }) => id === item.id) : undefined
    const kind = entity && interestKindOf(entity.typeId)
    const field = item.field === 'fields.watchPlaceId' ? tr('观看地点', 'Viewing place')
      : item.field === 'fields.activityPlaceId' ? tr('本次活动地点', 'Activity place')
        : item.field === 'fields.placeId' ? tr('对象默认地点', 'Default place') : item.field
    const text = [item.title ?? item.id, item.date, field].filter(Boolean).join(' · ')
    if (record) return <button type="button" onClick={() => start({
      mode: 'activity', kind: record.kind, entity: record.entity, layerId: record.layer.id, record,
    })}>{text}</button>
    if (kind && entity) return <button type="button" onClick={() => start({ mode: 'object', kind, entity })}>{text}</button>
    return text
  }
  if (model.origin !== 'local') return <div className="interest-shell"><p>{tr('兴趣收藏需要打开个人 SQLite 资料库。', 'Open your personal SQLite library to manage interests.')}</p></div>
  return <section aria-label={tr('兴趣收藏', 'Interest collection')}>
    <div className="interest-shell">
      <header className="interest-header">
        <div><h2>{tr('兴趣收藏', 'Interest collection')}</h2><p>{tr('用同一个收藏管理探店、影视和马拉松。', 'Manage visits, films and races together.')}</p></div>
        <div className="interest-actions">
          <button type="button" className="interest-primary" onClick={() => {
            const kind = (selectedLayer && interestKindOf(selectedLayer.acceptedEntityTypes[0])) ?? 'food'
            start({ mode: 'add', kind, layerId: selectedLayer?.id ?? initialLayer(kind) })
          }} disabled={busy}>{tr('新增兴趣', 'Add interest')}</button>
          <button type="button" onClick={() => setManage(!manage)} aria-expanded={manage}>{tr('管理图层与地点', 'Manage layers and places')}</button>
        </div>
      </header>
      <div className="interest-toolbar interest-filters">
        <label>{tr('搜索', 'Search')}<input value={filters.query} onChange={(event) => changeFilter('query', event.target.value)} /></label>
        <label>{tr('图层', 'Layer')}<select value={filters.layer} onChange={(event) => changeFilter('layer', event.target.value)}>
          <option value="">{tr('全部图层', 'All layers')}</option>
          {data.layers.map((layer) => <option key={layer.id} value={layer.id}>{interestTitle(layer, zh)}</option>)}
        </select></label>
        <label>{tr('状态', 'Status')}<select value={filters.status} onChange={(event) => changeFilter('status', event.target.value)}>
          <option value="">{tr('全部状态', 'All statuses')}</option>
          <option value="saved">{tr('已收藏', 'Saved')}</option><option value="planned">{tr('计划中', 'Planned')}</option>
          <option value="done">{tr('已完成', 'Completed')}</option><option value="hidden">{tr('已隐藏', 'Hidden')}</option>
        </select></label>
        <label>{tr('地点', 'Place')}<select value={filters.location} onChange={(event) => changeFilter('location', event.target.value)}>
          <option value="">{tr('全部地点', 'All places')}</option><option value="none">{tr('未设置地点', 'No place')}</option>
          {locationOptions.map(({ entity }) => <option key={entity.id} value={entity.id}>{seenTitle(entity, tr)}</option>)}
        </select></label>
        <label>{tr('个人记录月份', 'Activity month')}<input type="month" value={filters.date} onChange={(event) => changeFilter('date', event.target.value)} /></label>
        <label>{tr('排序', 'Sort')}<select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="recent">{tr('最近修改', 'Last updated')}</option><option value="name">{tr('名称', 'Name')}</option>
        </select></label>
        <button type="button" aria-pressed={list} onClick={() => setList(!list)}>{list ? tr('切换到卡片', 'Show cards') : tr('切换到列表', 'Show list')}</button>
      </div>
      {notice && <div role={notice.error ? 'alert' : 'status'} className="interest-notice">
        {notice.text}
        {notice.references && <ul>{notice.references.map((item) => <li key={item.id + item.field}>{renderBlocker(item)}</li>)}</ul>}
      </div>}
      {manage && <section className="interest-editor">
        <h3>{tr('图层与地点', 'Layers and places')}</h3>
        <form className="interest-toolbar" onSubmit={(event) => management(event, 'new')}>
          <label>{tr('模板', 'Template')}<select name="kind">{interestKinds.map((kind) => <option key={kind} value={kind}>
            {tr(interestTemplates[kind].title.zh, interestTemplates[kind].title.en)}</option>)}</select></label>
          <label>{tr('新图层名称', 'Layer name')}<input name="name" required maxLength={80} /></label>
          <button type="submit" disabled={busy}>{tr('新建图层', 'Create layer')}</button>
        </form>
        {selectedLayer && <form key={selectedLayer.id} className="interest-toolbar" onSubmit={(event) => management(event, 'rename')}>
          <label>{tr('当前图层名称', 'Selected layer name')}<input name="name" defaultValue={interestTitle(selectedLayer, zh)} required maxLength={80} /></label>
          <button type="submit" disabled={busy}>{tr('重命名图层', 'Rename layer')}</button>
        </form>}
        {data.layers.length > 1 && <InterestLayerOrder key={JSON.stringify(data.layers.map(({ id }) => id))}
          layers={data.layers} zh={zh} tr={tr} busy={busy}
          onSave={(ids, baseline) => { void request({ op: 'order-layers', ids, baseline }) }} />}
        {locationOptions.filter(({ entity }) => entity.fields.subtype === interestPlaceSubtype).map(({ entity }) => <div key={entity.id} className="interest-actions">
          <span>{seenTitle(entity, tr)}</span>
          <button type="button" disabled={busy} onClick={() => {
            if (window.confirm(tr('删除这个地点？', 'Delete this place?'))) void request({ op: 'remove-place', place: version(entity) })
          }}>{tr('删除地点', 'Delete place')}</button>
        </div>)}
      </section>}
      <div ref={editor}>{draft && <InterestEditor key={draftKey} draft={draft} places={locationOptions} layers={data.layers} tr={tr}
        busy={busy} setDraft={setDraft} onSave={(input) => void saveDraft(input)} onCancel={() => setDraft(undefined)} />}</div>
      <div className={list ? 'interest-list' : 'interest-grid'}>
        {records.map((record) => <InterestCard key={record.entry.id} record={record} tr={tr} onMap={onMap} busy={busy}
          onEditObject={() => start({ mode: 'object', entity: record.entity, kind: record.kind })}
          onEditActivity={() => start({ mode: 'activity', entity: record.entity, kind: record.kind, layerId: record.layer.id, record })}
          onAdd={() => start({ mode: 'activity', entity: record.entity, kind: record.kind, layerId: record.layer.id })}
          onChange={(op) => change(record, op)} />)}
      </div>
      {!records.length && <p className="interest-empty">{tr('没有匹配的个人记录。', 'No matching records.')}</p>}
      {manage && unused.length > 0 && <section className="interest-editor">
        <h3>{tr('没有个人记录的对象', 'Objects without records')}</h3>
        {unused.map((entity) => <div key={entity.id} className="interest-actions">
          <span>{seenTitle(entity, tr)}</span>
          <button type="button" disabled={busy} onClick={() => {
            const kind = interestKindOf(entity.typeId)
            if (kind) start({ mode: 'activity', kind, entity, layerId: initialLayer(kind) })
          }}>{tr('新增个人记录', 'Add a record')}</button>
          <button type="button" disabled={busy} onClick={() => {
            if (window.confirm(tr('删除这个对象？', 'Delete this object?'))) void request({ op: 'remove-object', entity: version(entity) })
          }}>{tr('删除对象', 'Delete object')}</button>
        </div>)}
      </section>}
    </div>
  </section>
}
