/**
 * 同名行程的选择（第 2C 批；审查 C4 与 §10：由用户选择，不按日期自动判断）：界面这一侧的纯函数。
 *
 * 新的已去过记录的行程标题（「标记为去过」里填写的，或默认的「国家 · 城市」）与已有行程相同、请求里又没有明确的选择时，
 * 服务端返回 409 `E_JOURNEY_CHOICE_REQUIRED`，`params.candidates` 是候选行程，什么都不写。界面在原来的对话框里列出
 * 「加入已有行程：<标题>（<日期范围> · <城市>）」，最后一项「新建行程」，【不预选】。用户选定后，同一个按钮再次提交：
 * 加入提交 `journeyId`，新建提交 `newJourney: true`。
 *
 * - 候选属于提交时的输入：行程标题（添加城市时还有城市与地点选择）变了，候选就作废（`journeyChoiceKey` 不同）。
 * - 与地点选择（./placeChoice.ts）都需要时，服务端先返回地点选择；地点选好、再次提交之后，才可能返回行程选择。
 */

import { LocalEditorError } from '../i18n/editorErrors.ts'

/** 候选行程里的一个城市（界面显示用）。 */
export type JourneyChoiceCity = { placeId: string; nameZh?: string; nameEn?: string }

/** 一个候选行程（界面显示用）：行程 id、标题、日期范围、最多 5 个城市与城市总数。 */
export type JourneyChoiceCandidate = {
  journeyId: string
  title: string
  startDate?: string
  endDate?: string
  cities: JourneyChoiceCity[]
  cityCount: number
}

/** 用户的选择：加入已有行程（按 id），或新建行程。 */
export type JourneyChoiceSelection = { kind: 'existing'; journeyId: string } | { kind: 'new' }

/** 对话框里的选择状态：候选所属的输入指纹、候选、当前选择（收到候选时一律为 undefined：不预选）。 */
export type JourneyChoiceState = {
  key: string
  candidates: JourneyChoiceCandidate[]
  selected?: JourneyChoiceSelection
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const optionalText = (value: unknown): string | undefined | false => {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.trim() !== '' ? value : false
}

const cityOf = (value: unknown): JourneyChoiceCity | undefined => {
  if (!record(value) || typeof value.placeId !== 'string' || value.placeId === '' || !record(value.names)) return undefined
  const nameZh = optionalText(value.names['zh-Hans'])
  const nameEn = optionalText(value.names.en)
  if (nameZh === false || nameEn === false) return undefined
  return { placeId: value.placeId, ...(nameZh !== undefined ? { nameZh } : {}), ...(nameEn !== undefined ? { nameEn } : {}) }
}

/**
 * `E_JOURNEY_CHOICE_REQUIRED` 的候选行程；不是这个错误、或候选的形状不对时为 undefined（界面按普通错误显示）。
 */
export function journeyChoiceCandidatesOf(error: unknown): JourneyChoiceCandidate[] | undefined {
  if (!(error instanceof LocalEditorError) || error.code !== 'E_JOURNEY_CHOICE_REQUIRED') return undefined
  const raw = error.params.candidates
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const candidates: JourneyChoiceCandidate[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!record(item) || typeof item.journeyId !== 'string' || item.journeyId === '' || seen.has(item.journeyId)) return undefined
    const title = optionalText(item.title)
    const startDate = optionalText(item.startDate)
    const endDate = optionalText(item.endDate)
    if (title === undefined || title === false || startDate === false || endDate === false) return undefined
    if (!Array.isArray(item.cities)) return undefined
    const cities = item.cities.map(cityOf)
    if (cities.some((city) => city === undefined)) return undefined
    if (typeof item.cityCount !== 'number' || !Number.isInteger(item.cityCount) || item.cityCount < cities.length) return undefined
    seen.add(item.journeyId)
    candidates.push({
      journeyId: item.journeyId,
      title,
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      cities: cities as JourneyChoiceCity[],
      cityCount: item.cityCount,
    })
  }
  return candidates
}

/** 收到候选后的状态：不预选，用户必须选一项。 */
export const journeyChoiceStateOf = (key: string, candidates: JourneyChoiceCandidate[]): JourneyChoiceState => ({ key, candidates })

/** 决定候选的输入（行程标题；添加城市时还有城市与地点选择）的指纹；它变了，原来的候选就作废。 */
export const journeyChoiceKey = (parts: readonly unknown[]): string => JSON.stringify(parts)

/** 再次提交时附带的选择：加入 → `{ journeyId }`，新建 → `{ newJourney: true }`，还没有选择 → 什么都不带。 */
export const journeyChoiceInput = (selection: JourneyChoiceSelection | undefined): { journeyId?: string; newJourney?: true } => {
  if (selection?.kind === 'existing') return { journeyId: selection.journeyId }
  if (selection?.kind === 'new') return { newJourney: true }
  return {}
}

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 日期范围的两端（显示用）：只有一天、或只知道一端时只有 `from`；同一年的完整日期，结束日期只写月日
 * （「2024-07-01 至 07-10」）；跨年或不是完整日期时照写。
 */
export const journeyDateRange = (startDate?: string, endDate?: string): { from?: string; to?: string } => {
  const from = startDate ?? endDate
  if (from === undefined) return {}
  if (startDate === undefined || endDate === undefined || endDate === startDate) return { from }
  const sameYear = FULL_DATE.test(startDate) && FULL_DATE.test(endDate) && startDate.slice(0, 4) === endDate.slice(0, 4)
  return { from, to: sameYear ? endDate.slice(5) : endDate }
}
