/**
 * 「标记为去过」的前置条件（审查 C2）：规则在 ../editor/rules/convertRules.ts（3C-5 C2 迁出，写入端点、存储原生的写入与派生共用）。
 * 这里给出 Canonical 的输入（3C-5 E：五个 V2 文件的输入随 V2 写入层删除；测试比对两种输入时自己构造 V2 文件的那一份）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { ConvertRuleData } from '../editor/rules/convertRules.ts'
import type { CanonicalData } from './types.ts'

export {
  convertRules, convertRulesOf, type ConvertRuleAccess, type ConvertRuleData, type ConvertRuleItem, type ConvertRuleRecord, type ConvertRules,
  type PlannedConvertBlockCode, type WantToGoConvertBlockCode,
} from '../editor/rules/convertRules.ts'

export const convertRuleDataOfCanonical = (canonical: CanonicalData): ConvertRuleData => ({
  places: canonical.places,
  records: canonical.travel.records,
  wantToGoItems: canonical.wantToGo.items,
})
