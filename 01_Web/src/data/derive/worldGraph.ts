/**
 * 应用侧 World Graph 快照的纯派生（RFC-LOC-1 PR1）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）：
 * 它把足迹与想去的派生结果凑成 Core 适配器的参数。三个适配器的调用顺序与参数
 * 原样搬自 `src/data/worldGraph.ts`；`now`（worldGraphSessionNow）仍由原文件在模块加载时取一次。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { plannedRecordsToWorldGraph } from '../../worldgraph/adapters/plannedRecords.ts'
import { travelToWorldGraph } from '../../worldgraph/adapters/travel.ts'
import { wantToGoToWorldGraph, type WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import { mergeWorldGraphSnapshots } from '../../worldgraph/snapshot.ts'
import type { City, Country, JourneyDay, Route, TravelMapRecord } from '../../types/travel.ts'

/** 快照要用到的足迹派生结果（见 `./travelAtlas.ts`）。 */
export interface WorldGraphTravelInput {
  countries: Country[]
  cities: City[]
  journeyDays: JourneyDay[]
  routes: Route[]
  plannedRecords: TravelMapRecord[]
  travelAtlasCountryCodes: Record<string, string>
}

/** 足迹派生结果 + 想去条目 + 会话时间 → `worldGraph.ts` 今天的四个快照导出。 */
export const deriveWorldGraph = (travel: WorldGraphTravelInput, wantToGoItems: WantToGoItem[], now: string) => {
  const { countries, cities, journeyDays, routes, plannedRecords, travelAtlasCountryCodes } = travel

  /**
   * Q8 方案 C：options 只传 now，不传 hiddenCountryIds / hiddenCityIds。
   * 被 editor 隐藏的国家/城市在记录层就已经被 travelAtlas 过滤掉了，
   * 根本不在下面这四个数组里，快照里也不存在——与 PR3 之前的地图行为一致。
   */
  const travelSnapshot = travelToWorldGraph(
    { countries, cities, journeyDays, routes },
    { now },
  )

  /** 想去条目（FR-WTG-2）。隐藏条目仍在快照里，只在 membership.metadata.hidden 上打标记。 */
  const wantToGoSnapshot = wantToGoToWorldGraph(wantToGoItems, { now })

  /** travel-map 里 status === 'planned' 的记录（FR-WTG-7），只读地进入想去图层。 */
  const plannedSnapshot = plannedRecordsToWorldGraph(plannedRecords, {
    now,
    countryCodes: travelAtlasCountryCodes,
  })

  /**
   * 地图查询用的合并快照。顺序是 travel → want-to-go → planned：
   * 三者 id 空间不相交（`place:city:` / `place:wtg:` / `place:planned:`），顺序只决定地点在列表里的
   * 先后——足迹排最前，PR3 的对等关系不变；想去先于 planned，FR-MR-5 同键去重时保留想去。
   */
  const worldGraphSnapshot = mergeWorldGraphSnapshots(travelSnapshot, wantToGoSnapshot, plannedSnapshot)

  return {
    travelSnapshot,
    wantToGoSnapshot,
    plannedSnapshot,
    worldGraphSnapshot,
  }
}

export type WorldGraphDerived = ReturnType<typeof deriveWorldGraph>
