/**
 * V2 写入各端点共用的小件（RFC-LOC-1 PR3b-2 规格 §2.2、§2.3、§2.6；第 2A 批）：输入校验、地点（国家按 ISO
 * 先找后建；城市按名字只找候选、由用户选择）、足迹判断与国家排序。行程 id 由用户选择，见 ./journeyChoice.ts（第 2C 批）。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。输入校验的规则与文案照抄旧模式
 * （插件的 requireText / numberInRange，以及旧格式的写入模块 want-to-go-store.mjs、convert-to-travel.mjs——
 * 这两个模块已在 RFC-LOC-1 PR5a 删除，见 PR5；规则与文案今天就以本目录为准），只是抛带码的 V2WriteError。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { EN, ZH, namesOf } from '../canonical/reconstruct.ts'
import { chooseCountry, requireNoCityCandidates } from '../editor/rules/places.ts'
import type { CanonicalPlace, PlaceId } from '../canonical/types.ts'
import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { fail } from './errors.ts'
import { DATE_PATTERN } from '../editor/rules/input.ts'
import type { V2Draft } from './transaction.ts'

// ---------------------------------------------------------------------------
// 输入校验（旧规则、旧文案）：3C-5 C1 起在 ../editor/rules/input.ts，存储原生的写入共用
// ---------------------------------------------------------------------------

export {
  COUNTRY_CODE_PATTERN, DATE_PATTERN, bodyOf, createNewOf, isObject, localDate, numberInRange, optionalText, requireText, requiredNumberInRange,
  visitDates,
} from '../editor/rules/input.ts'

// ---------------------------------------------------------------------------
// 地点：国家按 ISO 先找后建；城市按名字只找候选，身份靠用户明确选择的地点 id（RFC ID-6，第 2A 批）
// ---------------------------------------------------------------------------

/** 显示用的名称：中文名，没有则英文名。 */
export const zhNameOf = (place: CanonicalPlace | undefined): string => place?.names[ZH] ?? place?.names[EN] ?? ''

export interface EnsuredPlace {
  place: CanonicalPlace
  /** 地点注册表因此改动了（新建，或给已有地点补了坐标）。 */
  changed: boolean
}

/**
 * 按 ISO 找国家地点：找到就复用；多于一个报 `E_PLACE_AMBIGUOUS`；找不到就按国家目录新建
 * （`names` 取目录的中英文名、`externalIds.iso3166Alpha2`、`location` 取目录中心；不写 `legacyKeys`）。
 * 目录里也没有 → `E_COUNTRY_NOT_IN_CATALOG`。
 */
export const ensureCountryPlace = (draft: V2Draft, iso: string): EnsuredPlace => {
  const places = draft.files.places.places
  const choice = chooseCountry(places, iso, draft.ctx.countryCatalog)
  if ('found' in choice) return { place: choice.found, changed: false }
  const { code, entry } = choice.create
  const place: CanonicalPlace = {
    id: draft.ctx.newId(),
    subtype: 'country',
    names: namesOf(entry.nameZh, entry.nameEn),
    externalIds: { iso3166Alpha2: code },
    location: { lat: entry.centerLat, lng: entry.centerLng },
  }
  places.push(place)
  return { place, changed: true }
}

/** `E_PLACE_CHOICE_REQUIRED` 的一个候选：判定在 ../editor/rules/places.ts。 */
export type { PlaceChoiceCandidateParam } from '../editor/rules/places.ts'

/**
 * 按名字新增城市（第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）：名字和坐标只用来找候选，不决定身份。
 * - `createNew` 为 true：一定新建独立地点，不做匹配；
 * - 否则在国家 `countryId` 下找候选（../canonical/placeResolver.ts 的 `findCityCandidates`）：有任何候选 →
 *   `E_PLACE_CHOICE_REQUIRED`（`params.candidates` 是候选列表），不写；没有候选才新建。
 * `matchNames` 只放用户实际给出的名字（用于找候选）；新建的地点用 `names`（`names` / `partOf` / `location` 取自输入；
 * 不写 `legacyKeys`）。引用已有地点走 `referencedCityPlace`（明确的地点 id），这里从不按名字复用。
 */
export const newOrChosenCityPlace = (
  draft: V2Draft,
  countryId: PlaceId,
  input: {
    names: { zh: string; en: string }
    matchNames?: { zh?: string; en?: string }
    location: { lat: number; lng: number } | undefined
    createNew: boolean
  },
): EnsuredPlace => {
  const places = draft.files.places.places
  const { names, location } = input
  requireNoCityCandidates(places, countryId, input)
  const place: CanonicalPlace = {
    id: draft.ctx.newId(),
    subtype: 'city',
    names: namesOf(names.zh, names.en),
    partOf: countryId,
    ...(location !== undefined ? { location: { lat: location.lat, lng: location.lng } } : {}),
  }
  places.push(place)
  return { place, changed: true }
}

/**
 * 用户明确选择的已有城市（按地点 id 引用，不按名字重新匹配）：必须是城市地点，且所属国家地点存在；否则
 * `E_UNKNOWN_PLACE_REF`。地点没有坐标、而输入带了坐标时补上（否则新足迹城市在地图上没有标记）；已有坐标的不改。
 * 返回城市与它的国家。
 */
export const referencedCityPlace = (
  draft: V2Draft,
  placeId: PlaceId,
  location: { lat: number; lng: number } | undefined,
): EnsuredPlace & { country: CanonicalPlace } => {
  const place = draft.placeById(placeId)
  const country = place?.subtype === 'city' && place.partOf !== undefined ? draft.placeById(place.partOf) : undefined
  if (!place || country?.subtype !== 'country') return fail('E_UNKNOWN_PLACE_REF', { placeId })
  return { place, country, changed: fillMissingLocation(place, location) }
}

/** 国家地点没有坐标、而输入带了坐标时补上（想去国家）。 */
export const fillMissingLocation = (place: CanonicalPlace, location: { lat: number; lng: number } | undefined): boolean => {
  if (place.location !== undefined || location === undefined) return false
  place.location = { lat: location.lat, lng: location.lng }
  return true
}

// ---------------------------------------------------------------------------
// 足迹
// ---------------------------------------------------------------------------

/** 地点所属的国家地点 id：国家是自己，城市是 partOf。 */
export const countryIdOfPlace = (files: V2Files, placeId: PlaceId): PlaceId | undefined => {
  const place = files.places.places.find((candidate) => candidate.id === placeId)
  if (!place) return undefined
  return place.subtype === 'country' ? place.id : place.partOf
}

const isVisited = (record: V2TravelRecord) => record.status !== 'planned'

/**
 * 国家是否已在足迹中：有已去过的记录，或已有 `addedCountries` 条目。planned 不算
 * （与旧模式 isCountryInFootprint 同义）。
 */
export const isCountryInFootprint = (files: V2Files, countryId: PlaceId): boolean => (
  files.travel.records.some((record) => isVisited(record) && countryIdOfPlace(files, record.placeId) === countryId)
  || files.editorState.addedCountries.some((entry) => entry.placeId === countryId)
)

/**
 * 国家按最近到访日期重排（与旧模式 sortCountryIdsByLatestVisit 同一算法，只是按地点 id）：
 * 现有顺序 ∪ 已去过记录的国家 ∪ addedCountries，按最近日期倒序，同日期保持现有先后。
 * 日期只看已去过的记录（与旧模式的想去 / planned 转足迹相同：planned 的日期是计划日期，不是到访日期）
 * 与 addedCountries 的首次到访日期。
 */
export const sortCountryIdsByLatestVisit = (files: V2Files): PlaceId[] => {
  const latest = new Map<PlaceId, string>()
  const remember = (countryId: PlaceId, value: unknown) => {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return
    const current = latest.get(countryId)
    if (!current || value > current) latest.set(countryId, value)
  }
  const visitedCountryIds: PlaceId[] = []
  for (const record of files.travel.records) {
    if (!isVisited(record)) continue
    const countryId = countryIdOfPlace(files, record.placeId)
    if (countryId === undefined) continue
    visitedCountryIds.push(countryId)
    remember(countryId, record.start_date)
    remember(countryId, record.end_date)
  }
  for (const entry of files.editorState.addedCountries) remember(entry.placeId, entry.visitedDate)

  const countryIds = [...new Set([
    ...files.editorState.countryOrder,
    ...visitedCountryIds,
    ...files.editorState.addedCountries.map((entry) => entry.placeId),
  ])]
  const rank = new Map(countryIds.map((id, index) => [id, index]))
  return countryIds.sort((left, right) => {
    const dateOrder = (latest.get(right) ?? '').localeCompare(latest.get(left) ?? '')
    return dateOrder || (rank.get(left) ?? 0) - (rank.get(right) ?? 0)
  })
}

/** 重排 countryOrder；顺序有变化时返回 true（这时才需要写 editor-state）。 */
export const reorderCountries = (files: V2Files): boolean => {
  const next = sortCountryIdsByLatestVisit(files)
  const changed = next.length !== files.editorState.countryOrder.length
    || next.some((id, index) => id !== files.editorState.countryOrder[index])
  if (changed) files.editorState.countryOrder = next
  return changed
}

/** 记录坐标与城市地点的规范坐标完全相同（这时 V2 文件省略记录的 lat / lng）。 */
export const sameAsLocation = (place: CanonicalPlace, lat: number, lng: number): boolean =>
  place.location !== undefined && place.location.lat === lat && place.location.lng === lng
