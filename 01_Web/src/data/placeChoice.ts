/**
 * 同名城市的地点选择（第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）：界面这一侧的纯函数。
 *
 * 按名字添加足迹城市或想去城市时，服务端只要找到可能是同一个地方的已有地点，就返回 409 `E_PLACE_CHOICE_REQUIRED`，
 * `params.candidates` 是候选列表，什么都不写。界面在原来的对话框里列出这些候选，再加一项「新建独立地点」；用户选定后，
 * 同一个按钮再次提交：选已有地点提交 `{ placeId }`，选新建提交 `{ …, createNew: true }`。
 *
 * - 有强候选（名字一致、坐标都精确且相距不超过 50 km）时默认选中第一个强候选；没有时不预选，用户必须选一项。
 * - 候选属于提交时的输入：输入（国家、名字、坐标）变了，候选就作废（`placeChoiceKey` 不同），重新走一遍流程。
 */

import { LocalEditorError } from '../i18n/editorErrors.ts'

/** 一个候选（界面显示用）：已有地点的 id、中英文名、与输入的距离、地点有没有坐标、是否强候选。 */
export type PlaceChoiceCandidate = {
  placeId: string
  nameZh?: string
  nameEn?: string
  distanceKm?: number
  hasLocation: boolean
  strong: boolean
}

/** 用户的选择：已有地点（按 id 引用），或新建独立地点。 */
export type PlaceChoiceSelection = { kind: 'existing'; placeId: string } | { kind: 'new' }

/** 对话框里的选择状态：候选所属的输入指纹、候选、当前选择（没有强候选时为 undefined）。 */
export type PlaceChoiceState = {
  key: string
  candidates: PlaceChoiceCandidate[]
  selected?: PlaceChoiceSelection
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const optionalName = (value: unknown): string | undefined | false => {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.trim() !== '' ? value : false
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * `E_PLACE_CHOICE_REQUIRED` 的候选列表；不是这个错误、或候选的形状不对时为 undefined（界面按普通错误显示）。
 */
export function placeChoiceCandidatesOf(error: unknown): PlaceChoiceCandidate[] | undefined {
  if (!(error instanceof LocalEditorError) || error.code !== 'E_PLACE_CHOICE_REQUIRED') return undefined
  const raw = error.params.candidates
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const candidates: PlaceChoiceCandidate[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!record(item) || typeof item.placeId !== 'string' || item.placeId === '' || seen.has(item.placeId)) return undefined
    if (typeof item.strong !== 'boolean' || !record(item.names)) return undefined
    const nameZh = optionalName(item.names['zh-Hans'])
    const nameEn = optionalName(item.names.en)
    if (nameZh === false || nameEn === false || (nameZh === undefined && nameEn === undefined)) return undefined
    if (item.distanceKm !== undefined && (!finiteNumber(item.distanceKm) || item.distanceKm < 0)) return undefined
    const location = item.location
    if (location !== undefined && (!record(location) || !finiteNumber(location.lat) || !finiteNumber(location.lng))) return undefined
    seen.add(item.placeId)
    candidates.push({
      placeId: item.placeId,
      ...(nameZh !== undefined ? { nameZh } : {}),
      ...(nameEn !== undefined ? { nameEn } : {}),
      ...(item.distanceKm !== undefined ? { distanceKm: item.distanceKm } : {}),
      hasLocation: location !== undefined,
      strong: item.strong,
    })
  }
  return candidates
}

/** 收到候选后的状态：有强候选时选中第一个强候选，否则不预选。 */
export const placeChoiceStateOf = (key: string, candidates: PlaceChoiceCandidate[]): PlaceChoiceState => {
  const strong = candidates.find((candidate) => candidate.strong)
  return { key, candidates, ...(strong ? { selected: { kind: 'existing', placeId: strong.placeId } } : {}) }
}

/** 决定地点身份的输入（国家、名字、坐标）的指纹；它变了，原来的候选就作废。 */
export const placeChoiceKey = (parts: readonly unknown[]): string => JSON.stringify(parts)

/** 候选的显示名：中文名与英文名（相同时只显示一个）。 */
export const placeChoiceNames = (candidate: Pick<PlaceChoiceCandidate, 'nameZh' | 'nameEn'>): string =>
  [...new Set([candidate.nameZh, candidate.nameEn].filter((name): name is string => Boolean(name)))].join(' / ')
