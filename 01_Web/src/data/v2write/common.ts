/**
 * V2 写入各端点共用的小件（RFC-LOC-1 PR3b-2 规格 §2.2、§2.3、§2.6）：输入校验、「先找后建」、足迹判断、
 * 国家排序与行程 id。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。输入校验的规则与文案照抄旧模式
 * （插件的 requireText / numberInRange，以及旧格式的写入模块 want-to-go-store.mjs、convert-to-travel.mjs——
 * 这两个模块已在 RFC-LOC-1 PR5a 删除，见 PR5；规则与文案今天就以本目录为准），只是抛带码的 V2WriteError。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { resolveCity, resolveCountry } from '../canonical/placeResolver.ts'
import { EN, ZH, namesOf } from '../canonical/reconstruct.ts'
import type { CanonicalPlace, PlaceId } from '../canonical/types.ts'
import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { V2WriteError, fail } from './errors.ts'
import type { V2Draft, V2WriteContext } from './transaction.ts'

// ---------------------------------------------------------------------------
// 输入校验（旧规则、旧文案）
// ---------------------------------------------------------------------------

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 请求体不是对象时按空对象处理（旧模式里 `input.x` 读到 undefined，报「请填写…」）。 */
export const bodyOf = (input: unknown): Record<string, unknown> => (isObject(input) ? input : {})

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 旧 requireText：trim 后非空，否则 `请填写<字段>。`。 */
export const requireText = (value: unknown, field: string): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) fail('E_REQUIRED', { field })
  return text
}

/** trim 后的非空字符串，否则 undefined。 */
export const optionalText = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

/** 旧插件 numberInRange：缺值为 `请填写<字段>。`，不是数字或超出范围为 `<字段>无效。`。 */
export const requiredNumberInRange = (value: unknown, min: number, max: number, field: string): number => {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) fail('E_REQUIRED', { field })
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) fail('E_NUMBER_INVALID', { field })
  return number
}

/** 旧想去 store 的 numberInRange：只判断「是有限数字且在范围内」。 */
export const numberInRange = (value: unknown, min: number, max: number, field: string): number => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) fail('E_NUMBER_INVALID', { field })
  return number
}

/** 旧 addTravelRecord / convert-to-travel（PR5 删除，规则留在这里）的日期规则：到访日期必填，结束日期可选，都是 YYYY-MM-DD，结束不早于开始。 */
export const visitDates = (
  start: unknown,
  end: unknown,
  fields: { start: string; end: string },
): { start: string; end?: string } => {
  const startDate = requireText(start, fields.start)
  if (!DATE_PATTERN.test(startDate)) fail('E_DATE_FORMAT', { field: fields.start })
  const endDate = optionalText(end)
  if (endDate && !DATE_PATTERN.test(endDate)) fail('E_DATE_FORMAT', { field: fields.end })
  if (endDate && endDate < startDate) fail('E_DATE_ORDER')
  return endDate ? { start: startDate, end: endDate } : { start: startDate }
}

/** 两位英文字母的国家代码（大写）。 */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/

/** 本地日期而不是 UTC 日期（同旧想去 store：加入日期是给人看的）。 */
export const localDate = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// ---------------------------------------------------------------------------
// 地点：先找后建（RFC ID-6，PR3b-2 规格 §2.2）
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
  const resolution = resolveCountry(places, iso)
  if (resolution.status === 'found') return { place: resolution.place, changed: false }
  if (resolution.status === 'ambiguous') {
    throw new V2WriteError('E_PLACE_AMBIGUOUS', { subtype: 'country', iso, candidates: resolution.candidates })
  }
  const code = iso.trim().toUpperCase()
  const entry = draft.ctx.countryCatalog.get(code)
  if (!entry) return fail('E_COUNTRY_NOT_IN_CATALOG', { iso: code })
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

/**
 * 在国家 `countryId` 下按 FR-MR-5 合并键找城市地点：找到就复用；多于一个报 `E_PLACE_AMBIGUOUS`；
 * 找不到就新建（`names` / `partOf` / `location` 取自输入；不写 `legacyKeys`）。
 * 复用的城市没有坐标、而输入带了坐标时，把输入的坐标补到地点上（否则新足迹城市在地图上没有标记）；
 * 已有坐标的不改。
 */
export const ensureCityPlace = (
  draft: V2Draft,
  countryId: PlaceId,
  names: { zh: string; en: string },
  location: { lat: number; lng: number } | undefined,
): EnsuredPlace => {
  const places = draft.files.places.places
  const resolution = resolveCity(places, countryId, names)
  if (resolution.status === 'ambiguous') {
    throw new V2WriteError('E_PLACE_AMBIGUOUS', { subtype: 'city', countryId, candidates: resolution.candidates })
  }
  if (resolution.status === 'found') {
    const place = resolution.place
    if (place.location === undefined && location !== undefined) {
      place.location = { lat: location.lat, lng: location.lng }
      return { place, changed: true }
    }
    return { place, changed: false }
  }
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

/**
 * 新变成「已去过」的记录的 `journeyId`（PR3b-2 规格 §2.6）：已有一条已去过的记录与它的 `trip_title`
 * 完全相同（且带 journeyId）→ 沿用那条的（取文件里的第一条）；否则 `journey-<UUIDv7>`。
 * Canonical 派生把没有 journeyId 的记录全部归入 'unknown-journey'，会把互不相干的城市连成路线，所以必须在创建时写入。
 */
export const journeyIdFor = (files: V2Files, tripTitle: string | undefined, ctx: V2WriteContext): string => {
  if (tripTitle) {
    const sameTrip = files.travel.records.find((record) => (
      isVisited(record) && record.trip_title === tripTitle && typeof record.journeyId === 'string' && record.journeyId !== ''
    ))
    if (sameTrip?.journeyId) return sameTrip.journeyId
  }
  return `journey-${ctx.newId()}`
}

/** 记录坐标与城市地点的规范坐标完全相同（这时 V2 文件省略记录的 lat / lng）。 */
export const sameAsLocation = (place: CanonicalPlace, lat: number, lng: number): boolean =>
  place.location !== undefined && place.location.lat === lat && place.location.lng === lng
