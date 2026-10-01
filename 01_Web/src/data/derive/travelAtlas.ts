/**
 * 足迹（travel-map）派生用到的小工具（RFC-LOC-1 PR1 搬自 `src/data/travelAtlas.ts`）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。足迹派生本身在
 * `../canonical/derive.ts`（按地点 id）；这里只剩它复用的展示辅助：日期范围、配色、国旗、坐标与首页分类集合。
 *
 * RFC-LOC-1 PR5b 删除了按名字推导身份的旧规则（`slugify` 副本、`getJourneyId`、`countryKeyForRecord`、
 * `cityKeyForRecord`）、旧文件格式的类型与旧派生 `deriveTravelAtlas`。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { getCityCoordinate, getCountryCoordinate } from '../geoCoordinates.ts'
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

export const coordinateForRecord = (record: TravelMapRecord) => {
  if (hasCoordinates(record)) return { lat: record.lat, lng: record.lng, approximate: false }

  return (
    getCityCoordinate(record.city_en || record.city) ??
    getCityCoordinate(record.city) ??
    getCountryCoordinate(record.country_en || record.country)
  )
}

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
