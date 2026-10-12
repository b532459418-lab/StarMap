/**
 * 同名行程的选择（第 2C 批；审查 C4 与 §10：标题相同时由用户选择，不按日期自动判断）。
 *
 * 行程的身份是记录上的 `journeyId`。行程标题（`trip_title`）只用来找候选，不再决定新的已去过记录并入哪个行程：
 * - `findJourneyCandidates(files, tripTitle)`：已去过的记录里，`trip_title` 与给定标题完全相同、且带 `journeyId` 的行程，
 *   每个行程附上日期范围与城市，供界面显示；
 * - `journeyIdFor(files, tripTitle, ctx, choice)`：新变成「已去过」的记录用哪个 `journeyId`，由用户的选择决定；
 * - `journeyChoiceOf(body)`：请求里的选择——`journeyId`（加入这个已有行程）或 `newJourney: true`（新建行程）。
 *
 * 与第 2A 批的地点选择同时出现时，【先地点、后行程】：写入端点先确定城市（`E_PLACE_CHOICE_REQUIRED`），再确定行程
 * （`E_JOURNEY_CHOICE_REQUIRED`），一次只返回一种选择。默认标题「国家 · 城市」取决于选定的城市，所以顺序不能反过来。
 *
 * 不改已有记录的 `journeyId`；不看日期判断两次旅行是不是同一次。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { compareCodePoints, compareJourneyRecords } from '../canonical/journeyRoutes.ts'
import { EN, ZH } from '../canonical/reconstruct.ts'
import type { PlaceId } from '../canonical/types.ts'
import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { V2WriteError, fail } from './errors.ts'
import type { V2WriteContext } from './transaction.ts'

/** 候选里最多列出的城市数（另附总数）。 */
export const JOURNEY_CANDIDATE_CITY_LIMIT = 5

/** 候选行程里的一个城市：地点 id 与中英文名（地点数据，不是界面文案）。 */
export interface JourneyCandidateCity {
  placeId: PlaceId
  names: Record<string, string>
}

/** 一个候选行程（`E_JOURNEY_CHOICE_REQUIRED` 的 `params.candidates` 的一项）。 */
export interface JourneyCandidate {
  journeyId: string
  /** 行程标题（就是给定的标题）。 */
  title: string
  /** 行程里最早的开始日期；记录都没有日期时省略。 */
  startDate?: string
  /** 行程里最晚的结束日期（没有结束日期的记录按开始日期算）；记录都没有日期时省略。 */
  endDate?: string
  /** 行程里的城市，按到访先后，最多 `JOURNEY_CANDIDATE_CITY_LIMIT` 个。 */
  cities: JourneyCandidateCity[]
  /** 行程里不同城市的总数。 */
  cityCount: number
}

/**
 * 新的已去过记录该用哪个行程：
 * - `ask`：请求里没有明确的选择——没有候选就新建，有候选就请用户选择；
 * - `join`：加入这个已有行程（必须是同标题的候选之一）；
 * - `new`：新建行程，即使标题与已有行程相同。
 */
export type JourneyChoice = { kind: 'ask' } | { kind: 'join'; journeyId: string } | { kind: 'new' }

const isVisited = (record: V2TravelRecord) => record.status !== 'planned'

const journeyIdOf = (record: V2TravelRecord): string | undefined =>
  typeof record.journeyId === 'string' && record.journeyId !== '' ? record.journeyId : undefined

const dateOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/** 地点的中英文名（只取这两种语言）。 */
const cityNamesOf = (names: Record<string, string> | undefined): Record<string, string> => ({
  ...(names?.[ZH] ? { [ZH]: names[ZH] } : {}),
  ...(names?.[EN] ? { [EN]: names[EN] } : {}),
})

/**
 * 同标题的已有行程：已去过的记录里 `trip_title` 与 `tripTitle` 完全相同、且带 `journeyId` 的，按 `journeyId` 分组，每组一个候选。
 * 候选描述的是整个行程：日期范围与城市取这个 `journeyId` 下全部已去过的记录（加入它，新城市就与这些城市连成路线），
 * 不只是标题相同的那几条（旧数据里一个行程的记录可能用了不同的标题）。
 * 排序：最近的行程在前（按结束日期，没有日期的在最后），再按 `journeyId`（码点）。标题为空时没有候选。
 */
export const findJourneyCandidates = (files: V2Files, tripTitle: string | undefined): JourneyCandidate[] => {
  if (!tripTitle) return []
  const visited = files.travel.records.filter((record) => isVisited(record) && journeyIdOf(record) !== undefined)
  const journeyIds = [...new Set(visited.filter((record) => record.trip_title === tripTitle).map((record) => journeyIdOf(record) as string))]
  if (journeyIds.length === 0) return []
  const placeById = new Map(files.places.places.map((place) => [place.id, place]))

  const candidates = journeyIds.map((journeyId): JourneyCandidate => {
    const records = visited.filter((record) => record.journeyId === journeyId).sort(compareJourneyRecords)
    const starts = records.map((record) => dateOf(record.start_date)).filter((date): date is string => date !== undefined).sort(compareCodePoints)
    const ends = records.map((record) => dateOf(record.end_date) ?? dateOf(record.start_date))
      .filter((date): date is string => date !== undefined).sort(compareCodePoints)
    const placeIds = [...new Set(records.map((record) => record.placeId))]
    return {
      journeyId,
      title: tripTitle,
      ...(starts.length > 0 ? { startDate: starts[0] } : {}),
      ...(ends.length > 0 ? { endDate: ends[ends.length - 1] } : {}),
      cities: placeIds.slice(0, JOURNEY_CANDIDATE_CITY_LIMIT).map((placeId) => ({ placeId, names: cityNamesOf(placeById.get(placeId)?.names) })),
      cityCount: placeIds.length,
    }
  })
  return candidates.sort((left, right) => {
    if (left.endDate !== right.endDate) {
      if (left.endDate === undefined) return 1
      if (right.endDate === undefined) return -1
      return compareCodePoints(right.endDate, left.endDate)
    }
    return compareCodePoints(left.journeyId, right.journeyId)
  })
}

/**
 * 请求里的行程选择（`POST /records` 与 `POST /wanttogo/convert` 共用）：
 * - 都没有（或 `newJourney: false`）→ `ask`；
 * - `journeyId`（trim 后非空的字符串）→ `join`；
 * - `newJourney: true` → `new`。
 * 其它写法（`journeyId` 不是非空字符串、`newJourney` 不是布尔值、两者同时给出）→ `E_UNKNOWN_JOURNEY`。
 * 这里只检查写法；`journeyId` 是不是同标题的已有行程，要等地点与标题确定之后由 `journeyIdFor` 判断。
 */
export const journeyChoiceOf = (body: Record<string, unknown>): JourneyChoice => {
  const { journeyId, newJourney } = body
  if (newJourney !== undefined && typeof newJourney !== 'boolean') return fail('E_UNKNOWN_JOURNEY')
  if (journeyId === undefined) return newJourney === true ? { kind: 'new' } : { kind: 'ask' }
  if (typeof journeyId !== 'string' || !journeyId.trim() || newJourney === true) return fail('E_UNKNOWN_JOURNEY')
  return { kind: 'join', journeyId: journeyId.trim() }
}

const newJourneyId = (ctx: V2WriteContext) => `journey-${ctx.newId()}`

/**
 * 新变成「已去过」的记录的 `journeyId`（PR3b-2 规格 §2.6；第 2C 批改为由用户选择）：
 * - `join`：`journeyId` 必须是 `findJourneyCandidates` 找得到的行程（同标题的已有行程），否则 `E_UNKNOWN_JOURNEY`；
 * - `new`：`journey-<UUIDv7>`；
 * - `ask`：没有候选 → `journey-<UUIDv7>`（与以前的「全新标题」相同）；有候选 → `E_JOURNEY_CHOICE_REQUIRED`
 *   （`params.tripTitle` 与 `params.candidates`），调用方什么都不写。
 * Canonical 派生把没有 journeyId 的记录全部归入 'unknown-journey'，会把互不相干的城市连成路线，所以必须在创建时写入。
 */
export const journeyIdFor = (files: V2Files, tripTitle: string | undefined, ctx: V2WriteContext, choice: JourneyChoice): string => {
  if (choice.kind === 'new') return newJourneyId(ctx)
  const candidates = findJourneyCandidates(files, tripTitle)
  if (choice.kind === 'join') {
    if (!candidates.some((candidate) => candidate.journeyId === choice.journeyId)) return fail('E_UNKNOWN_JOURNEY', { journeyId: choice.journeyId })
    return choice.journeyId
  }
  if (candidates.length > 0) throw new V2WriteError('E_JOURNEY_CHOICE_REQUIRED', { tripTitle, candidates })
  return newJourneyId(ctx)
}
