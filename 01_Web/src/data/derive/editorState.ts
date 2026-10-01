/**
 * editor-state 的类型、解析与排序（RFC-LOC-1 PR1 搬自 `src/data/editorState.ts`）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * `parseEditorState` 给 V2 写入读旧形状的 editor-state（`../canonical/reconstruct.ts`），`orderBySavedIds` 给派生排序。
 * RFC-LOC-1 PR5b 删除了只给旧派生用的 `deriveEditorState` 与 `emptyEditorState`。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { CityId, CountryId } from '../../types/travel.ts'

export type LocalEditorCountry = {
  id: CountryId
  nameZh: string
  nameEn: string
  countryCode: string
  centerLat: number
  centerLng: number
  region?: string
  visitedDate?: string
}

export type TravelAtlasEditorState = {
  schemaVersion: 1
  addedCountries: LocalEditorCountry[]
  countryOrder: CountryId[]
  hiddenCountryIds: CountryId[]
  cityOrderByCountry: Record<CountryId, CityId[]>
  hiddenCityIds: CityId[]
  mediaOrderByCity: Record<CityId, string[]>
  hiddenMediaIds: string[]
  coverMediaByCity: Record<CityId, string>
  droneOrderByCity: Record<CityId, string[]>
  hiddenDroneMediaIds: string[]
  updatedAt?: string
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isStringArrayRecord = (value: unknown): value is Record<string, string[]> =>
  Boolean(value)
  && typeof value === 'object'
  && Object.values(value as Record<string, unknown>).every(isStringArray)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  Boolean(value)
  && typeof value === 'object'
  && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')

const isLocalEditorCountry = (value: unknown): value is LocalEditorCountry => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LocalEditorCountry>
  return typeof candidate.id === 'string'
    && typeof candidate.nameZh === 'string'
    && typeof candidate.nameEn === 'string'
    && typeof candidate.countryCode === 'string'
    && typeof candidate.centerLat === 'number'
    && typeof candidate.centerLng === 'number'
}

export const parseEditorState = (value: unknown): TravelAtlasEditorState | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<TravelAtlasEditorState>
  if (candidate.schemaVersion !== 1) return undefined

  return {
    schemaVersion: 1,
    addedCountries: Array.isArray(candidate.addedCountries)
      ? candidate.addedCountries.filter(isLocalEditorCountry)
      : [],
    countryOrder: isStringArray(candidate.countryOrder) ? candidate.countryOrder : [],
    hiddenCountryIds: isStringArray(candidate.hiddenCountryIds) ? candidate.hiddenCountryIds : [],
    cityOrderByCountry: isStringArrayRecord(candidate.cityOrderByCountry) ? candidate.cityOrderByCountry : {},
    hiddenCityIds: isStringArray(candidate.hiddenCityIds) ? candidate.hiddenCityIds : [],
    mediaOrderByCity: isStringArrayRecord(candidate.mediaOrderByCity) ? candidate.mediaOrderByCity : {},
    hiddenMediaIds: isStringArray(candidate.hiddenMediaIds) ? candidate.hiddenMediaIds : [],
    coverMediaByCity: isStringRecord(candidate.coverMediaByCity) ? candidate.coverMediaByCity : {},
    droneOrderByCity: isStringArrayRecord(candidate.droneOrderByCity) ? candidate.droneOrderByCity : {},
    hiddenDroneMediaIds: isStringArray(candidate.hiddenDroneMediaIds) ? candidate.hiddenDroneMediaIds : [],
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
  }
}

export const orderBySavedIds = <T extends { id: string }>(items: T[], savedOrder?: string[]) => {
  if (!savedOrder?.length) return items
  const rank = new Map(savedOrder.map((id, index) => [id, index]))

  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.id)
    const rightRank = rank.get(right.id)
    if (leftRank === undefined && rightRank === undefined) return 0
    if (leftRank === undefined) return 1
    if (rightRank === undefined) return -1
    return leftRank - rightRank
  })
}
