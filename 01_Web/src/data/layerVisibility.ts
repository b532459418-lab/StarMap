import { officialLayers } from '../worldgraph/layers'
import type { LayerId } from '../worldgraph/types'

/**
 * 图层可见性偏好（PRD v0.4 FR-LP-4）。
 *
 * 放在 src/data/ 而不是 src/worldgraph/：本模块要读写 window.localStorage，
 * 放进 Core 会当场违反 PR2 自己新增的 FR-MOD 边界。它与 viewState.ts 同层同形——
 * 区别是 viewState 用 sessionStorage 存"我刚才看到哪"，本模块用 localStorage 存
 * 跨会话的用户偏好；FR-LP-4 明确要求不得混进 viewState，也不得进 editor-state.local.json。
 *
 * 存储结构固定为 { visible: Record<LayerId, boolean> }（FR-LP-4 原文），
 * 所以 key 带 :v1 后缀，与 viewState 的 JSON 值保持同一约定。
 */
export type LayerVisibility = Record<LayerId, boolean>

const layerVisibilityKey = 'starmap:layers:v1'

// 每次现造一个新对象。默认值绝不能是共享的模块级常量——调用方改一次，
// 下一次读到的"默认值"就已经被污染了。
const defaultLayerVisibility = (): LayerVisibility => {
  const visible = {} as LayerVisibility
  for (const layer of officialLayers) visible[layer.id] = layer.defaultVisible
  return visible
}

export const getInitialLayerVisibility = (): LayerVisibility => {
  if (typeof window === 'undefined') return defaultLayerVisibility()

  try {
    // getItem 不存在时返回 null，而 JSON.parse(null) === null 并不抛错，
    // 所以必须先兜一个 '{}'，再自己判断形状（typeof null === 'object'，数组也是 object）。
    const raw = JSON.parse(window.localStorage.getItem(layerVisibilityKey) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultLayerVisibility()

    const stored = (raw as { visible?: unknown }).visible
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaultLayerVisibility()

    // 以 Registry 为迭代源，而不是 Object.keys(stored)：
    // 将来新增的 Layer 会拿到它自己的 defaultVisible，已删除的 Layer 不会被存档复活，
    // 非布尔值（被手改过的 storage）一律当作缺失处理。
    const visible = defaultLayerVisibility()
    for (const layer of officialLayers) {
      const value = (stored as Record<string, unknown>)[layer.id]
      if (typeof value === 'boolean') visible[layer.id] = value
    }
    return visible
  } catch {
    return defaultLayerVisibility()
  }
}

export const rememberLayerVisibility = (visibility: LayerVisibility) => {
  if (typeof window === 'undefined') return

  try {
    // 全量写入所有已知 id：存储内容自描述，读回时也不依赖调用方传了多少键。
    const visible = defaultLayerVisibility()
    for (const layer of officialLayers) {
      const value = visibility[layer.id]
      if (typeof value === 'boolean') visible[layer.id] = value
    }
    window.localStorage.setItem(layerVisibilityKey, JSON.stringify({ visible }))
  } catch {
    // 存储被禁用时开关在本次会话内照常工作，只是不跨会话保留。
  }
}
