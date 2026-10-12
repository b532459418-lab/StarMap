/**
 * 行程里记录的先后与路线类型（审查 C3）：派生（./derive.ts）、时间查询的原始路线（../derive/timeQueryContext.ts）
 * 与只读存储桥（./storeBridge.ts、./storeBridgeProjection.ts）共用这一份，不再各写一份。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

/** 按 Unicode 码点比较（不是 UTF-16 码元，也不受运行环境 locale 影响）。 */
export const compareCodePoints = (left: string, right: string): number => {
  let index = 0
  while (index < left.length && index < right.length) {
    const a = left.codePointAt(index) as number
    const b = right.codePointAt(index) as number
    if (a !== b) return a < b ? -1 : 1
    // 两边到这里都相同，码点占的码元数也相同。
    index += a > 0xffff ? 2 : 1
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

/** 一条行程记录里排序要看的两个字段。 */
export interface JourneyOrderRecord {
  id: string
  start_date?: string
}

/**
 * 同一行程内记录的先后：沿用原来的确定性写法，比较 `${start_date}-${id}`，但按码点比较（原来用的是运行环境默认 locale 的
 * `localeCompare`）。这只是确定的顺序，不代表不完整或无效的日期能排出真实的行程时间线。
 */
export const compareJourneyRecords = (a: JourneyOrderRecord, b: JourneyOrderRecord): number =>
  compareCodePoints(`${a.start_date}-${a.id}`, `${b.start_date}-${b.id}`)

/**
 * 路线类型：两端城市所属国家的地点 id 相同为国内（`main`），不同为跨国（`flight`）。原来比较国家英文名，
 * 两个国家都没有英文名时会被当成同一个国家。两端的国家都查不到时（只有不合法的数据才会这样：V2 校验要求城市有 partOf）
 * 仍算相同，与原来空名字相等的结论一致。
 */
export const routeTypeBetween = (fromCountryId: string | undefined, toCountryId: string | undefined): 'main' | 'flight' =>
  (fromCountryId ?? '') === (toCountryId ?? '') ? 'main' : 'flight'
