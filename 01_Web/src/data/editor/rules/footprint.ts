/**
 * 足迹、国家与转换的判定（3C-5 C2 从 ../../v2write/footprint.ts、common.ts、convert.ts 迁来，规则、错误码、参数与检查顺序不变；
 * RFC-LOC-1 PR3b-2 规格 §2.3、§2.6；第 2A、2C 批）。
 *
 * - 请求的形状：`POST /records`（三种输入只能选一种）、`POST /countries`、`POST /countries/delete`、`POST /wanttogo/convert`；
 * - 国家是否已在足迹中（有已去过的记录，或已有手动添加的国家）、新记录的默认标题、`E_CITY_EXISTS`、`E_COUNTRY_HAS_MEDIA` 的参数；
 * - 国家按最近到访日期重排（`sortCountryIdsByLatestVisit`）。
 * 这里只做判定：V2 写入函数（../../v2write/）与存储原生的写入（../native/）给出各自的数据，自己落盘。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { EN, ZH } from '../../canonical/reconstruct.ts'
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'
import { V2WriteError, fail } from '../../v2write/errors.ts'
import {
  COUNTRY_CODE_PATTERN, DATE_PATTERN, bodyOf, createNewOf, optionalText, requireText, requiredNumberInRange, visitDates,
} from './input.ts'
import { journeyChoiceOf, type JourneyChoice } from './journeys.ts'

/** 显示用的名称：中文名，没有则英文名。 */
export const zhNameOf = (place: CanonicalPlace | undefined): string => place?.names[ZH] ?? place?.names[EN] ?? ''

/** 新记录的默认行程标题：「国家中文名 · 城市中文名」。 */
export const defaultTripTitle = (country: CanonicalPlace | undefined, city: CanonicalPlace | undefined): string => `${zhNameOf(country)} · ${zhNameOf(city)}`

// ---------------------------------------------------------------------------
// POST /records
// ---------------------------------------------------------------------------

type VisitDates = { start: string; end?: string }

/** 新增足迹的地点：按名称（国家代码、城市名、坐标、`createNew`），或按地点 id（坐标可省略）。 */
export type RecordTarget =
  | { kind: 'named'; names: { zh: string; en: string }; countryCode: string; coordinates: { lat: number; lng: number }; createNew: boolean; dates: VisitDates }
  | { kind: 'placeId'; placeId: PlaceId; coordinates?: { lat: number; lng: number }; dates: VisitDates }

/** 按地点 id 引用时不能同时出现的字段（三种输入只能选一种）。 */
const NAMED_CITY_FIELDS = ['country', 'country_en', 'city', 'city_en', 'country_code', 'createNew'] as const

/** 按地点 id 引用时的坐标：可省略，给了就要成对且在范围内。 */
const optionalCoordinates = (body: Record<string, unknown>): { lat: number; lng: number } | undefined => {
  const given = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())
  if (given(body.lat) !== given(body.lng)) fail('E_COORDINATES_PAIR')
  if (!given(body.lat)) return undefined
  return { lat: requiredNumberInRange(body.lat, -90, 90, 'lat'), lng: requiredNumberInRange(body.lng, -180, 180, 'lng') }
}

/** 按地点 id 引用：日期必填，坐标可省略。 */
const referencedTargetOf = (body: Record<string, unknown>): RecordTarget => {
  const dates = visitDates(body.start_date, body.end_date, { start: 'start_date', end: 'end_date' })
  return { kind: 'placeId', placeId: String(body.placeId).trim(), coordinates: optionalCoordinates(body), dates }
}

/** 按名称：校验顺序与文案同旧模式。 */
const namedTargetOf = (body: Record<string, unknown>): RecordTarget => {
  requireText(body.country, 'country')
  requireText(body.country_en, 'country_en')
  const cityZh = requireText(body.city, 'city')
  const cityEn = requireText(body.city_en, 'city_en')
  const dates = visitDates(body.start_date, body.end_date, { start: 'start_date', end: 'end_date' })
  const lat = requiredNumberInRange(body.lat, -90, 90, 'lat')
  const lng = requiredNumberInRange(body.lng, -180, 180, 'lng')
  const countryCode = typeof body.country_code === 'string' ? body.country_code.trim().toUpperCase() : ''
  if (!countryCode) fail('E_COUNTRY_CODE_REQUIRED')
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) fail('E_COUNTRY_CODE_INVALID')
  return { kind: 'named', names: { zh: cityZh, en: cityEn }, countryCode, coordinates: { lat, lng }, createNew: createNewOf(body), dates }
}

/** `POST /records` 的请求：地点、给出的行程标题、行程选择（检查的先后同旧模式）。 */
export interface AddTravelRecordRequest {
  readonly target: RecordTarget
  readonly tripTitle?: string
  readonly journeyChoice: JourneyChoice
}

/**
 * 三种输入只能选一种（第 2A 批）：`placeId` 与名称字段或 `createNew` 混用 → `E_UNKNOWN_PLACE_REF`；按地点 id 时日期必填、坐标可省略；
 * 按名称时校验与文案同旧模式（V2 下 `country_code` 必填）。行程选择见 ./journeys.ts。
 */
export const parseAddTravelRecord = (input: unknown): AddTravelRecordRequest => {
  const body = bodyOf(input)
  const referencesPlace = Object.hasOwn(body, 'placeId')
  if (referencesPlace && (typeof body.placeId !== 'string' || !body.placeId.trim() || NAMED_CITY_FIELDS.some((field) => Object.hasOwn(body, field)))) {
    fail('E_UNKNOWN_PLACE_REF')
  }
  const target = referencesPlace ? referencedTargetOf(body) : namedTargetOf(body)
  const tripTitle = optionalText(body.trip_title)
  const journeyChoice = journeyChoiceOf(body)
  return { target, ...(tripTitle !== undefined ? { tripTitle } : {}), journeyChoice }
}

/** 用户按地点 id 选定的城市：必须是城市地点，且所属国家地点存在；否则 `E_UNKNOWN_PLACE_REF`（`params.placeId`）。 */
export const requireChosenCity = (place: CanonicalPlace | undefined, country: CanonicalPlace | undefined, placeId: PlaceId): void => {
  if (!place || place.subtype !== 'city' || country?.subtype !== 'country') fail('E_UNKNOWN_PLACE_REF', { placeId })
}

/** 任何记录（含 planned）已引用这个城市 → `E_CITY_EXISTS`（沿用旧文案）。 */
export const requireCityWithoutRecords = (hasRecords: boolean, cityId: PlaceId): void => {
  if (hasRecords) fail('E_CITY_EXISTS', { cityId })
}

/** 记录的坐标：城市的坐标（没有时上面已用输入的坐标补上）；都没有 → `E_REQUIRED`（`lat`）。 */
export const requireCoordinates = (coordinates: { lat: number; lng: number } | undefined): { lat: number; lng: number } =>
  coordinates ?? fail('E_REQUIRED', { field: 'lat' })

// ---------------------------------------------------------------------------
// POST /countries、POST /countries/delete
// ---------------------------------------------------------------------------

/** `POST /countries` 的 `{ countryCode, visitedDate }`：代码不是两位字母 → `E_COUNTRY_NOT_IN_CATALOG`；日期必填且是 YYYY-MM-DD。 */
export const parseAddCountry = (input: unknown): { countryCode: string; visitedDate: string } => {
  const body = bodyOf(input)
  const countryCode = requireText(body.countryCode, 'countryCode').toUpperCase()
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) fail('E_COUNTRY_NOT_IN_CATALOG', { iso: countryCode })
  const visitedDate = requireText(body.visitedDate, 'visitedDate')
  if (!DATE_PATTERN.test(visitedDate)) fail('E_DATE_FORMAT', { field: 'visitedDate' })
  return { countryCode, visitedDate }
}

/** 国家已在足迹中（有已去过的记录，或已有手动添加的国家）→ `E_COUNTRY_EXISTS`。 */
export const requireCountryNotInFootprint = (inFootprint: boolean, countryId: PlaceId): void => {
  if (inFootprint) fail('E_COUNTRY_EXISTS', { countryId })
}

/** `POST /countries/delete` 的 `{ ids }`：字符串数组，trim、去空、去重；没有 → `E_COUNTRY_DELETE_EMPTY`。 */
export const parseDeleteCountries = (input: unknown): string[] => {
  const body = bodyOf(input)
  const ids = Array.isArray(body.ids) && body.ids.every((id) => typeof id === 'string')
    ? [...new Set((body.ids as string[]).map((id) => id.trim()).filter(Boolean))]
    : []
  if (ids.length === 0) fail('E_COUNTRY_DELETE_EMPTY')
  return ids
}

/**
 * 删除国家的前置条件（同旧模式，按这个先后）：有没隐藏的 → `E_COUNTRY_DELETE_NOT_HIDDEN`；一个国家既没有记录（含 planned）
 * 也没有手动添加的条目 → `E_COUNTRY_DELETE_NO_DATA`；这些国家的城市还有媒体 → `E_COUNTRY_HAS_MEDIA`。
 * `mediaCities`：有媒体的城市，按媒体的先后第一次出现的顺序，每个城市的媒体数。
 */
export const requireCountriesDeletable = (
  ids: readonly PlaceId[],
  check: {
    readonly isHidden: (id: PlaceId) => boolean
    readonly hasData: (id: PlaceId) => boolean
    readonly mediaCities: () => readonly { readonly placeId: PlaceId; readonly count: number }[]
    readonly nameOf: (placeId: PlaceId) => string
  },
): void => {
  if (ids.some((id) => !check.isHidden(id))) fail('E_COUNTRY_DELETE_NOT_HIDDEN')
  if (ids.some((id) => !check.hasData(id))) fail('E_COUNTRY_DELETE_NO_DATA')
  const cities = check.mediaCities()
  if (cities.length > 0) {
    throw new V2WriteError('E_COUNTRY_HAS_MEDIA', {
      cities: cities.map(({ placeId, count }) => ({ placeId, name: check.nameOf(placeId) || placeId, count })),
    })
  }
}

// ---------------------------------------------------------------------------
// 国家排序
// ---------------------------------------------------------------------------

/** 排序要看的一条已去过的记录：国家（城市的 partOf；查不到时没有）与日期。 */
export interface CountryVisit {
  readonly countryId: PlaceId | undefined
  readonly start_date?: unknown
  readonly end_date?: unknown
}

/**
 * 国家按最近到访日期重排（与旧模式 sortCountryIdsByLatestVisit 同一算法，只是按地点 id）：
 * 现有顺序 ∪ 已去过记录的国家（按记录的先后）∪ 手动添加的国家，按最近日期倒序，同日期保持现有先后。
 * 日期只看已去过的记录（planned 的日期是计划日期，不是到访日期）与手动添加的国家的首次到访日期。
 */
export const sortCountryIdsByLatestVisit = (input: {
  readonly countryOrder: readonly PlaceId[]
  /** 已去过的记录，按记录的先后。 */
  readonly visits: Iterable<CountryVisit>
  /** 手动添加的国家，按它们的先后。 */
  readonly added: readonly { readonly placeId: PlaceId; readonly visitedDate?: unknown }[]
}): PlaceId[] => {
  const latest = new Map<PlaceId, string>()
  const remember = (countryId: PlaceId, value: unknown) => {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return
    const current = latest.get(countryId)
    if (!current || value > current) latest.set(countryId, value)
  }
  const visitedCountryIds: PlaceId[] = []
  for (const visit of input.visits) {
    if (visit.countryId === undefined) continue
    visitedCountryIds.push(visit.countryId)
    remember(visit.countryId, visit.start_date)
    remember(visit.countryId, visit.end_date)
  }
  for (const entry of input.added) remember(entry.placeId, entry.visitedDate)

  const countryIds = [...new Set([...input.countryOrder, ...visitedCountryIds, ...input.added.map((entry) => entry.placeId)])]
  const rank = new Map(countryIds.map((id, index) => [id, index]))
  return countryIds.sort((left, right) => {
    const dateOrder = (latest.get(right) ?? '').localeCompare(latest.get(left) ?? '')
    return dateOrder || (rank.get(left) ?? 0) - (rank.get(right) ?? 0)
  })
}

/** 两份顺序是否相同（重排之后有变化才写）。 */
export const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index])

// ---------------------------------------------------------------------------
// POST /wanttogo/convert
// ---------------------------------------------------------------------------

/** `POST /wanttogo/convert` 的请求（检查的先后同旧模式：来源 → id → keepWantToGo → 行程选择的写法）。 */
export type ConvertRequest =
  | { readonly source: 'want-to-go'; readonly id: string; readonly keepWantToGo: boolean; readonly journeyChoice: JourneyChoice; readonly body: Record<string, unknown> }
  | { readonly source: 'planned'; readonly recordId: string; readonly journeyChoice: JourneyChoice; readonly body: Record<string, unknown> }

/** 来源不是 want-to-go 或 planned → `E_CONVERT_SOURCE_INVALID`；`keepWantToGo` 不是布尔值 → `E_KEEP_WTG_NOT_BOOLEAN`。 */
export const parseConvertRequest = (input: unknown): ConvertRequest => {
  const body = bodyOf(input)
  if (body.source === 'want-to-go') {
    const id = requireText(body.id, 'id')
    if (body.keepWantToGo !== undefined && typeof body.keepWantToGo !== 'boolean') fail('E_KEEP_WTG_NOT_BOOLEAN')
    return { source: 'want-to-go', id, keepWantToGo: body.keepWantToGo === true, journeyChoice: journeyChoiceOf(body), body }
  }
  if (body.source === 'planned') return { source: 'planned', recordId: requireText(body.recordId, 'recordId'), journeyChoice: journeyChoiceOf(body), body }
  return fail('E_CONVERT_SOURCE_INVALID')
}

/** 转换的日期：`startDate` 必填，`endDate` 可选（规则通过之后才校验）。 */
export const convertDates = (body: Record<string, unknown>): VisitDates =>
  visitDates(body.startDate, body.endDate, { start: 'startDate', end: 'endDate' })

/** 转换时给出的行程标题。 */
export const convertTripTitle = (body: Record<string, unknown>): string | undefined => optionalText(body.tripTitle)

/**
 * 想去转足迹时，国家第一次进入足迹、还没有国家信息、地点有 ISO 代码：按目录保存洲（目录缺失时不猜）。
 * 已有国家信息不覆盖。
 */
export const firstVisitRegion = (
  wasInFootprint: boolean,
  hasCountryInfo: boolean,
  countryCode: string | undefined,
  catalog: ReadonlyMap<string, { readonly region?: string }>,
): string | undefined => (!wasInFootprint && !hasCountryInfo && countryCode ? catalog.get(countryCode.trim().toUpperCase())?.region : undefined)
