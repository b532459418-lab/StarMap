/**
 * 新增国家的目录候选：去掉已在国家列表里的国家（RFC-LOC-1 PR3b-2 审查补修）。
 *
 * 目录候选（`/__travelatlas/editor/catalog/countries`）的 `id` 是国家英文名的 slug，旧模式下国家列表的 id
 * 也是这个 slug，所以原来只比 id。V2 数据模式下国家列表的 id 是地点 id（UUID），与 slug 永远不相等——
 * 这是与 InfoCard 同一类「把 id 当成有格式的字符串」的问题（RFC ID-1）。
 *
 * 判断改为：id 相等，或国家代码相等（目录的 `countryCode` 与国家的 `flagCode`，大小写不敏感），任一满足即过滤。
 * 旧模式下数据一致时，同一个国家的 slug 与代码指向同一个国家，结果与原来相同；只可能多过滤掉「同代码、不同 slug」
 * 的重复项。任一边没有国家代码时只按 id 比较。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，不 import JSON、虚拟模块或 import.meta。
 */

/** 目录候选里用得到的字段。 */
export interface CatalogCountryOption {
  id: string
  countryCode?: string
}

/** 国家列表里用得到的字段（`Country` 的子集）。 */
export interface ListedCountry {
  id: string
  flagCode?: string
}

const normalizeCode = (value: unknown): string => (typeof value === 'string' ? value.trim().toUpperCase() : '')

/** 这个目录候选是否已在国家列表里：id 相等，或（两边都有国家代码时）国家代码相等。 */
export const isCountryAlreadyListed = (option: CatalogCountryOption, countries: readonly ListedCountry[]): boolean => {
  const code = normalizeCode(option.countryCode)
  return countries.some((country) => (
    country.id === option.id
    || (code !== '' && normalizeCode(country.flagCode) === code)
  ))
}

/** 去掉已在国家列表里的目录候选；其余按原顺序保留。 */
export const withoutListedCountries = <T extends CatalogCountryOption>(
  options: readonly T[],
  countries: readonly ListedCountry[],
): T[] => options.filter((option) => !isCountryAlreadyListed(option, countries))
