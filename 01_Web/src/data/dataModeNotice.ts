/**
 * V2 数据模式的空状态（RFC-LOC-1 PR3b-1 规格 §2.4，决定 E；PR3b-2 规格 §2.7 定文案；PR3b-3 规格 §2.6 去掉只读说明）——
 * 显示什么，由这个纯函数决定；组件在 `../components/DataModeNotice.tsx`。
 *
 * - 只在个人模式且数据模式为 v2 时才可能显示；公开模式与旧模式下什么都不显示。
 * - PR3b-3 起 V2 下编辑全部开放，不再有「某些编辑尚未开放」的说明：文件格式是实现细节，用户不需要知道。
 * - 没有任何足迹记录（visited 与 planned），也没有想去条目（含隐藏的）时，显示决定 E 的空状态
 *   「还没有足迹，从添加第一个城市开始。」；有数据时什么都不显示。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { DataMode } from './canonical/canonicalForInputs.ts'

export const V2_EMPTY_NOTICE = '还没有足迹，从添加第一个城市开始。'

export interface DataModeNoticeInput {
  /** 个人模式（`import.meta.env.MODE === 'personal'`）。 */
  personal: boolean
  dataMode: DataMode
  /** 足迹记录总数：visited（含不上首页、被 editor 隐藏的）+ planned。 */
  travelRecordCount: number
  /** 想去条目总数（含隐藏的）。 */
  wantToGoItemCount: number
}

export interface DataModeNoticeContent {
  empty: string
}

/** 要显示的内容；不显示时为 undefined。 */
export const dataModeNotice = (input: DataModeNoticeInput): DataModeNoticeContent | undefined => {
  if (!input.personal || input.dataMode !== 'v2') return undefined
  if (input.travelRecordCount > 0 || input.wantToGoItemCount > 0) return undefined
  return { empty: V2_EMPTY_NOTICE }
}
