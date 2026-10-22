import { useAppData } from './appStore.ts'
import { sessionNow } from './rawInputs.ts'

/**
 * 应用侧的 World Graph 快照（PRD v0.4 §8.1 数据流）。
 *
 * 放在 src/data/ 而不是 src/worldgraph/：它经 ./appStore.ts 依赖 Vite 虚拟模块
 * 'virtual:starmap-private-data' 与 import.meta.env，那正是 FR-MOD 边界明令禁止 Core 做的事。
 * Core 只接收参数，"把参数凑齐"是应用层的活——四个适配器（地点、足迹、想去、planned）的调用与合并在纯派生层
 * ./derive/worldGraph.ts（RFC-LOC-1 PR1），经 ./appStore.ts 的快照计算。
 *
 * 3C-5 D：快照随数据更新（保存后不再整页刷新），经下面的 hook 取用；同一份数据的快照引用不变，地图侧的 useMemo
 * 以它为依赖（AC-8）。
 */

/** 页面加载时固定一次（./rawInputs.ts）。适配器要求 options.now 必填且不读时钟，时间从这里注入。 */
export const worldGraphSessionNow: string = sessionNow

/** travelSnapshot、wantToGoSnapshot、plannedSnapshot 与合并后的 worldGraphSnapshot（说明见 ./derive/worldGraph.ts）。 */
export const useWorldGraph = () => useAppData().worldGraph
