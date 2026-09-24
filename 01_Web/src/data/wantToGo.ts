/**
 * Want to Go 应用数据层（PRD FR-WTG-2 / FR-PUB-1）。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块与 import.meta.env，
 * 只能在 Vite 里跑。解析与投影的纯逻辑都在 src/worldgraph/adapters/wantToGo.ts；
 * 解析之后的应用侧派生（隐藏条目、按 EntityId 反查条目的两张表、「想去 → 足迹」的禁用原因）
 * 在纯派生层 ./derive/wantToGo.ts（RFC-LOC-1 PR1）。本文件只负责选出数据来源、把那份 JSON
 * 交给派生层，并在开发时报告被跳过的坏数据。
 *
 * 数据来源规则（FR-PUB-1），按顺序判定：
 *
 * 1. 强制样例模式（VITE_TRAVEL_ATLAS_DATA_MODE=sample，或开发时 ?data=sample）
 *    → tracked 的中性样例 want-to-go.sample.json。判定与 travelAtlas.ts 完全一致。
 * 2. 否则个人模式（import.meta.env.MODE === 'personal'）→ 私有层的 want-to-go.local.json；
 *    文件不存在 → 空列表，【不】回落样例。理由：样例条目若出现在个人模式，会带着「隐藏」
 *    按钮，而隐藏请求写的是私有文件，必然报"找不到这条想去记录"。
 *    （足迹在个人模式回落样例是 travelAtlas.ts 的既有行为，这里刻意不照搬。）
 * 3. 否则（公开模式）→ 样例。公开模式下虚拟模块本来就不注入任何私有数据。
 *
 * 写入控件只对 'local' 来源开放（WantToGoCard 的「隐藏」、LayerPanel 的添加入口），
 * 这是 localEditorAvailable 之外的另一层门控。
 */

import wantToGoSample from './want-to-go.sample.json'
import { privateWantToGo } from 'virtual:starmap-private-data'
import { cities, countryById, plannedRecords } from './travelAtlas'
import { deriveWantToGo } from './derive/wantToGo.ts'
import type { WantToGoItem } from '../worldgraph/adapters/wantToGo.ts'

// 与 travelAtlas.ts 完全一致的样例模式判定：环境变量或 ?data=sample。
const forceSampleData = import.meta.env.VITE_TRAVEL_ATLAS_DATA_MODE === 'sample'
  || (import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('data') === 'sample')

const useSampleData = forceSampleData || import.meta.env.MODE !== 'personal'
const hasLocalWantToGo = !useSampleData && privateWantToGo !== undefined && privateWantToGo !== null

export const wantToGoDataSource: 'local' | 'sample' | 'none' = useSampleData
  ? 'sample'
  : hasLocalWantToGo ? 'local' : 'none'

// 各来源对应的原始值；'none'（私有文件不存在）时派生层直接给空列表，不解析、不报 problem。
const wantToGoValue = wantToGoDataSource === 'sample'
  ? wantToGoSample
  : wantToGoDataSource === 'local'
    ? privateWantToGo
    : undefined

const derived = deriveWantToGo(
  { source: wantToGoDataSource, value: wantToGoValue },
  { cities, countryById, plannedRecords },
)

export const wantToGoItems: WantToGoItem[] = derived.wantToGoItems

/** 被丢弃的坏数据说明。非空不代表出错，只代表有条目没能进入图层。 */
export const wantToGoProblems: string[] = derived.wantToGoProblems

if (import.meta.env.DEV && wantToGoProblems.length > 0) {
  // 样例出现 problem 是构建缺陷：tracked 的样例由 npm run privacy:check 兜底，不该带坏数据。
  const fileName = wantToGoDataSource === 'sample' ? 'want-to-go.sample.json（公开样例，属构建缺陷）' : 'want-to-go.local.json'
  console.warn(
    `[StarMap] ${fileName} 有 ${wantToGoProblems.length} 条记录被跳过：\n${wantToGoProblems.join('\n')}`,
  )
}

/** 图层面板「已隐藏 N 项」列出的条目（FR-WTG-5），最近加入的在前。planned 记录只读，不会出现在这里。 */
export const hiddenWantToGoItems: WantToGoItem[] = derived.hiddenWantToGoItems

/** EntityId → 想去条目，给详情卡用（同一 EntityId 第一条胜出）。 */
export const wantToGoItemByEntityId = derived.wantToGoItemByEntityId

/** EntityId → planned 旅行记录（FR-WTG-7，只读），给详情卡用。 */
export const plannedRecordByEntityId = derived.plannedRecordByEntityId

// ---- 想去 → 足迹（PR9）的前置条件：返回 undefined 表示可以转换，规则见 ./derive/wantToGo.ts ----

export const wantToGoConvertBlockReason = derived.wantToGoConvertBlockReason

export const plannedConvertBlockReason = derived.plannedConvertBlockReason
