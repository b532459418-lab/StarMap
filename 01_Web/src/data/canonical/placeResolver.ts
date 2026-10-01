/**
 * 地点解析（RFC-LOC-1 ID-6；PR3 总体方案 §3.1 第 3 条，PR3b-2 规格 §2.2）：V2 写入用的
 * 「这是不是同一个地点」的判断（PR3a 到 PR5a 迁移规划也用它，迁移工具在 PR5b 删除）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。调用方：
 * - `../v2write/`（V2 写入）：新增足迹、国家、想去时「先找后建」——找到就引用已有地点，找不到才用 UUIDv7 新建。
 *
 * 名称只用来回答「可能是同一个地点吗」（匹配提示），结论落在地点 id 上（RFC ID-6），不按名字推导任何身份。
 * 解析不做模糊匹配、不按距离猜：候选恰好一个才算找到，多于一个交给调用方报错（PR3b-2 规格 §2.2）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { slugify } from '../../worldgraph/slug.ts'
import { EN, ZH, isoOf } from './reconstruct.ts'
import type { CanonicalPlace, PlaceId } from './types.ts'

// ---------------------------------------------------------------------------
// FR-MR-5 合并键：与 src/worldgraph/query.ts 的 mergeKeyOf 逐字一致
// ---------------------------------------------------------------------------
//
// Core 的 mergeKeyOf 不导出（不改 Core），这里照抄它与它的两个输入：
// - 国家代码：`asCountryCode`（两位字母才算，统一大写）。足迹城市取所属国家 Entity 的 flagCode
//   （= 国家地点 ISO 的小写），想去地点取自身的 countryCode（= 所属国家地点的 ISO）；
// - 名称：Entity 的 title。足迹城市的 title 由 Core travel 适配器 `buildTitle(city.nameZh, city.nameEn)`
//   得到，City 的名称由 ./derive.ts 从地点重建（nameZh = 中文名，nameEn = 英文名 || 中文名）；
//   想去地点的 title 是 `{ zh: nameZh, en: nameEn }`，由 ./reconstruct.ts 从地点重建。
// placeResolver.test.ts 用真实管线 queryVisiblePlaces 对拍这套判断（PR5b 之前 planMigration.test.ts 也对拍）。

export type EntityTitle = { zh: string; en?: string }

/** 两位字母才算国家代码，统一大写；其它形状一律视为没有。 */
export const asCountryCode = (value: unknown): string | undefined => {
  const code = typeof value === 'string' && value !== '' ? value.trim().toUpperCase() : undefined
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
}

/** 足迹城市在 Core 里的 title：英文名缺时用中文名（同 Core travel 适配器的 buildTitle）。 */
export const footprintCityTitle = (place: Pick<CanonicalPlace, 'names'>): EntityTitle => {
  const nameZh = place.names[ZH] ?? ''
  const nameEn = (place.names[EN] ?? '') || nameZh
  const title: EntityTitle = { zh: nameZh || nameEn || '' }
  if (nameEn) title.en = nameEn
  return title
}

/** 想去地点在 Core 里的 title：`{ zh: nameZh, en: nameEn }`，缺的为空字符串。 */
export const wantToGoTitle = (place: Pick<CanonicalPlace, 'names'>): EntityTitle => ({ zh: place.names[ZH] ?? '', en: place.names[EN] ?? '' })

/** FR-MR-5 合并键 `<国家代码>:<slug(英文名 ?? 中文名)>`。拿不到国家代码或 slug 为空时没有键（不合并）。 */
export const mergeKeyOf = (countryCode: string | undefined, title: EntityTitle): string | undefined => {
  if (countryCode === undefined) return undefined
  const slug = slugify(title.en ?? title.zh)
  return slug === '' ? undefined : `${countryCode}:${slug}`
}

// ---------------------------------------------------------------------------
// 距离
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0088

/** 大圆距离（haversine），千米。 */
export const distanceKm = (from: { lat: number; lng: number }, to: { lat: number; lng: number }): number => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = radians(to.lat - from.lat)
  const dLng = radians(to.lng - from.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// ---------------------------------------------------------------------------
// 解析：先找后建的「找」
// ---------------------------------------------------------------------------

/** 解析结果：没有、恰好一个、或多于一个（候选的地点 id，按注册表顺序）。 */
export type PlaceResolution =
  | { status: 'none' }
  | { status: 'found'; place: CanonicalPlace }
  | { status: 'ambiguous'; candidates: PlaceId[] }

const resolutionOf = (matches: readonly CanonicalPlace[]): PlaceResolution => {
  if (matches.length === 0) return { status: 'none' }
  if (matches.length === 1) return { status: 'found', place: matches[0] }
  return { status: 'ambiguous', candidates: matches.map((place) => place.id) }
}

/** 按 ISO 3166-1 alpha-2 找国家地点（不分大小写）。代码不是两位字母时视为找不到。 */
export const resolveCountry = (places: readonly CanonicalPlace[], iso: string): PlaceResolution => {
  const code = asCountryCode(iso)
  if (code === undefined) return { status: 'none' }
  return resolutionOf(places.filter((place) => place.subtype === 'country' && isoOf(place) === code))
}

/**
 * 在国家 `countryId` 的城市地点里按 FR-MR-5 合并键找城市。输入的名称与城市地点都按足迹城市的 title 取键
 * （英文名缺时用中文名）；国家代码取 `countryId` 这个国家地点的 ISO。国家不存在或没有 ISO、输入的键为空时视为找不到。
 */
export const resolveCity = (
  places: readonly CanonicalPlace[],
  countryId: PlaceId,
  names: { zh?: string; en?: string },
): PlaceResolution => {
  const country = places.find((place) => place.id === countryId && place.subtype === 'country')
  const countryCode = asCountryCode(isoOf(country))
  const inputNames: Record<string, string> = {}
  if (names.zh) inputNames[ZH] = names.zh
  if (names.en) inputNames[EN] = names.en
  const key = mergeKeyOf(countryCode, footprintCityTitle({ names: inputNames }))
  if (key === undefined) return { status: 'none' }
  return resolutionOf(places.filter((place) => (
    place.subtype === 'city'
    && place.partOf === countryId
    && mergeKeyOf(countryCode, footprintCityTitle(place)) === key
  )))
}
