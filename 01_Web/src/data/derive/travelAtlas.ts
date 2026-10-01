/**
 * 足迹（travel-map）派生用到的小工具（RFC-LOC-1 PR1 搬自 `src/data/travelAtlas.ts`）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。足迹派生本身在
 * `../canonical/derive.ts`（按地点 id）；这里只剩它复用的展示辅助：日期范围、配色、国旗、坐标与首页分类集合。
 *
 * RFC-LOC-1 PR5b 删除了按名字推导身份的旧规则（slug 副本，以及由国家名、城市名、行程标题算出国家键、城市键、
 * 行程 id 的三个函数）、旧文件格式的类型与旧派生 `deriveTravelAtlas`；`coordinateForRecord` 也不再按城市名、国家名
 * 查坐标表（RFC §4「推导禁令」）：坐标只来自记录本身，地点的坐标在 Canonical 的地点上。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { TravelMapRecord, TravelRecordCategory } from '../../types/travel.ts'

export const homeVisibleCategories = new Set<TravelRecordCategory>(['destination', 'dayTrip', 'region'])

export const formatDateRange = (items: TravelMapRecord[]) => {
  const dates = items
    .flatMap((item) => [item.start_date, item.end_date])
    .filter((date): date is string => Boolean(date))
    .sort()

  if (dates.length === 0) return 'Date unknown'

  const first = dates[0] ?? 'Date unknown'
  const last = dates[dates.length - 1] ?? first
  return first === last ? first : `${first} - ${last}`
}

export const unique = <T,>(items: T[]) => [...new Set(items)]

export const hasCoordinates = (item: { lat: number | null; lng: number | null }) =>
  typeof item.lat === 'number' && typeof item.lng === 'number'

/**
 * 记录自身的坐标；没有时为 undefined。V2 Reader 重建的记录省略坐标时已经用城市地点的坐标填回，
 * 所以这里不再按城市名、国家名回落查表（PR5b 之前那张表一直是空的，回落从未生效）。
 */
export const coordinateForRecord = (record: TravelMapRecord) =>
  hasCoordinates(record) ? { lat: record.lat, lng: record.lng, approximate: false } : undefined

export const countryAccent = (index: number) => {
  const accents = [
    '#66c7a8',
    '#f28b82',
    '#7dd3fc',
    '#8ecae6',
    '#c77dff',
    '#ffb703',
    '#b8c0ff',
    '#80ed99',
    '#57cc99',
    '#48cae4',
    '#e9c46a',
    '#d8b26e',
    '#f0d7a3',
    '#f07f5f',
    '#76a9d8',
    '#a7c957',
    '#90dbf4',
    '#ffafcc',
    '#bde0fe',
  ]
  return accents[index % accents.length]
}

export const flagEmojiForCode = (code?: string) =>
  code?.length === 2
    ? [...code.toUpperCase()].map((character) => String.fromCodePoint(127397 + character.charCodeAt(0))).join('')
    : undefined
