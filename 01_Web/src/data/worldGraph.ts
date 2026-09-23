import { cities, countries, journeyDays, plannedRecords, routes, travelAtlasCountryCodes } from './travelAtlas'
import { wantToGoItems } from './wantToGo'
import { plannedRecordsToWorldGraph } from '../worldgraph/adapters/plannedRecords'
import { travelToWorldGraph } from '../worldgraph/adapters/travel'
import { wantToGoToWorldGraph } from '../worldgraph/adapters/wantToGo'
import { mergeWorldGraphSnapshots } from '../worldgraph/snapshot'

/**
 * 应用侧的 World Graph 快照（PRD v0.4 §8.1 数据流）。
 *
 * 放在 src/data/ 而不是 src/worldgraph/：本模块要 import travelAtlas.ts，
 * 那正是 FR-MOD 边界明令禁止 Core 做的事（travelAtlas.ts 依赖 Vite 虚拟模块
 * 'virtual:starmap-private-data' 与 import.meta.env）。Core 只接收参数，
 * "把参数凑齐"是应用层的活。
 *
 * 模块级只算一次：几个适配器都是纯函数，输入是模块级常量，
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

/** 想去条目（FR-WTG-2）。隐藏条目仍在快照里，只在 membership.metadata.hidden 上打标记。 */
export const wantToGoSnapshot = wantToGoToWorldGraph(wantToGoItems, { now: worldGraphSessionNow })

/** travel-map 里 status === 'planned' 的记录（FR-WTG-7），只读地进入想去图层。 */
export const plannedSnapshot = plannedRecordsToWorldGraph(plannedRecords, {
  now: worldGraphSessionNow,
  countryCodes: travelAtlasCountryCodes,
})

/**
 * 地图查询用的合并快照。顺序是 travel → want-to-go → planned：
 * 三者 id 空间不相交（`place:city:` / `place:wtg:` / `place:planned:`），顺序只决定地点在列表里的
 * 先后——足迹排最前，PR3 的对等关系不变；想去先于 planned，FR-MR-5 同键去重时保留想去。
 */
export const worldGraphSnapshot = mergeWorldGraphSnapshots(travelSnapshot, wantToGoSnapshot, plannedSnapshot)
