/**
 * Want to Go 应用数据层（PRD FR-WTG-2 / FR-PUB-1）。
 *
 * 这里【不是】 StarMap Core：它经 ./appData.ts 依赖 Vite 虚拟模块与 import.meta.env，
 * 只能在 Vite 里跑。读取与校验在 V2 Reader（./canonical/），投影的纯逻辑在 src/worldgraph/adapters/wantToGo.ts；
 * 应用侧派生（隐藏条目、按记录 id 反查条目的两张表、「想去 → 足迹」的禁用原因）
 * 经 Canonical 计算（./canonical/derive.ts；PR1 的旧派生 deriveWantToGo 在 PR5b 删除）。
 * 本文件只以原名导出；开发时报告被跳过的坏数据在 ./appData.ts。
 *
 * 数据来源规则（FR-PUB-1）在 ./rawInputs.ts，按顺序判定：
 *
 * 1. 强制样例模式（VITE_TRAVEL_ATLAS_DATA_MODE=sample，或开发时 ?data=sample）或公开模式
 *    → tracked 的中性样例（RFC-LOC-1 PR4 起是 V2 文件 src/data/v2-sample/want-to-go.json，经 V2 Reader）。
 *    判定与足迹完全一致。公开模式下虚拟模块本来就不注入任何私有数据。
 * 2. 否则个人模式（import.meta.env.MODE === 'personal'）→ 私有层的想去文件 data/v2/want-to-go.local.json
 *    （RFC-LOC-1 PR5a 起旧格式的 want-to-go.local.json 不再读取）；文件不存在 → 空列表，【不】回落样例。
 *    理由：样例条目若出现在个人模式，会带着「隐藏」按钮，而隐藏请求写的是私有文件，必然报"找不到这条想去记录"。
 *    足迹同样不回落样例（决定 E）。
 *
 * 写入控件只对 'local' 来源开放（WantToGoCard 的「隐藏」、LayerPanel 的添加入口），
 * 这是 localEditorAvailable 之外的另一层门控。
 */

import { appData } from './appData'
import type { WantToGoItem } from './derive/wantToGo.ts'

const derived = appData.wantToGo

export const wantToGoDataSource: 'local' | 'sample' | 'none' = derived.wantToGoDataSource

export const wantToGoItems: WantToGoItem[] = derived.wantToGoItems

/** 被丢弃的坏数据说明。非空不代表出错，只代表有条目没能进入图层。 */
export const wantToGoProblems: string[] = derived.wantToGoProblems

/** 图层面板「已隐藏 N 项」列出的条目（FR-WTG-5），最近加入的在前。planned 记录只读，不会出现在这里。 */
export const hiddenWantToGoItems: WantToGoItem[] = derived.hiddenWantToGoItems

/** 想去条目 id → 想去条目（同一 id 第一条胜出）。Collection、想去卡片与转足迹对话框按成员关系的 recordId 查它。 */
export const wantToGoItemById = derived.wantToGoItemById

/** planned 旅行记录 id → 记录（FR-WTG-7，只读）。Collection、想去卡片与转足迹对话框按成员关系的 recordId 查它。 */
export const plannedRecordById = derived.plannedRecordById

// ---- 想去 → 足迹（PR9）的前置条件：返回 undefined 表示可以转换，规则见 ./canonical/derive.ts 与 ./derive/wantToGo.ts ----

export const wantToGoConvertBlockReason = derived.wantToGoConvertBlockReason

export const plannedConvertBlockReason = derived.plannedConvertBlockReason
