import { cities, countries, journeyDays, plannedRecords, routes, travelAtlasCountryCodes } from './travelAtlas'
import { wantToGoItems } from './wantToGo'
import { deriveWorldGraph } from './derive/worldGraph.ts'

/**
 * 应用侧的 World Graph 快照（PRD v0.4 §8.1 数据流）。
 *
 * 放在 src/data/ 而不是 src/worldgraph/：本模块要 import travelAtlas.ts，
 * 那正是 FR-MOD 边界明令禁止 Core 做的事（travelAtlas.ts 依赖 Vite 虚拟模块
 * 'virtual:starmap-private-data' 与 import.meta.env）。Core 只接收参数，
 * "把参数凑齐"是应用层的活——三个适配器的调用与合并在纯派生层 ./derive/worldGraph.ts
 * （RFC-LOC-1 PR1），本文件只注入会话时间并以原名导出。
 *
 * 模块级只算一次：几个适配器都是纯函数，输入是模块级常量，
 * 所以快照的引用天然稳定——地图侧的 useMemo 能靠它避免无谓重算（AC-8）。
 */

/** 模块加载时固定一次。适配器要求 options.now 必填且不读时钟，时间从这里注入。 */
export const worldGraphSessionNow: string = new Date().toISOString()

const derived = deriveWorldGraph(
  { countries, cities, journeyDays, routes, plannedRecords, travelAtlasCountryCodes },
  wantToGoItems,
  worldGraphSessionNow,
)

/** 足迹（Q8 方案 C：options 只传 now，说明见 ./derive/worldGraph.ts）。 */
export const travelSnapshot = derived.travelSnapshot

/** 想去条目（FR-WTG-2）。隐藏条目仍在快照里，只在 membership.metadata.hidden 上打标记。 */
export const wantToGoSnapshot = derived.wantToGoSnapshot

/** travel-map 里 status === 'planned' 的记录（FR-WTG-7），只读地进入想去图层。 */
export const plannedSnapshot = derived.plannedSnapshot

/** 地图查询用的合并快照，顺序是 travel → want-to-go → planned。 */
export const worldGraphSnapshot = derived.worldGraphSnapshot
