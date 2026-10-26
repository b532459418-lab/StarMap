/**
 * 地点的判定（3C-5 C1 从 v2write/common.ts（3C-5 E 删除）迁来，规则、错误码与参数不变；第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）：
 * 国家按 ISO 先找后建，城市按名字只找候选、由用户选择。
 *
 * 这里只做判定，不改任何数据：调用方给出已有的地点（官方视图的形状与顺序），拿到「用哪个」或「新建什么」，自己落盘——
 * V2 写入函数改它的草稿，存储原生的写入（../native/）生成命令。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { findCityCandidates, resolveCountry } from '../../canonical/placeResolver.ts'
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'
import { V2WriteError, fail } from '../errors.ts'

/** One country of the country catalog (the plugin's world-countries catalog, keyed by upper-case ISO code). */
export interface CatalogCountry {
  nameZh: string
  nameEn: string
  countryCode: string
  centerLat: number
  centerLng: number
  region?: string
}

/** 国家的判定：已有的国家地点，或按目录新建（目录项与大写代码）。 */
export type CountryChoice =
  | { readonly found: CanonicalPlace }
  | { readonly create: { readonly code: string; readonly entry: CatalogCountry } }

/**
 * 按 ISO 找国家地点（`countries`：注册表里的国家，按注册表顺序）：找到就复用；多于一个报 `E_PLACE_AMBIGUOUS`
 * （`candidates` 按注册表顺序）；找不到就按国家目录新建；目录里也没有 → `E_COUNTRY_NOT_IN_CATALOG`。
 */
export const chooseCountry = (countries: readonly CanonicalPlace[], iso: string, catalog: ReadonlyMap<string, CatalogCountry>): CountryChoice => {
  const resolution = resolveCountry(countries, iso)
  if (resolution.status === 'found') return { found: resolution.place }
  if (resolution.status === 'ambiguous') {
    throw new V2WriteError('E_PLACE_AMBIGUOUS', { subtype: 'country', iso, candidates: resolution.candidates })
  }
  const code = iso.trim().toUpperCase()
  const entry = catalog.get(code)
  if (!entry) return fail('E_COUNTRY_NOT_IN_CATALOG', { iso: code })
  return { create: { code, entry } }
}

/** `E_PLACE_CHOICE_REQUIRED` 的一个候选（响应 `params.candidates` 的一项）：§3.1 的字段，再加地点的坐标，供界面显示。 */
export interface PlaceChoiceCandidateParam {
  placeId: PlaceId
  names: Record<string, string>
  location?: { lat: number; lng: number }
  distanceKm?: number
  strong: boolean
}

/**
 * 按名字新增城市（第 2A 批）：名字和坐标只用来找候选，不决定身份。`createNew` 为 true 时一定新建，不做匹配；否则在国家
 * `countryId` 下找候选（`places` 至少包含这个国家和它的城市；../../canonical/placeResolver.ts 的 `findCityCandidates`）：
 * 有任何候选 → `E_PLACE_CHOICE_REQUIRED`（`params.candidates` 是候选列表），调用方什么都不写；没有候选才可以新建。
 * `matchNames` 只放用户实际给出的名字。
 */
export const requireNoCityCandidates = (
  places: readonly CanonicalPlace[],
  countryId: PlaceId,
  input: { names: { zh: string; en: string }; matchNames?: { zh?: string; en?: string }; location: { lat: number; lng: number } | undefined; createNew: boolean },
): void => {
  if (input.createNew) return
  const candidates = findCityCandidates(places, countryId, input.matchNames ?? input.names, input.location)
  if (candidates.length === 0) return
  const placeById = new Map(places.map((place) => [place.id, place]))
  throw new V2WriteError('E_PLACE_CHOICE_REQUIRED', {
    subtype: 'city',
    countryId,
    candidates: candidates.map((candidate): PlaceChoiceCandidateParam => {
      const found = placeById.get(candidate.placeId)?.location
      return {
        placeId: candidate.placeId,
        names: { ...candidate.names },
        ...(found !== undefined ? { location: { lat: found.lat, lng: found.lng } } : {}),
        ...(candidate.distanceKm !== undefined ? { distanceKm: candidate.distanceKm } : {}),
        strong: candidate.strong,
      }
    }),
  })
}

/**
 * 删除之后清理没人引用的地点（3C-5 C1 从 v2write/transaction.ts（3C-5 E 删除）的 removeUnreferencedPlaces 迁来）：只考虑候选，
 * 一轮删掉此刻没人引用的全部候选（`removableNow` 按注册表顺序给出），删掉的城市不再引用它的国家，所以再来一轮，直到没有可删的。
 * 返回被删的 id（按删除的先后；同一轮内按注册表顺序）。「引用」由调用方定义：V2 看五个文件里的地点引用，存储原生看所有图层的行。
 */
export const pruneUnreferencedPlaces = (
  candidates: Iterable<PlaceId>,
  removableNow: (pending: ReadonlySet<PlaceId>) => readonly PlaceId[],
  remove: (ids: readonly PlaceId[]) => void,
): PlaceId[] => {
  const pending = new Set(candidates)
  const removed: PlaceId[] = []
  for (;;) {
    const removable = removableNow(pending)
    if (removable.length === 0) break
    remove(removable)
    for (const id of removable) pending.delete(id)
    removed.push(...removable)
  }
  return removed
}
