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
import { EN, ZH, isoOf, type PlaceTitle } from './reconstruct.ts'
import type { CanonicalPlace, PlaceId } from './types.ts'

// ---------------------------------------------------------------------------
// 城市匹配键：「可能是同一个城市吗」
// ---------------------------------------------------------------------------
//
// 键是 `<国家代码>:<slug(英文名 ?? 中文名)>`，两个输入：
// - 国家代码：`asCountryCode`（两位字母才算，统一大写），取所属国家地点的 ISO；
// - 名称：独立的匹配规则 `matchNameOf`（英文名缺时用中文名），不依赖显示名称或界面语言。
// RFC-LOC-1 Core-A 之前地图的 FR-MR-5 也按这个键把想去城市并进足迹城市；Core-A 起地图按地点 id 合并，
// 这个键只剩 V2 写入「先找后建」的匹配用途（RFC ID-6）：它只回答「可能是同一个」，结论落在地点 id 上。

/** 两位字母才算国家代码，统一大写；其它形状一律视为没有。 */
export const asCountryCode = (value: unknown): string | undefined => {
  const code = typeof value === 'string' && value !== '' ? value.trim().toUpperCase() : undefined
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
}

/** 匹配名称保留原有规则：英文名，缺时用简体中文名。不使用显示名称的语言回退。 */
export const matchNameOf = (names: Readonly<Record<string, string>>): string =>
  (names[EN] ?? '') || (names[ZH] ?? '')

/** 城市匹配键。保留现有双语输入契约，名称选择独立于显示规则。 */
export const cityMatchKeyOf = (countryCode: string | undefined, title: PlaceTitle): string | undefined => {
  if (countryCode === undefined) return undefined
  const slug = slugify(matchNameOf({ [ZH]: title.zh, [EN]: title.en ?? '' }))
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
// 城市候选：按名字找「可能是同一个城市」的已有地点（第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）
// ---------------------------------------------------------------------------
//
// 名字和坐标只用来找候选，不决定身份：写入端按名字收到新增请求时，只要有候选就请用户选择（明确的地点 id，或明确新建）。
// - 候选：同一国家（`partOf === countryId`）的城市地点，与输入在任一语言（zh-Hans、en）上的名字相同（按 slugify 归一化）。
// - 强候选：双方都有的语言，名字都相同；双方都有坐标且都不是 approximate；距离不超过 STRONG_CANDIDATE_MAX_KM。
//   界面默认选中第一个强候选；没有强候选时不预选。
// - 排序：强候选在前，然后按距离升序（没有距离的在后），再按地点 id（码点顺序）。

/** 强候选的距离上限（千米）。 */
export const STRONG_CANDIDATE_MAX_KM = 50

/** 一个城市候选：地点 id、地点的名称、与输入的距离（双方都有坐标时）、是否强候选。 */
export interface CityCandidate {
  placeId: PlaceId
  names: Readonly<Record<string, string>>
  distanceKm?: number
  strong: boolean
}

const CANDIDATE_LANGUAGES = [ZH, EN] as const

const nameSlugsOf = (names: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(CANDIDATE_LANGUAGES.map((language) => [language, slugify(names[language] ?? '')]))

const byCode = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** 距离升序；没有距离的排在后面。 */
const byDistance = (left: number | undefined, right: number | undefined): number => {
  if (left === undefined || right === undefined) return Number(left === undefined) - Number(right === undefined)
  return left - right
}

/**
 * 在国家 `countryId` 的城市地点里找候选（纯函数）。`names` 只放用户实际给出的名字；`location` 是输入的坐标（可空）。
 * `countryId` 不是国家地点、或输入的名字都为空时，没有候选。
 */
export const findCityCandidates = (
  places: readonly CanonicalPlace[],
  countryId: PlaceId,
  names: { zh?: string; en?: string },
  location?: { lat: number; lng: number; approximate?: true },
): CityCandidate[] => {
  if (!places.some((place) => place.id === countryId && place.subtype === 'country')) return []
  const input = nameSlugsOf({ [ZH]: names.zh, [EN]: names.en })
  if (CANDIDATE_LANGUAGES.every((language) => input[language] === '')) return []
  const candidates: CityCandidate[] = []
  for (const place of places) {
    if (place.subtype !== 'city' || place.partOf !== countryId) continue
    const own = nameSlugsOf(place.names)
    const shared = CANDIDATE_LANGUAGES.filter((language) => input[language] !== '' && own[language] !== '')
    if (!shared.some((language) => input[language] === own[language])) continue
    const distance = location !== undefined && place.location !== undefined ? distanceKm(location, place.location) : undefined
    const strong = shared.every((language) => input[language] === own[language])
      && distance !== undefined
      && location?.approximate !== true
      && place.location?.approximate !== true
      && distance <= STRONG_CANDIDATE_MAX_KM
    candidates.push({ placeId: place.id, names: { ...place.names }, ...(distance !== undefined ? { distanceKm: distance } : {}), strong })
  }
  return candidates.sort((left, right) => (
    Number(right.strong) - Number(left.strong)
    || byDistance(left.distanceKm, right.distanceKm)
    || byCode(left.placeId, right.placeId)
  ))
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
 * 在国家 `countryId` 的城市地点里按城市匹配键找城市。输入的名称与城市地点都按 `matchNameOf` 取键
 * （英文名缺时用中文名）；国家代码取 `countryId` 这个国家地点的 ISO。国家不存在或没有 ISO、输入的键为空时视为找不到。
 */
export const resolveCity = (
  places: readonly CanonicalPlace[],
  countryId: PlaceId,
  names: { zh?: string; en?: string },
): PlaceResolution => {
  const country = places.find((place) => place.id === countryId && place.subtype === 'country')
  const countryCode = asCountryCode(isoOf(country))
  const key = cityMatchKeyOf(countryCode, { zh: names.zh ?? '', en: names.en })
  if (key === undefined) return { status: 'none' }
  return resolutionOf(places.filter((place) => (
    place.subtype === 'city'
    && place.partOf === countryId
    && cityMatchKeyOf(countryCode, { zh: place.names[ZH] ?? '', en: place.names[EN] }) === key
  )))
}
