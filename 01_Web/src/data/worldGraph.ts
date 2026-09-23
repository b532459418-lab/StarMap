import { cities, countries, journeyDays, routes } from './travelAtlas'
import { travelToWorldGraph } from '../worldgraph/adapters/travel'

/**
 * 应用侧的 World Graph 快照（PRD v0.4 §8.1 的 V0.4-travel 子集）。
 *
 * 放在 src/data/ 而不是 src/worldgraph/：本模块要 import travelAtlas.ts，
 * 那正是 FR-MOD 边界明令禁止 Core 做的事（travelAtlas.ts 依赖 Vite 虚拟模块
 * 'virtual:starmap-private-data' 与 import.meta.env）。Core 只接收参数，
 * "把参数凑齐"是应用层的活。
 *
 * 模块级只算一次：travelToWorldGraph 是纯函数，输入是模块级常量，
 * 所以快照的引用天然稳定——地图侧的 useMemo 能靠它避免无谓重算（AC-8）。
 */

/** 模块加载时固定一次。适配器要求 options.now 必填且不读时钟，时间从这里注入。 */
export const worldGraphSessionNow: string = new Date().toISOString()

/**
 * Q8 方案 C：options 只传 now，不传 hiddenCountryIds / hiddenCityIds。
 * 被 editor 隐藏的国家/城市在记录层就已经被 travelAtlas 过滤掉了，
 * 根本不在下面这四个数组里，快照里也不存在——与 PR3 之前的地图行为一致。
 */
export const travelSnapshot = travelToWorldGraph(
  { countries, cities, journeyDays, routes },
  { now: worldGraphSessionNow },
)
