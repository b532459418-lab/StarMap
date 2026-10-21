/**
 * 编辑端点的输入校验（3C-5 C1 从 ../../v2write/common.ts 迁来，规则与文案不变；RFC-LOC-1 PR3b-2 规格 §2.2、§2.3、§2.6）。
 *
 * `src/data/editor/rules/` 是判定层：存储原生的写入（../native/）与 V2 写入函数（../../v2write/，到子批 E 删除为止）共用这一份，
 * 错误码与参数因此相同（双跑对照证明）。输入校验的规则与文案照抄旧模式（插件的 requireText / numberInRange，以及旧格式的
 * 写入模块 want-to-go-store.mjs、convert-to-travel.mjs，均已删除），只是抛带码的 V2WriteError。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { fail } from '../../v2write/errors.ts'

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

/**
 * 请求里的 `createNew`：省略或 false 为不强制新建，true 为明确新建；其它值是错误的输入（`E_UNKNOWN_PLACE_REF`）。
 */
export const createNewOf = (body: Record<string, unknown>): boolean => {
  if (body.createNew === undefined || body.createNew === false) return false
  if (body.createNew === true) return true
  return fail('E_UNKNOWN_PLACE_REF')
}
