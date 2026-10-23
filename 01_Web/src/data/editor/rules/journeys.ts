/**
 * 同名行程的选择（3C-5 C2 从 ../../v2write/journeyChoice.ts 迁来，规则、错误码、参数与候选顺序不变；第 2C 批，审查 C4 与 §10：
 * 标题相同时由用户选择，不按日期自动判断）。
 *
 * 行程的身份是记录的 `journeyId`。行程标题只用来找候选，不决定新的已去过记录并入哪个行程：
 * - `journeyChoiceOf(body)`：请求里的选择——`journeyId`（加入这个已有行程）或 `newJourney: true`（新建行程）；
 * - `findJourneyCandidates(records, tripTitle, namesOf)`：已去过的记录里 `trip_title` 与给定标题完全相同、且带 `journeyId`
 *   的行程，每个附上日期范围与城市；
 * - `decideJourney(choice, candidates, tripTitle)`：新变成「已去过」的记录加入哪个行程，或新建。
 * 调用方给出记录（V2 写入函数：五个文件里的全部记录；存储原生的写入：同标题的已去过记录与这些行程的全部成员——结果只取决于
 * 这些记录，与先后无关），自己落盘：V2 写 `journey-<UUIDv7>`，存储原生的写入新建 journey 实体，行程 id 就是实体 id（设计 §9 第 1 条）。
 *
 * 与地点选择同时出现时【先地点、后行程】（默认标题「国家 · 城市」取决于选定的城市），一次只返回一种选择。
 * 不改已有记录的 `journeyId`；不看日期判断两次旅行是不是同一次。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { compareCodePoints, compareJourneyRecords } from '../../canonical/journeyRoutes.ts'
import { EN, ZH } from '../../canonical/reconstruct.ts'
import type { PlaceId } from '../../canonical/types.ts'
import { V2WriteError, fail } from '../errors.ts'

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

/** 规则要看的记录字段（V2 文件的记录、官方视图的记录都满足）。 */
export interface JourneyRecord {
  readonly id: string
  readonly placeId: PlaceId
  readonly status?: unknown
  readonly journeyId?: unknown
  readonly trip_title?: unknown
  readonly start_date?: unknown
  readonly end_date?: unknown
}

/**
 * 新的已去过记录该用哪个行程：
 * - `ask`：请求里没有明确的选择——没有候选就新建，有候选就请用户选择；
 * - `join`：加入这个已有行程（必须是同标题的候选之一）；
 * - `new`：新建行程，即使标题与已有行程相同。
 */
export type JourneyChoice = { kind: 'ask' } | { kind: 'join'; journeyId: string } | { kind: 'new' }

/** 记录算不算「已去过」：planned 不算。 */
export const isVisitedRecord = (record: { readonly status?: unknown }): boolean => record.status !== 'planned'

const journeyIdOf = (record: JourneyRecord): string | undefined =>
  typeof record.journeyId === 'string' && record.journeyId !== '' ? record.journeyId : undefined

const dateOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/** 地点的中英文名（只取这两种语言）。 */
const cityNamesOf = (names: Readonly<Record<string, string>> | undefined): Record<string, string> => ({
  ...(names?.[ZH] ? { [ZH]: names[ZH] } : {}),
  ...(names?.[EN] ? { [EN]: names[EN] } : {}),
})

/**
 * 同标题的已有行程：已去过的记录里 `trip_title` 与 `tripTitle` 完全相同、且带 `journeyId` 的，按 `journeyId` 分组，每组一个候选。
 * 候选描述的是整个行程：日期范围与城市取这个 `journeyId` 下全部已去过的记录（加入它，新城市就与这些城市连成路线），
 * 不只是标题相同的那几条（旧数据里一个行程的记录可能用了不同的标题）。
 * 排序：最近的行程在前（按结束日期，没有日期的在最后），再按 `journeyId`（码点）。标题为空时没有候选。
 */
export const findJourneyCandidates = (
  records: readonly JourneyRecord[],
  tripTitle: string | undefined,
  namesOf: (placeId: PlaceId) => Readonly<Record<string, string>> | undefined,
): JourneyCandidate[] => {
  if (!tripTitle) return []
  const visited = records.filter((record) => isVisitedRecord(record) && journeyIdOf(record) !== undefined)
  const journeyIds = [...new Set(visited.filter((record) => record.trip_title === tripTitle).map((record) => journeyIdOf(record) as string))]
  if (journeyIds.length === 0) return []

  const candidates = journeyIds.map((journeyId): JourneyCandidate => {
    const members = visited.filter((record) => record.journeyId === journeyId)
      .sort((a, b) => compareJourneyRecords(a as { id: string; start_date?: string }, b as { id: string; start_date?: string }))
    const starts = members.map((record) => dateOf(record.start_date)).filter((date): date is string => date !== undefined).sort(compareCodePoints)
    const ends = members.map((record) => dateOf(record.end_date) ?? dateOf(record.start_date))
      .filter((date): date is string => date !== undefined).sort(compareCodePoints)
    const placeIds = [...new Set(members.map((record) => record.placeId))]
    return {
      journeyId,
      title: tripTitle,
      ...(starts.length > 0 ? { startDate: starts[0] } : {}),
      ...(ends.length > 0 ? { endDate: ends[ends.length - 1] } : {}),
      cities: placeIds.slice(0, JOURNEY_CANDIDATE_CITY_LIMIT).map((placeId) => ({ placeId, names: cityNamesOf(namesOf(placeId)) })),
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
 * 这里只检查写法；`journeyId` 是不是同标题的已有行程，要等地点与标题确定之后由 `decideJourney` 判断。
 */
export const journeyChoiceOf = (body: Record<string, unknown>): JourneyChoice => {
  const { journeyId, newJourney } = body
  if (newJourney !== undefined && typeof newJourney !== 'boolean') return fail('E_UNKNOWN_JOURNEY')
  if (journeyId === undefined) return newJourney === true ? { kind: 'new' } : { kind: 'ask' }
  if (typeof journeyId !== 'string' || !journeyId.trim() || newJourney === true) return fail('E_UNKNOWN_JOURNEY')
  return { kind: 'join', journeyId: journeyId.trim() }
}

/**
 * 新变成「已去过」的记录的行程（PR3b-2 规格 §2.6；第 2C 批改为由用户选择）：
 * - `join`：`journeyId` 必须是同标题的候选之一，否则 `E_UNKNOWN_JOURNEY`（`params.journeyId`）；
 * - `new`：新建（不看候选）；
 * - `ask`：没有候选 → 新建；有候选 → `E_JOURNEY_CHOICE_REQUIRED`（`params.tripTitle` 与 `params.candidates`），调用方什么都不写。
 * `candidates` 只在需要时才求（`new` 不需要）。
 */
export const decideJourney = (
  choice: JourneyChoice,
  candidates: () => readonly JourneyCandidate[],
  tripTitle: string | undefined,
): { readonly join: string } | { readonly new: true } => {
  if (choice.kind === 'new') return { new: true }
  const found = candidates()
  if (choice.kind === 'join') {
    if (!found.some((candidate) => candidate.journeyId === choice.journeyId)) return fail('E_UNKNOWN_JOURNEY', { journeyId: choice.journeyId })
    return { join: choice.journeyId }
  }
  if (found.length > 0) throw new V2WriteError('E_JOURNEY_CHOICE_REQUIRED', { tripTitle, candidates: found })
  return { new: true }
}
