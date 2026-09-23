/**
 * Want to Go 应用数据层（PRD FR-WTG-2）。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块与 import.meta.env，
 * 只能在 Vite 里跑。解析与投影的纯逻辑都在 src/worldgraph/adapters/wantToGo.ts，
 * 本文件只负责"把私有资料层里的那份 JSON 交给它"，以及和 travelAtlas.ts 一样
 * 尊重样例数据模式。
 */

import { privateWantToGo } from 'virtual:starmap-private-data'
import { parseWantToGoFile, type WantToGoItem } from '../worldgraph/adapters/wantToGo.ts'

// 与 travelAtlas.ts 完全一致的样例模式判定：环境变量或 ?data=sample。
// 样例模式下私人数据一律视为不存在；公开样例 want-to-go.sample.json 属 PR6。
const forceSampleData = import.meta.env.VITE_TRAVEL_ATLAS_DATA_MODE === 'sample'
  || (import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('data') === 'sample')

const localWantToGo = forceSampleData ? undefined : privateWantToGo
const hasLocalWantToGo = localWantToGo !== undefined && localWantToGo !== null

// 文件不存在是正常状态（还没添加过想去的地方），不该报成 problem。
const parsed = hasLocalWantToGo
  ? parseWantToGoFile(localWantToGo)
  : { items: [] as WantToGoItem[], problems: [] as string[] }

export const wantToGoDataSource: 'local' | 'none' = hasLocalWantToGo ? 'local' : 'none'

export const wantToGoItems: WantToGoItem[] = parsed.items

/** 被丢弃的坏数据说明。非空不代表出错，只代表有条目没能进入图层。 */
export const wantToGoProblems: string[] = parsed.problems

if (import.meta.env.DEV && wantToGoProblems.length > 0) {
  console.warn(
    `[StarMap] want-to-go.local.json 有 ${wantToGoProblems.length} 条记录被跳过：\n${wantToGoProblems.join('\n')}`,
  )
}
