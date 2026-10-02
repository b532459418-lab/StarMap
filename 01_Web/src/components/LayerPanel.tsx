import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Footprints, Heart, Layers, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_UI_LOCALE } from '../data/uiLocale'
import { useUiLocale } from '../i18n/useUiLocale'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { editorErrorNotice } from '../i18n/editorErrors'
import { localEditorAvailable } from '../data/editorState'
import { deleteHiddenLocalWantToGo, reloadAfterLocalSave, updateLocalWantToGo } from '../data/localEditorApi'
import { wantToGoDataSource } from '../data/wantToGo'
import { worldGraphSnapshot } from '../data/worldGraph'
import type { WantToGoItem } from '../data/derive/wantToGo'
import { officialLayers, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'
import { PLANNED_SOURCE } from '../worldgraph/adapters/plannedRecords'
import type { LayerId } from '../worldgraph/types'
import type { LayerVisibility } from '../data/layerVisibility'

// FR-LR-1 把 icon 存成 lucide 图标【名字】，Core 才能保持不依赖 React。
// 这里是唯一的名字 → 组件映射点。
const layerIcons: Record<string, LucideIcon> = {
  Footprints,
  Heart,
}

// FR-LP-5：面板列出全部官方图层，顺序固定按 Registry 的 order。
const panelLayers = [...officialLayers].sort((left, right) => left.order - right.order)

// Hidden items keep their record identity; use their registry title only for display.
const wantToGoEntityIds = new Map(worldGraphSnapshot.memberships
  .filter((membership) => membership.layerId === WANT_TO_GO_LAYER_ID
    && membership.metadata?.source !== PLANNED_SOURCE && membership.recordId !== undefined)
  .map((membership) => [membership.recordId, membership.entityId]))

type LayerPanelProps = {
  visibility: LayerVisibility
  onToggle: (layerId: LayerId, visible: boolean) => void
  /** FR-WTG-5：被隐藏的想去条目。只在私人模式（localEditorAvailable）下渲染。 */
  hiddenWantToGoItems?: readonly WantToGoItem[]
  /** FR-LP-3：面板底部「＋ 添加想去的地方」。只在私人模式、且想去数据不是公开样例时渲染。 */
  onAddWantToGo?: () => void
}

export function LayerPanel({ visibility, onToggle, hiddenWantToGoItems = [], onAddWantToGo }: LayerPanelProps) {
  const { t } = useTranslation('mapMenu')
  const { locale } = useUiLocale()
  const { name, subtitle } = usePlaceNames()
  const layerLocale = locale === DEFAULT_UI_LOCALE ? 'zh' : 'en'
  const wantToGoLabel = officialLayers.find((layer) => layer.id === WANT_TO_GO_LAYER_ID)?.label[layerLocale] ?? ''
  const hiddenPlace = (item: WantToGoItem) => ({
    id: wantToGoEntityIds.get(item.id),
    nameZh: item.place.nameZh,
    nameEn: item.place.nameEn,
  })
  const hiddenItemName = (item: WantToGoItem) => name(hiddenPlace(item))
  const hiddenItemNames = (item: WantToGoItem) => {
    const place = hiddenPlace(item)
    return [name(place), subtitle(place)].filter(Boolean).join(' · ')
  }
  const [open, setOpen] = useState(false)
  const [hiddenListOpen, setHiddenListOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useLocalizedNotice()
  const shellRef = useRef<HTMLDivElement>(null)
  const hiddenListId = useId()

  useEffect(() => {
    if (!open) return undefined

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const visibleCount = panelLayers.filter((layer) => visibility[layer.id] !== false).length
  // FR-PUB-2 / AC-10：写入控件以 localEditorAvailable 门控，公开构建里根本不渲染，不靠 CSS 隐藏。
  // 添加入口另有一层数据来源门控：显示样例时（含个人模式下的 ?data=sample）不给写入入口。
  // 私有文件还不存在（'none'）时仍要显示，否则第一条想去永远加不进去。
  const showHiddenItems = localEditorAvailable && hiddenWantToGoItems.length > 0
  const showAddEntry = localEditorAvailable && wantToGoDataSource !== 'sample' && onAddWantToGo !== undefined

  const runHiddenItemAction = (action: () => Promise<unknown>, failureKey: string) => {
    setBusy(true)
    setNotice('')
    void action()
      .then(reloadAfterLocalSave)
      .catch((error: unknown) => {
        // 失败留在面板里说明，不关闭面板。
        setNotice(editorErrorNotice(error, `mapMenu:${failureKey}`))
        setBusy(false)
      })
  }

  const restoreItem = (item: WantToGoItem) => {
    runHiddenItemAction(() => updateLocalWantToGo(item.id, { hidden: false }), 'restoreFailed')
  }

  const deleteItem = (item: WantToGoItem) => {
    if (!window.confirm(t('deleteConfirm', { name: hiddenItemName(item) }))) return
    runHiddenItemAction(() => deleteHiddenLocalWantToGo([item.id]), 'deleteFailed')
  }

  return (
    <div ref={shellRef} className="atlas-layer-switcher">
      {open ? (
        // 弹层本身是普通容器；role="menu" 只包住两个图层开关，这样下面的「已隐藏」与「添加」
        // 可以是普通按钮，而不会成为 menu 里不合法的子元素。
        <div className="atlas-layer-menu">
          <p aria-hidden="true">{t('layers')}</p>
          <div className="atlas-layer-menu-items" role="menu" aria-label={t('layers')}>
            {panelLayers.map((layer) => {
              const Icon = layerIcons[layer.icon]
              const checked = visibility[layer.id] !== false

              return (
                <button
                  key={layer.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  data-active={checked ? 'true' : 'false'}
                  // 多选菜单：点击后【保持打开】以便连续勾选。这是对单选图源菜单
                  // （点完即关）的一处有意偏离，符合 menuitemcheckbox 的 ARIA 惯例。
                  onClick={() => onToggle(layer.id, !checked)}
                >
                  <span className="atlas-layer-icon" style={{ color: layer.accent }} aria-hidden="true">
                    {Icon ? <Icon /> : null}
                  </span>
                  <span className="atlas-layer-copy">
                    <strong>{layer.label[layerLocale]}</strong>
                    <small>{t(checked ? 'shown' : 'hidden')}</small>
                  </span>
                  {checked ? <Check aria-hidden="true" /> : null}
                </button>
              )
            })}
          </div>

          {showHiddenItems ? (
            <div className="atlas-layer-hidden">
              {/* 紧挨在「想去」开关下面（它是 order 最后一层），缩进与图层名对齐。 */}
              <button
                type="button"
                className="atlas-layer-hidden-toggle"
                aria-expanded={hiddenListOpen}
                aria-controls={hiddenListId}
                aria-label={t('hiddenLayerCount', { layer: wantToGoLabel, count: hiddenWantToGoItems.length })}
                onClick={() => setHiddenListOpen((value) => !value)}
              >
                <span>{t('hiddenCount', { count: hiddenWantToGoItems.length })}</span>
                <ChevronDown aria-hidden="true" />
              </button>
              {hiddenListOpen ? (
                <ul id={hiddenListId} className="atlas-layer-hidden-list">
                  {hiddenWantToGoItems.map((item) => (
                    <li key={item.id} className="atlas-layer-hidden-item">
                      <span className="atlas-layer-hidden-label">
                        {hiddenItemNames(item)} · <span className="atlas-layer-hidden-date">{item.addedAt}</span>
                      </span>
                      <span className="atlas-layer-hidden-actions">
                        <button
                          type="button"
                          className="atlas-layer-hidden-restore"
                          disabled={busy}
                          aria-label={t('restorePlace', { name: hiddenItemName(item) })}
                          onClick={() => restoreItem(item)}
                        >
                          {t('restore')}
                        </button>
                        <button
                          type="button"
                          className="atlas-layer-hidden-delete"
                          disabled={busy}
                          aria-label={t('deletePlace', { name: hiddenItemName(item) })}
                          onClick={() => deleteItem(item)}
                        >
                          {t('delete')}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {notice ? <p className="atlas-layer-status" role="status">{notice}</p> : null}
            </div>
          ) : null}

          {showAddEntry ? (
            <>
              <hr className="atlas-layer-divider" />
              <button
                type="button"
                className="atlas-layer-add"
                onClick={() => {
                  setOpen(false)
                  onAddWantToGo()
                }}
              >
                <Plus aria-hidden="true" />
                <span>{t('addWantToGo')}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="atlas-dock-button atlas-layer-button pointer-events-auto"
        aria-label={t('layerSummary', { total: panelLayers.length, visible: visibleCount })}
        aria-expanded={open}
        title={t('layers')}
        onClick={() => setOpen((visible) => !visible)}
      >
        <Layers aria-hidden="true" />
      </button>
    </div>
  )
}
