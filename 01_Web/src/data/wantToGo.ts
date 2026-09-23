/**
 * Want to Go 应用数据层（PRD FR-WTG-2 / FR-PUB-1）。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块与 import.meta.env，
 * 只能在 Vite 里跑。解析与投影的纯逻辑都在 src/worldgraph/adapters/wantToGo.ts，
 * 本文件只负责选出数据来源、把那份 JSON 交给它；另外给界面提供按 EntityId 反查条目的
 * 两张表（想去条目与 planned 记录）。
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
import { plannedRecords } from './travelAtlas'
import { plannedEntityId } from '../worldgraph/adapters/plannedRecords.ts'
import { parseWantToGoFile, wantToGoEntityId, type WantToGoItem } from '../worldgraph/adapters/wantToGo.ts'
import type { EntityId } from '../worldgraph/types.ts'
import type { TravelMapRecord } from '../types/travel'

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

// 私有文件不存在是正常状态（还没添加过想去的地方），不该报成 problem。
const parsed = wantToGoDataSource === 'sample'
  ? parseWantToGoFile(wantToGoSample)
  : wantToGoDataSource === 'local'
    ? parseWantToGoFile(privateWantToGo)
    : { items: [] as WantToGoItem[], problems: [] as string[] }

export const wantToGoItems: WantToGoItem[] = parsed.items

/** 被丢弃的坏数据说明。非空不代表出错，只代表有条目没能进入图层。 */
export const wantToGoProblems: string[] = parsed.problems

if (import.meta.env.DEV && wantToGoProblems.length > 0) {
  // 样例出现 problem 是构建缺陷：tracked 的样例由 npm run privacy:check 兜底，不该带坏数据。
  const fileName = wantToGoDataSource === 'sample' ? 'want-to-go.sample.json（公开样例，属构建缺陷）' : 'want-to-go.local.json'
  console.warn(
    `[StarMap] ${fileName} 有 ${wantToGoProblems.length} 条记录被跳过：\n${wantToGoProblems.join('\n')}`,
  )
}

/** 图层面板「已隐藏 N 项」列出的条目（FR-WTG-5），最近加入的在前。planned 记录只读，不会出现在这里。 */
export const hiddenWantToGoItems: WantToGoItem[] = wantToGoItems
  .filter((item) => item.hidden)
  .sort((left, right) => right.addedAt.localeCompare(left.addedAt))

/**
 * EntityId → 想去条目，给详情卡用。键与适配器产出 Entity 的规则相同；
 * 同一 EntityId 出现两次时第一条胜出，与 wantToGoToWorldGraph 的去重一致。
 */
export const wantToGoItemByEntityId = new Map<EntityId, WantToGoItem>()
for (const item of wantToGoItems) {
  const entityId = wantToGoEntityId(item.place.countryCode, item.place.nameEn)
  if (!wantToGoItemByEntityId.has(entityId)) wantToGoItemByEntityId.set(entityId, item)
}

/** EntityId → planned 旅行记录（FR-WTG-7，只读），给详情卡用。去重规则同 plannedRecordsToWorldGraph。 */
export const plannedRecordByEntityId = new Map<EntityId, TravelMapRecord>()
for (const record of plannedRecords) {
  const entityId = plannedEntityId(record.id)
  if (!plannedRecordByEntityId.has(entityId)) plannedRecordByEntityId.set(entityId, record)
}
