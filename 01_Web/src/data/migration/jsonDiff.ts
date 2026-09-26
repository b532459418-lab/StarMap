/**
 * 两份 JSON 值的差异路径（RFC-LOC-1 PR3a）。
 *
 * `src/data/migration/` 是 App 层的迁移工具，【不是】 StarMap Core。与 `scripts/legacy-baseline.mjs` 的
 * `collectDifferences` 同一口径：只收集 JSON 路径，不带值（私人数据的名称与坐标不进报告）；
 * 整键缺失算一处，数组按下标比较，多出来的元素各算一处。
 *
 * 比较前两边都经 JSON 往返：值为 undefined 的键视为不存在，与写盘后的样子一致。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript。
 */

export interface DiffSummary {
  equal: boolean
  /** 差异总数。 */
  total: number
  /** 前 `limit` 处差异的 JSON 路径。 */
  paths: string[]
}

export const MAX_REPORTED_DIFFERENCES = 50

const kindOf = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

const formatKey = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`)

const toJson = (value: unknown): unknown => {
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

/** 两份值（JSON 意义下）的差异。`root` 是路径前缀，默认 `$`。 */
export function diffJson(left: unknown, right: unknown, options: { limit?: number; root?: string } = {}): DiffSummary {
  const limit = options.limit ?? MAX_REPORTED_DIFFERENCES
  const paths: string[] = []
  let total = 0
  const report = (where: string) => {
    total += 1
    if (paths.length < limit) paths.push(where)
  }
  const walk = (a: unknown, b: unknown, where: string) => {
    const kind = kindOf(a)
    if (kind !== kindOf(b)) return report(where)
    if (kind === 'array') {
      const first = a as unknown[]
      const second = b as unknown[]
      for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
        const child = `${where}[${index}]`
        if (index >= first.length || index >= second.length) report(child)
        else walk(first[index], second[index], child)
      }
      return
    }
    if (kind === 'object') {
      const first = a as Record<string, unknown>
      const second = b as Record<string, unknown>
      const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()
      for (const key of keys) {
        const child = `${where}${formatKey(key)}`
        if (!Object.hasOwn(first, key) || !Object.hasOwn(second, key)) report(child)
        else walk(first[key], second[key], child)
      }
      return
    }
    if (!Object.is(a, b)) report(where)
  }
  walk(toJson(left), toJson(right), options.root ?? '$')
  return { equal: total === 0, total, paths }
}
