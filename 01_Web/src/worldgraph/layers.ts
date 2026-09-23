/**
 * Layer Registry —— V0.4 的两个官方 Layer（PRD v0.1 FR-LR-1 / FR-LR-2）。
 *
 * 【纯数据，环境无关】本文件属于 World Graph Core（`src/worldgraph/**`），
 * 受 eslint 的 FR-MOD 边界约束（见 eslint.config.js 末尾）：不得 import
 * `src/components/**` 或 `src/data/travelAtlas.ts`，也不得使用 import.meta。
 * `icon` 只存 lucide 图标【名字】而不是组件，正是为了让 Core 不依赖 React 与浏览器；
 * 名字到组件的映射是 UI 侧的事（src/components/LayerPanel.tsx）。
 *
 * FR-LR-2：Registry 只注册这两个，且【不】提供运行时注册 API——Custom Layer 是 0.6+。
 * 因此 officialLayers 声明为 readonly 数组，避免它退化成一个事实上的注册入口。
 *
 * 语法约束同 types.ts：erasable-only TypeScript（只用 type / interface，
 * 不用 enum / namespace / 参数属性）。
 */

import type { LayerId, RelationType } from './types.ts'

/** Travel 官方图层的 id。全仓库只在这里声明一次，适配器与查询都从这里引用。 */
export const TRAVEL_LAYER_ID: LayerId = 'travel'

/** Want to Go 官方图层的 id。想去条目与 planned 记录共用这一个图层，只是来源不同。 */
export const WANT_TO_GO_LAYER_ID: LayerId = 'want_to_go'

export interface LayerDefinition {
  id: LayerId
  label: { zh: string; en: string }
  /** lucide 图标名，与底部 dock 现有风格一致。 */
  icon: string
  /** 该图层标记的主色。 */
  accent: string
  defaultVisible: boolean
  /** FR-LP-5：V0.4 的面板顺序固定按它排；拖动排序是 R12。 */
  order: number
  /** 该图层在地图上画哪些 place subtype。足迹只画城市（国家没有标记）；想去画城市与国家（PRD Q5）。 */
  mapSubtypes: readonly ('city' | 'country' | 'region')[]
  /**
   * D21：地图归属的默认规则。'self' 表示"地点自身即归属"。
   * V0.4 两层都是 'self' 且不可按条目覆盖，归属编辑 UI 归 0.5（PRD §1.3）。
   * 这里只是类型上的钩子，V0.4 不读取它。
   */
  projection: {
    default: 'self' | RelationType
    editablePerEntity: boolean
  }
}

export const officialLayers: readonly LayerDefinition[] = [
  {
    id: 'travel',
    label: { zh: '足迹', en: 'Travel' },
    icon: 'Footprints',
    // 现有足迹色：城市标记在没有国家配色时的默认 accent（CesiumAtlasGlobe 的 '#38bdf8'），
    // 也是图源菜单勾选图标用的同一个蓝。
    accent: '#38bdf8',
    defaultVisible: true,
    order: 0,
    // 现有地球只给城市画标记；国家 Entity 的中心点从来不画（PR3 对等测试钉住了这一点）。
    mapSubtypes: ['city'],
    projection: { default: 'self', editablePerEntity: false },
  },
  {
    id: 'want_to_go',
    label: { zh: '想去', en: 'Want to Go' },
    icon: 'Heart',
    // PRD §9.3：暖色，与现有蓝绿地球对比（待设计确认，§16 Q1）。
    accent: '#F0647A',
    defaultVisible: true,
    order: 1,
    // PRD Q5：想去支持「整个国家」条目，它们的代表点也要上图。
    mapSubtypes: ['city', 'country'],
    projection: { default: 'self', editablePerEntity: false },
  },
]
