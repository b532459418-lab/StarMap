import { useEffect, useRef, useState } from 'react'
import { Check, Footprints, Heart, Layers } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { officialLayers } from '../worldgraph/layers'
import type { LayerId } from '../worldgraph/types'
import type { LayerVisibility } from '../data/layerVisibility'

// FR-LR-1 把 icon 存成 lucide 图标【名字】，Core 才能保持不依赖 React。
// 这里是唯一的名字 → 组件映射点。
const layerIcons: Record<string, LucideIcon> = {
  Footprints,
  Heart,
}

// PRD §13 给 PR2 的交付是「Layer Panel（仅足迹条目）」。'want_to_go' 已经在 Registry
// 里注册（FR-LR-1），但它的地图渲染与添加流程属于 PR5——现在就给出开关，会是一个
// 拨动后什么也不会发生的死控件。PR5 把它加进这个数组即可，顺序仍由 order 决定。
const pr2LayerIds: LayerId[] = ['travel']

// FR-LP-5：顺序固定按 Registry 的 order。
const panelLayers = officialLayers
  .filter((layer) => pr2LayerIds.includes(layer.id))
  .sort((left, right) => left.order - right.order)

type LayerPanelProps = {
  visibility: LayerVisibility
  onToggle: (layerId: LayerId, visible: boolean) => void
}

export function LayerPanel({ visibility, onToggle }: LayerPanelProps) {
  const [open, setOpen] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)

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

  return (
    <div ref={shellRef} className="atlas-layer-switcher">
      {open ? (
        <div className="atlas-layer-menu" role="menu" aria-label="地图图层">
          <p>地图图层</p>
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
