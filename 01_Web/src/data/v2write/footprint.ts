/**
 * 足迹与国家的 V2 写入（RFC-LOC-1 PR3b-2 规格 §2.3）：新增足迹（`POST /records`）、新增国家
 * （`POST /countries`）、彻底删除已隐藏的国家（`POST /countries/delete`）。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。全部按地点 id 读写 `data/v2/`；新增时用与迁移共用的解析
 * 函数先找后建（./common.ts）；不回落、不复制样例。写盘顺序见 ./transaction.ts。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { PlaceId } from '../canonical/types.ts'
import type { V2FileKey, V2TravelRecord } from '../canonical/v2Schema.ts'
import { V2WriteError, fail } from './errors.ts'
import {
  COUNTRY_CODE_PATTERN,
  DATE_PATTERN,
  bodyOf,
  ensureCityPlace,
  ensureCountryPlace,
  isCountryInFootprint,
  journeyIdFor,
  optionalText,
  reorderCountries,
  requireText,
  requiredNumberInRange,
  sameAsLocation,
  visitDates,
  zhNameOf,
} from './common.ts'
import { removeUnreferencedPlaces, runV2Transaction, type V2FilesOrEmpty, type V2WriteContext, type V2WriteOutcome } from './transaction.ts'

/** 旧模式「足迹已创建，但……」：新增足迹之后国家排序没写成。 */
export const REORDER_FAILURE = '足迹已创建，但国家列表的排序没有更新（{reason}）。'

type WriteList = { file: V2FileKey; onFailure?: string }[]

// ---------------------------------------------------------------------------
// POST /records：新增足迹
// ---------------------------------------------------------------------------

export interface AddTravelRecordResult {
  id: string
  countryId: PlaceId
  cityId: PlaceId
}

/**
 * 新增一条足迹（一个新城市）。
 * - 输入与旧模式相同（`country` / `country_en` / `city` / `city_en` / `start_date` / `end_date?` / `lat` / `lng` /
 *   `country_code` / `trip_title?`），校验与文案相同；V2 下 `country_code` 必填（`E_COUNTRY_CODE_REQUIRED`）。
 * - 国家按 `country_code` 解析（没有就按目录新建）；城市按 `city` / `city_en` 在该国家下解析：找到就复用
 *   （包括只被想去引用的城市），找不到就新建。国家与城市的名称以地点为准，输入的名称只用于解析与新建。
 * - 任何记录（含 planned）已引用该城市 → `E_CITY_EXISTS`（沿用旧文案）。
 * - 新记录：UUIDv7 `id`、`placeId`、日期、`year`、`trip_title`（默认「国家中文名 · 城市中文名」）、
 *   `type: 'visit'`、`status: 'visited'`、`source: 'local-editor'`、`journeyId`（./common.ts）。坐标与城市
 *   `location` 相同就省略，否则写入。
 * - 国家首次进入足迹时按最近到访日期重排 `countryOrder`。
 * 写盘：地点注册表（有新地点或补了坐标时）→ 足迹 → editor-state（排序变了时）。
 */
export function addTravelRecord(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<AddTravelRecordResult> {
  const body = bodyOf(input)
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
  const tripTitleInput = optionalText(body.trip_title)

  return runV2Transaction(files, ctx, (draft) => {
    const country = ensureCountryPlace(draft, countryCode)
    const wasInFootprint = isCountryInFootprint(draft.files, country.place.id)
    const city = ensureCityPlace(draft, country.place.id, { zh: cityZh, en: cityEn }, { lat, lng })
    if (draft.files.travel.records.some((record) => record.placeId === city.place.id)) fail('E_CITY_EXISTS', { cityId: city.place.id })

    const tripTitle = tripTitleInput ?? `${zhNameOf(country.place)} · ${zhNameOf(city.place)}`
    const record: V2TravelRecord = {
      id: ctx.newId(),
      placeId: city.place.id,
      start_date: dates.start,
      ...(dates.end ? { end_date: dates.end } : {}),
      year: Number(dates.start.slice(0, 4)),
      trip_title: tripTitle,
      type: 'visit',
      status: 'visited',
      ...(sameAsLocation(city.place, lat, lng) ? {} : { lat, lng }),
      source: 'local-editor',
      journeyId: journeyIdFor(draft.files, tripTitle, ctx),
    }
    draft.files.travel.records.push(record)
    const reordered = !wasInFootprint && reorderCountries(draft.files)

    const writes: WriteList = []
    if (country.changed || city.changed) writes.push({ file: 'places' })
    writes.push({ file: 'travel' })
    if (reordered) writes.push({ file: 'editorState', onFailure: REORDER_FAILURE })
    return { result: { id: record.id, countryId: country.place.id, cityId: city.place.id }, writes }
  })
}

// ---------------------------------------------------------------------------
// POST /countries：新增国家
// ---------------------------------------------------------------------------

/**
 * 新增一个（还没有城市的）国家：`{ countryCode, visitedDate }`。
 * - 按 ISO 解析；该国家已在足迹中（有已去过的记录，或已有 addedCountries 条目）→ `E_COUNTRY_EXISTS`。
 * - 国家地点已存在（例如只被想去或 planned 引用）就复用，否则按目录新建；目录里没有 → `E_COUNTRY_NOT_IN_CATALOG`。
 * - 追加 `addedCountries: { placeId, region?, visitedDate }`（region 取目录的大洲，同旧模式），并按最近到访日期重排 `countryOrder`。
 * 写盘：地点注册表（新建时）→ editor-state。
 */
export function addCountry(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<{ countryId: PlaceId }> {
  const body = bodyOf(input)
  const countryCode = requireText(body.countryCode, 'countryCode').toUpperCase()
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) fail('E_COUNTRY_NOT_IN_CATALOG', { iso: countryCode })
  const visitedDate = requireText(body.visitedDate, 'visitedDate')
  if (!DATE_PATTERN.test(visitedDate)) fail('E_DATE_FORMAT', { field: 'visitedDate' })

  return runV2Transaction(files, ctx, (draft) => {
    const country = ensureCountryPlace(draft, countryCode)
    if (isCountryInFootprint(draft.files, country.place.id)) fail('E_COUNTRY_EXISTS', { countryId: country.place.id })
    const region = ctx.countryCatalog.get(countryCode)?.region
    draft.files.editorState.addedCountries.push({ placeId: country.place.id, ...(region ? { region } : {}), visitedDate })
    reorderCountries(draft.files)

    const writes: WriteList = []
    if (country.changed) writes.push({ file: 'places' })
    writes.push({ file: 'editorState' })
    return { result: { countryId: country.place.id }, writes }
  })
}

// ---------------------------------------------------------------------------
// POST /countries/delete：彻底删除已隐藏的国家
// ---------------------------------------------------------------------------

export interface DeleteCountriesResult {
  deletedCountryIds: PlaceId[]
  deletedRecordCount: number
}

/** 删除的第二步失败：editor-state 已清掉这个国家（它不再隐藏），足迹记录还在。 */
export const DELETE_RECORDS_FAILURE = '国家的编辑状态已清除，但足迹记录没有删除（{reason}）。这个国家会重新显示，可以再次隐藏后彻底删除。'
/** 删除的最后一步失败：只剩没人引用的地点。 */
export const DELETE_PLACES_FAILURE = '国家已删除，但地点注册表没有清理（{reason}）。这不影响显示。'

/**
 * 彻底删除已隐藏的国家：`{ ids }`（国家地点 id）。前置条件与旧模式相同：
 * - 没有 id → `E_COUNTRY_DELETE_EMPTY`；有没隐藏的 → `E_COUNTRY_DELETE_NOT_HIDDEN`；
 * - 既没有足迹记录也没有 addedCountries 条目 → `E_COUNTRY_DELETE_NO_DATA`；
 * - 该国家的城市还有媒体 → `E_COUNTRY_HAS_MEDIA`（列出城市与媒体数）。
 * 删除：该国家下城市的全部记录（含 planned）、addedCountries 条目、editor-state 里涉及这个国家与它的城市的键与值；
 * 然后删除不再被任何数据引用的这个国家及其城市地点——仍被想去、媒体、显示规则或其他地点引用的保留。
 * 写盘：editor-state → 足迹（有记录时）→ 地点注册表（有地点可删时）。
 */
export function deleteHiddenCountries(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<DeleteCountriesResult> {
  const body = bodyOf(input)
  const ids = Array.isArray(body.ids) && body.ids.every((id) => typeof id === 'string')
    ? [...new Set((body.ids as string[]).map((id) => id.trim()).filter(Boolean))]
    : []
  if (ids.length === 0) fail('E_COUNTRY_DELETE_EMPTY')
  const idSet = new Set(ids)

  return runV2Transaction(files, ctx, (draft) => {
    const { editorState, travel } = draft.files
    const hidden = new Set(editorState.hiddenCountryIds)
    if (ids.some((id) => !hidden.has(id))) fail('E_COUNTRY_DELETE_NOT_HIDDEN')

    const countryOfCity = (placeId: PlaceId) => {
      const place = draft.placeById(placeId)
      return place?.subtype === 'city' ? place.partOf : undefined
    }
    const targetRecords = travel.records.filter((record) => idSet.has(countryOfCity(record.placeId) ?? ''))
    const addedIds = new Set(editorState.addedCountries.map((entry) => entry.placeId))
    if (ids.some((id) => !targetRecords.some((record) => countryOfCity(record.placeId) === id) && !addedIds.has(id))) {
      fail('E_COUNTRY_DELETE_NO_DATA')
    }

    const blockingMedia = draft.files.media.items.filter((item) => idSet.has(countryOfCity(item.placeId) ?? ''))
    if (blockingMedia.length > 0) {
      const counts = new Map<PlaceId, number>()
      for (const item of blockingMedia) counts.set(item.placeId, (counts.get(item.placeId) ?? 0) + 1)
      throw new V2WriteError('E_COUNTRY_HAS_MEDIA', {
        cities: [...counts].map(([placeId, count]) => ({ placeId, name: zhNameOf(draft.placeById(placeId)) || placeId, count })),
      })
    }

    // 这个国家的全部城市地点（不只是有记录的）：editor-state 里涉及它们的键与值一并清掉。
    const cityIds = new Set(draft.files.places.places
      .filter((place) => place.subtype === 'city' && place.partOf !== undefined && idSet.has(place.partOf))
      .map((place) => place.id))
    const omitKeys = <T,>(record: Record<PlaceId, T>, keys: ReadonlySet<PlaceId>) =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)))

    draft.files.editorState = {
      ...editorState,
      addedCountries: editorState.addedCountries.filter((entry) => !idSet.has(entry.placeId)),
      countryOrder: editorState.countryOrder.filter((id) => !idSet.has(id)),
      hiddenCountryIds: editorState.hiddenCountryIds.filter((id) => !idSet.has(id)),
      cityOrderByCountry: Object.fromEntries(Object.entries(editorState.cityOrderByCountry)
        .filter(([countryId]) => !idSet.has(countryId))
        .map(([countryId, cityIds_]) => [countryId, cityIds_.filter((id) => !cityIds.has(id))])),
      hiddenCityIds: editorState.hiddenCityIds.filter((id) => !cityIds.has(id)),
      mediaOrderByCity: omitKeys(editorState.mediaOrderByCity, cityIds),
      coverMediaByCity: omitKeys(editorState.coverMediaByCity, cityIds),
      droneOrderByCity: omitKeys(editorState.droneOrderByCity, cityIds),
    }
    const targetIds = new Set(targetRecords)
    travel.records = travel.records.filter((record) => !targetIds.has(record))
    const removedPlaces = removeUnreferencedPlaces(draft.files, [...cityIds, ...ids])

    const writes: WriteList = [{ file: 'editorState' }]
    if (targetRecords.length > 0) writes.push({ file: 'travel', onFailure: DELETE_RECORDS_FAILURE })
    if (removedPlaces.length > 0) writes.push({ file: 'places', onFailure: DELETE_PLACES_FAILURE })
    return { result: { deletedCountryIds: ids, deletedRecordCount: targetRecords.length }, writes }
  })
}
