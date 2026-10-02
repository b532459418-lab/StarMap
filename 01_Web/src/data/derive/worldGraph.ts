/**
 * 应用侧 World Graph 快照的纯派生（RFC-LOC-1 PR1；Core-A 起多了地点快照）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）：
 * 它把注册表的地点、足迹与想去的派生结果凑成 Core 适配器的参数（由 `../canonical/derive.ts` 准备）。
 * `now`（worldGraphSessionNow）仍由 `src/data/worldGraph.ts` 的来源在模块加载时取一次。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { placesToWorldGraph, type PlaceInput } from '../../worldgraph/adapters/places.ts'
import { plannedRecordsToWorldGraph, type PlannedRecordInput } from '../../worldgraph/adapters/plannedRecords.ts'
import { travelToWorldGraph } from '../../worldgraph/adapters/travel.ts'
import { wantToGoToWorldGraph, type WantToGoInput } from '../../worldgraph/adapters/wantToGo.ts'
import { mergeWorldGraphSnapshots } from '../../worldgraph/snapshot.ts'
import type { City, Country, JourneyDay, Route } from '../../types/travel.ts'

/** Core 适配器的全部输入（见 `../canonical/derive.ts`）。 */
export interface WorldGraphInputs {
  /** 注册表的全部地点（Core 方案 C2：地点实体只由它们构造一次）。 */
  places: PlaceInput[]
  /** 足迹派生结果里显示中的国家、城市、行程日与路线。 */
  countries: Country[]
  cities: City[]
  journeyDays: JourneyDay[]
  routes: Route[]
  /** 想去条目（Canonical 条目，按地点 id 引用地点）。 */
  wantToGoItems: WantToGoInput[]
  /** `status === 'planned'` 的足迹记录（FR-WTG-7），按地点 id 引用地点。 */
  plannedRecords: PlannedRecordInput[]
}

/** Core 适配器的输入 + 会话时间 → `worldGraph.ts` 今天的快照导出。 */
export const deriveWorldGraph = (inputs: WorldGraphInputs, now: string) => {
  const { places, countries, cities, journeyDays, routes, wantToGoItems, plannedRecords } = inputs

  /** 注册表的地点：每个地点一个实体（Core 方案 C1、C2）。地点本身不属于任何图层。 */
  const placesSnapshot = placesToWorldGraph(places, { now })

  /**
   * Q8 方案 C：options 只传 now，不传 hiddenCountryIds / hiddenCityIds。
   * 被 editor 隐藏的国家/城市在派生层就已经被过滤掉了，根本不在下面这四个数组里，
   * 在足迹层也就没有成员关系——与 PR3 之前的地图行为一致。
   */
  const travelSnapshot = travelToWorldGraph({ countries, cities, journeyDays, routes }, { now })

  /** 想去条目（FR-WTG-2）。隐藏条目仍在快照里，只在 membership.metadata.hidden 上打标记。 */
  const wantToGoSnapshot = wantToGoToWorldGraph(wantToGoItems)

  /** status === 'planned' 的足迹记录（FR-WTG-7），只读地进入想去图层。 */
  const plannedSnapshot = plannedRecordsToWorldGraph(plannedRecords)

  /**
   * 地图查询用的合并快照。顺序是 places → travel → want-to-go → planned：
   * 地点实体只在 places 里出现一次，后三者只产出成员关系（与足迹的行程日、关系），实体 id 是地点 id；
   * 顺序决定同一地点在同一层里成员关系的先后——想去先于 planned，地图取第一条可见记录的 metadata。
   */
  const worldGraphSnapshot = mergeWorldGraphSnapshots(placesSnapshot, travelSnapshot, wantToGoSnapshot, plannedSnapshot)

  // 地点快照不单独导出：它只有实体与锚点，已经在合并快照里；另外三份是各适配器的产出，成员关系按地点 id 引用它。
  return {
    travelSnapshot,
    wantToGoSnapshot,
    plannedSnapshot,
    worldGraphSnapshot,
  }
}

export type WorldGraphDerived = ReturnType<typeof deriveWorldGraph>
