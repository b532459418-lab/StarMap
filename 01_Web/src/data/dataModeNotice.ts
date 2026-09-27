/**
 * V2 数据模式的说明与空状态（RFC-LOC-1 PR3b-1 规格 §2.4，决定 E；PR3b-2 规格 §2.7 改文案）——显示什么，
 * 由这个纯函数决定；组件在 `../components/DataModeNotice.tsx`。
 *
 * - 只在个人模式且数据模式为 v2 时显示；公开模式与旧模式下什么都不显示。
 * - 常驻一行说明：PR3b-2 起 V2 下非媒体编辑已开放，只有照片与无人机影像的编辑还没开放（PR3b-3）。
 * - 没有任何足迹记录（visited 与 planned），也没有想去条目（含隐藏的）时，另显示空状态，
 *   PR3b-2 开放编辑后是决定 E 的完整文案「还没有足迹，从添加第一个城市开始。」。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { DataMode } from './canonical/canonicalForInputs.ts'

export const V2_READ_ONLY_NOTICE = '当前为 V2 数据模式：照片与无人机影像的编辑将在后续版本开放。'

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
  readOnly: string
  empty?: string
}

/** 要显示的内容；不显示时为 undefined。 */
export const dataModeNotice = (input: DataModeNoticeInput): DataModeNoticeContent | undefined => {
  if (!input.personal || input.dataMode !== 'v2') return undefined
  const empty = input.travelRecordCount === 0 && input.wantToGoItemCount === 0
  return empty ? { readOnly: V2_READ_ONLY_NOTICE, empty: V2_EMPTY_NOTICE } : { readOnly: V2_READ_ONLY_NOTICE }
}
