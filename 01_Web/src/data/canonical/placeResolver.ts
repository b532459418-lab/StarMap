/**
 * 地点解析（RFC-LOC-1 ID-6；PR3 总体方案 §3.1 第 3 条，PR3b-2 规格 §2.2；第 2A 批）：V2 写入用的
 * 「可能是同一个地点吗」的判断。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。调用方原是 `v2write/`（V2 写入，3C-5 E 删除），现在是 ../editor/rules/places.ts：
 * - 国家按 ISO 3166-1 alpha-2「先找后建」（`resolveCountry`）：恰好一个就引用，多于一个交给调用方报错；
 * - 城市按名字只找候选（`findCityCandidates`）：名字和坐标是匹配提示，不是身份（RFC ID-6）。写入端有候选就请用户选择，
 *   用户选定后按地点 id 引用，或明确新建；从不按名字静默复用。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { slugify } from '../../worldgraph/slug.ts'
import { EN, ZH, isoOf } from './reconstruct.ts'
import type { CanonicalPlace, PlaceId } from './types.ts'

// ---------------------------------------------------------------------------
// 国家代码
// ---------------------------------------------------------------------------
//
// 第 2A 批之前这里还有城市匹配键（`<国家代码>:<slug(英文名 ?? 中文名)>`）与按键「恰好一个就复用」的 `resolveCity`：
// 英文名相同就算同一个城市，中文名与坐标都不参与（同名不同城会被并成一个地点）。它们已删除，城市改用下面的 `findCityCandidates`。

/** 两位字母才算国家代码，统一大写；其它形状一律视为没有。 */
export const asCountryCode = (value: unknown): string | undefined => {
  const code = typeof value === 'string' && value !== '' ? value.trim().toUpperCase() : undefined
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
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

