/**
 * 想去 / planned → 足迹的 V2 写入（`POST /wanttogo/convert`，RFC-LOC-1 PR3b-2 规格 §2.3、§2.6）。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。请求体二选一，与旧模式相同：
 * - `{ source: 'want-to-go', id, startDate, endDate?, tripTitle?, keepWantToGo? }`
 * - `{ source: 'planned', recordId, startDate, endDate? }`
 * 校验与拒绝文案沿用旧的 convert-to-travel.mjs（RFC-LOC-1 PR5a 删除，见 PR5；今天以本文件为准）与插件；
 * 返回值形状同旧（`countryId` / `cityId` 为地点 id）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { PlaceId } from '../canonical/types.ts'
import type { V2FileKey, V2TravelRecord } from '../canonical/v2Schema.ts'
import { fail } from './errors.ts'
import {
  bodyOf,
  isCountryInFootprint,
  journeyIdFor,
  optionalText,
  reorderCountries,
  requireText,
  visitDates,
  zhNameOf,
} from './common.ts'
import { REORDER_FAILURE } from './footprint.ts'
import { runV2Transaction, type V2FilesOrEmpty, type V2WriteContext, type V2WriteOutcome } from './transaction.ts'

export interface ConvertToTravelResult {
  travelRecordId: string
  countryId: PlaceId
  cityId: PlaceId
  wantToGoRemoved: boolean
}

/** 旧模式「足迹已创建，但……」：想去条目没有移除。 */
export const WTG_REMOVE_FAILURE = '足迹已创建，但想去条目没有移除（{reason}）。可以在想去列表里隐藏或彻底删除它。'

type WriteList = { file: V2FileKey; onFailure?: string }[]

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 想去条目 → 足迹。地点就是 `item.placeId`：必须是有坐标的城市、条目没被隐藏，否则沿用旧的三种拒绝文案；
 * 任何记录（含 planned）已引用该城市 → `E_CONVERT_CITY_IN_FOOTPRINT`（沿用旧文案）。
 * 新记录的规则同「新增足迹」（../v2write/footprint.ts），坐标就是城市的 location（因而省略）；
 * `keepWantToGo !== true` 时移除条目（地点仍被新记录引用，保留）。国家首次进入足迹时按 ISO 目录保存洲信息，
 * 并重排 `countryOrder`；已有国家信息不覆盖，目录缺失时不猜测洲。
 * 写盘：足迹 → 想去（移除条目时）→ editor-state（排序变了时）。
 */
const convertWantToGoItem = (files: V2FilesOrEmpty | undefined, body: Record<string, unknown>, ctx: V2WriteContext) => {
  const id = requireText(body.id, 'id')
  if (body.keepWantToGo !== undefined && typeof body.keepWantToGo !== 'boolean') fail('E_KEEP_WTG_NOT_BOOLEAN')

  return runV2Transaction(files, ctx, (draft) => {
    const item = draft.files.wantToGo.items.find((candidate) => candidate.id === id)
    if (!item) return fail('E_WTG_NOT_FOUND', { id })
    const city = draft.placeById(item.placeId)
    if (city?.subtype !== 'city') return fail('E_CONVERT_COUNTRY_KIND')
    if (!city.location) return fail('E_CONVERT_NO_COORDINATES')
    if (item.hidden === true) fail('E_CONVERT_HIDDEN')
    const dates = visitDates(body.startDate, body.endDate, { start: 'startDate', end: 'endDate' })
    if (draft.files.travel.records.some((record) => record.placeId === city.id)) fail('E_CONVERT_CITY_IN_FOOTPRINT', { cityId: city.id })

    const countryId = city.partOf as PlaceId
    const wasInFootprint = isCountryInFootprint(draft.files, countryId)
    const tripTitle = optionalText(body.tripTitle) ?? `${zhNameOf(draft.placeById(countryId))} · ${zhNameOf(city)}`
    const record: V2TravelRecord = {
      id: ctx.newId(),
      placeId: city.id,
      start_date: dates.start,
      ...(dates.end ? { end_date: dates.end } : {}),
      year: Number(dates.start.slice(0, 4)),
      trip_title: tripTitle,
      type: 'visit',
      status: 'visited',
      source: 'local-editor',
      journeyId: journeyIdFor(draft.files, tripTitle, ctx),
    }
    draft.files.travel.records.push(record)
    const wantToGoRemoved = body.keepWantToGo !== true
    if (wantToGoRemoved) draft.files.wantToGo.items = draft.files.wantToGo.items.filter((candidate) => candidate.id !== id)
    const countryCode = draft.placeById(countryId)?.externalIds?.iso3166Alpha2
    const hasCountryInfo = draft.files.editorState.addedCountries.some((country) => country.placeId === countryId)
    const region = !wasInFootprint && !hasCountryInfo && countryCode
      ? ctx.countryCatalog.get(countryCode.trim().toUpperCase())?.region
      : undefined
    if (region) draft.files.editorState.addedCountries.push({ placeId: countryId, region, visitedDate: dates.start })
    const reordered = !wasInFootprint && reorderCountries(draft.files)

    const writes: WriteList = [{ file: 'travel' }]
    if (wantToGoRemoved) writes.push({ file: 'wantToGo', onFailure: WTG_REMOVE_FAILURE })
    if (reordered || region) writes.push({ file: 'editorState', onFailure: REORDER_FAILURE })
    const result: ConvertToTravelResult = { travelRecordId: record.id, countryId, cityId: city.id, wantToGoRemoved }
    return { result, writes }
  })
}

/**
 * planned → 足迹：同一条记录 `status` 改 `visited`，写日期与 `year`（结束日期没填时删掉该键），其它字段原样；
 * 没有 `journeyId` 时补上（./common.ts 的 journeyIdFor），已有的保留。
 * 记录的坐标：自身的 lat / lng，省略时取城市的 location；都没有 → `E_PLANNED_NO_COORDINATES`（沿用旧文案）。
 * 国家首次进入足迹时重排 `countryOrder`。写盘：足迹 → editor-state（排序变了时）。
 */
const convertPlannedTravelRecord = (files: V2FilesOrEmpty | undefined, body: Record<string, unknown>, ctx: V2WriteContext) => {
  const recordId = requireText(body.recordId, 'recordId')

  return runV2Transaction(files, ctx, (draft) => {
    const records = draft.files.travel.records
    const index = records.findIndex((record) => record.id === recordId)
    if (index < 0 || records[index].status !== 'planned') fail('E_PLANNED_NOT_FOUND', { recordId })
    const current = records[index]
    const city = draft.placeById(current.placeId)
    const omitted = !Object.hasOwn(current, 'lat') && !Object.hasOwn(current, 'lng')
    const hasCoordinates = omitted ? city?.location !== undefined : isFiniteNumber(current.lat) && isFiniteNumber(current.lng)
    if (!hasCoordinates) fail('E_PLANNED_NO_COORDINATES', { recordId })
    const dates = visitDates(body.startDate, body.endDate, { start: 'startDate', end: 'endDate' })

    const countryId = city?.partOf as PlaceId
    const wasInFootprint = isCountryInFootprint(draft.files, countryId)
    const next: V2TravelRecord = {
      ...current,
      status: 'visited',
      start_date: dates.start,
      end_date: dates.end,
      year: Number(dates.start.slice(0, 4)),
    }
    if (!dates.end) delete next.end_date
    if (typeof next.journeyId !== 'string' || next.journeyId === '') next.journeyId = journeyIdFor(draft.files, next.trip_title, ctx)
    records[index] = next
    const reordered = !wasInFootprint && reorderCountries(draft.files)

    const writes: WriteList = [{ file: 'travel' }]
    if (reordered) writes.push({ file: 'editorState', onFailure: REORDER_FAILURE })
    const result: ConvertToTravelResult = { travelRecordId: current.id, countryId, cityId: current.placeId, wantToGoRemoved: false }
    return { result, writes }
  })
}

/** `POST /wanttogo/convert`：按 `source` 分派；其他来源 → `E_CONVERT_SOURCE_INVALID`（沿用旧文案）。 */
export function convertToTravel(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<ConvertToTravelResult> {
  const body = bodyOf(input)
  if (body.source === 'want-to-go') return convertWantToGoItem(files, body, ctx)
  if (body.source === 'planned') return convertPlannedTravelRecord(files, body, ctx)
  return fail('E_CONVERT_SOURCE_INVALID')
}
