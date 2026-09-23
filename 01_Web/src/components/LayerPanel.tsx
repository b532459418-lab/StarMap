import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Footprints, Heart, Layers, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { localEditorAvailable } from '../data/editorState'
import { deleteHiddenLocalWantToGo, reloadAfterLocalSave, updateLocalWantToGo } from '../data/localEditorApi'
import { wantToGoDataSource } from '../data/wantToGo'
import type { WantToGoItem } from '../worldgraph/adapters/wantToGo'
import { officialLayers, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'
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

const wantToGoLabel = officialLayers.find((layer) => layer.id === WANT_TO_GO_LAYER_ID)?.label.zh ?? '想去'

type LayerPanelProps = {
  visibility: LayerVisibility
  onToggle: (layerId: LayerId, visible: boolean) => void
  /** FR-WTG-5：被隐藏的想去条目。只在私人模式（localEditorAvailable）下渲染。 */
  hiddenWantToGoItems?: readonly WantToGoItem[]
  /** FR-LP-3：面板底部「＋ 添加想去的地方」。只在私人模式、且想去数据不是公开样例时渲染。 */
  onAddWantToGo?: () => void
}

/** 隐藏项的名字：中文名 · 英文名；中英同名（没填中文名时）只写一次。后面再接加入日期。 */
const hiddenItemNames = (item: WantToGoItem) =>
  item.place.nameZh === item.place.nameEn
    ? item.place.nameZh
    : `${item.place.nameZh} · ${item.place.nameEn}`

export function LayerPanel({ visibility, onToggle, hiddenWantToGoItems = [], onAddWantToGo }: LayerPanelProps) {
  const [open, setOpen] = useState(false)
  const [hiddenListOpen, setHiddenListOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
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

  const runHiddenItemAction = (action: () => Promise<unknown>, failureMessage: string) => {
    setBusy(true)
    setNotice('')
    void action()
      .then(reloadAfterLocalSave)
      .catch((error: unknown) => {
        // 失败留在面板里说明，不关闭面板。
        setNotice(error instanceof Error ? error.message : failureMessage)
        setBusy(false)
      })
  }

  const restoreItem = (item: WantToGoItem) => {
    runHiddenItemAction(() => updateLocalWantToGo(item.id, { hidden: false }), '恢复失败。')
  }

  const deleteItem = (item: WantToGoItem) => {
    if (!window.confirm(`确定彻底删除「${item.place.nameZh}」吗？此操作无法撤销。`)) return
    runHiddenItemAction(() => deleteHiddenLocalWantToGo([item.id]), '彻底删除失败。')
  }

  return (
    <div ref={shellRef} className="atlas-layer-switcher">
      {open ? (
        // 弹层本身是普通容器；role="menu" 只包住两个图层开关，这样下面的「已隐藏」与「添加」
        // 可以是普通按钮，而不会成为 menu 里不合法的子元素。
        <div className="atlas-layer-menu">
          <p aria-hidden="true">地图图层</p>
          <div className="atlas-layer-menu-items" role="menu" aria-label="地图图层">
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
                    <strong>{layer.label.zh}</strong>
                    <small>{checked ? '显示中' : '已隐藏'}</small>
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
                aria-label={`${wantToGoLabel}图层已隐藏 ${hiddenWantToGoItems.length} 项`}
                onClick={() => setHiddenListOpen((value) => !value)}
              >
                <span>已隐藏 {hiddenWantToGoItems.length} 项</span>
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
                          aria-label={`恢复${item.place.nameZh}`}
                          onClick={() => restoreItem(item)}
                        >
                          恢复
                        </button>
                        <button
                          type="button"
                          className="atlas-layer-hidden-delete"
                          disabled={busy}
                          aria-label={`彻底删除${item.place.nameZh}`}
                          onClick={() => deleteItem(item)}
                        >
                          彻底删除
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
                <span>添加想去的地方</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="atlas-dock-button atlas-layer-button pointer-events-auto"
        aria-label={`地图图层，${panelLayers.length} 层中显示 ${visibleCount} 层`}
        aria-expanded={open}
        title="地图图层"
        onClick={() => setOpen((visible) => !visible)}
      >
        <Layers aria-hidden="true" />
      </button>
    </div>
  )
}
