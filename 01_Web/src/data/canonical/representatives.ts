/**
 * Legacy Adapter 与 normalizeLegacy 共用的选择函数（RFC-LOC-1 PR2 规格 §2.3、§2.5）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。旧格式允许同一个国家 / 城市在不同记录上
 * 写不同的名称、国家代码；Canonical 里每个地点只有一套。「选哪一套」全部在这里决定：
 * - `./legacyAdapter.ts` 用它构造 Canonical；
 * - `./normalizeLegacy.ts` 用它（经 Legacy Adapter）把旧数据的写法统一成同一套。
 * 两边必须共用这些函数，否则「B ≡ C」没有意义。
 *
 * 【旧键规则】本文件（与 Legacy Adapter、normalizeLegacy 一起）是 RFC §3.6「原则 5 的过渡期例外」：
 * legacy 模式下仍按名字推导旧键（`countryKeyForRecord`、`cityKeyForRecord`、`getJourneyId`）。
 * eslint 只允许这三个文件及其测试引用这些函数；PR5 连同 Legacy Adapter 一起删除。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { getCountryCoordinate } from '../geoCoordinates.ts'
import {
  cityKeyForRecord,
  classifyRecord,
  coordinateForRecord,
  countryKeyForRecord,
  getJourneyId,
  hasCoordinates,
  homeVisibleCategories,
  normalizeRecordCountry,
  type TravelMapDisplay,
} from '../derive/travelAtlas.ts'
import type { TravelMapRecord, TravelRecordCategory } from '../../types/travel.ts'
import type { CanonicalPlace, PlaceId } from './types.ts'

// ---------------------------------------------------------------------------
// 旧键、旧分组、旧分类（与 ../derive/travelAtlas.ts 同一套函数）
// ---------------------------------------------------------------------------

/** 国家别名归一：与今天的派生相同，在推导键之前改写国家名与 region。 */
export const aliasRecords = (records: readonly TravelMapRecord[], display: TravelMapDisplay): TravelMapRecord[] =>
  records.map((record) => normalizeRecordCountry(record, display))

/** 今天的 CountryId / CityId（legacy 模式下的地点 id）。输入须已做国家别名归一。 */
export const legacyKeysOf = (record: TravelMapRecord): { countryId: PlaceId; cityId: PlaceId } => ({
  countryId: countryKeyForRecord(record),
  cityId: cityKeyForRecord(record),
})

/** 今天的行程分组：`journeyId` → `journeyRules` → slug。输入须已做国家别名归一。 */
export const legacyJourneyIdOf = (record: TravelMapRecord, display: TravelMapDisplay): string | undefined =>
  getJourneyId(record, display)

export interface LegacyCategory {
  travelCategory: TravelRecordCategory
  hiddenFromHome: boolean
}

/** 今天的分类（按原始显示规则、按记录上的原字符串匹配）。输入须已做国家别名归一。 */
export const legacyCategoryOf = (record: TravelMapRecord, display: TravelMapDisplay): LegacyCategory => {
  const travelCategory = classifyRecord(record, display)
  return {
    travelCategory,
    hiddenFromHome: typeof record.hiddenFromHome === 'boolean'
      ? record.hiddenFromHome
      : !homeVisibleCategories.has(travelCategory),
  }
}

// ---------------------------------------------------------------------------
// 代表记录（§2.3）
// ---------------------------------------------------------------------------

/**
 * 同一国家 / 城市键下的代表记录：第一条显示中的记录（非 planned、非 hiddenFromHome、未被 editor 隐藏，
 * 按文件顺序——即今天 `recordsByCountry` / `recordsByCity` 的首条）；没有则第一条非 planned 记录；
 * 再没有则第一条记录。`indices` 按文件顺序。
 */
export const selectRepresentative = (
  indices: readonly number[],
  isDisplayed: (index: number) => boolean,
  isPlanned: (index: number) => boolean,
): number =>
  indices.find(isDisplayed)
  ?? indices.find((index) => !isPlanned(index))
  ?? indices[0]

/**
 * 城市的代表记录：同 `selectRepresentative`，但只在【有城市名】（`city` 或 `city_en` 非空）的记录里选；
 * 都没有城市名时才退回全部记录。
 *
 * 理由：今天的 CityId 在两个城市名都为空时回落到记录 id（`cityKeyForRecord`）。若代表记录恰好没有城市名，
 * 把同一城市的其他记录统一成「空名称」会让它们的旧键各自回落到自己的 id，城市被拆开——
 * 统一写法后的数据（B）就不再与 Canonical（C）同构。只影响「城市名全空」这种退化数据。
 */
export const selectCityRepresentative = (
  indices: readonly number[],
  records: readonly TravelMapRecord[],
  isDisplayed: (index: number) => boolean,
  isPlanned: (index: number) => boolean,
): number => {
  const named = indices.filter((index) => hasText(records[index].city) || hasText(records[index].city_en))
  return selectRepresentative(named.length > 0 ? named : indices, isDisplayed, isPlanned)
}

const hasText = (value: unknown) => typeof value === 'string' && value !== ''

/** 名称：`zh-Hans` ← 中文名，`en` ← 英文名，只写非空值。 */
export const placeNames = (zh: unknown, en: unknown): Record<string, string> => {
  const names: Record<string, string> = {}
  if (typeof zh === 'string' && zh) names['zh-Hans'] = zh
  if (typeof en === 'string' && en) names.en = en
  return names
}

/**
 * 国家的 ISO：今天 `flagCode` 的规则套在代表记录上——`country_code`，否则
 * `display.countryCodes[country_en || country]`（与 flagCode 一样用 `??`：记录上写了空字符串就不再回落）；
 * 统一大写；空值视为没有。
 */
export const countryIsoOf = (rep: TravelMapRecord, display: TravelMapDisplay): string | undefined => {
  const code = rep.country_code ?? display.countryCodes?.[rep.country_en || rep.country]
  return typeof code === 'string' && code ? code.toUpperCase() : undefined
}

/** 条目或记录上写的国家代码 → ISO：统一大写；空值视为没有。 */
export const isoFromCode = (code: unknown): string | undefined =>
  typeof code === 'string' && code ? code.toUpperCase() : undefined

// ---------------------------------------------------------------------------
// 坐标（§2.3）。输入是【重建后】的记录：名称已统一成地点名称，按名查表与新旧两条路径一致。
// ---------------------------------------------------------------------------

type Location = NonNullable<CanonicalPlace['location']>

/** 城市：按顺序取第一个 `coordinateForRecord` 结果（今天 `cities` 的算法）；不是来自记录自身坐标时标 approximate。 */
export const cityLocationOf = (records: readonly TravelMapRecord[]): Location | undefined => {
  for (const record of records) {
    const coordinate = coordinateForRecord(record)
    if (!coordinate) continue
    // coordinateForRecord 只在记录两个坐标都是数字时返回记录自身的坐标，所以这里一定是数字。
    const { lat, lng } = coordinate as { lat: number; lng: number }
    return hasCoordinates(record) ? { lat, lng } : { lat, lng, approximate: true }
  }
  return undefined
}

/** 国家：今天 `recordCountries` 的中心公式——内置国家坐标，否则各记录坐标的平均。 */
export const countryLocationOf = (records: readonly TravelMapRecord[]): Location | undefined => {
  const first = records[0]
  if (!first) return undefined
  const countryCoordinate = getCountryCoordinate(first.country_en || first.country)
  if (countryCoordinate) return { lat: countryCoordinate.lat, lng: countryCoordinate.lng, approximate: true }

  const coordinates = records
    .map((record) => ({ record, coordinate: coordinateForRecord(record) }))
    .filter((entry): entry is { record: TravelMapRecord; coordinate: { lat: number; lng: number } } => Boolean(entry.coordinate))
  if (coordinates.length === 0) return undefined
  const lat = coordinates.reduce((sum, { coordinate }) => sum + coordinate.lat, 0) / coordinates.length
  const lng = coordinates.reduce((sum, { coordinate }) => sum + coordinate.lng, 0) / coordinates.length
  return coordinates.every(({ record }) => hasCoordinates(record)) ? { lat, lng } : { lat, lng, approximate: true }
}

// ---------------------------------------------------------------------------
// 显示规则（§2.3）：先把变体写法统一成地点名称，再落到地点上
// ---------------------------------------------------------------------------

/** 规则值的来源：原始数组（不是数组时按今天 `new Set(x ?? [])` 的迭代语义取值）。 */
export const ruleValues = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return []
  if (typeof (value as Iterable<unknown>)[Symbol.iterator] !== 'function') return []
  return [...(value as Iterable<unknown>)]
}

/** 记录（已做别名归一）在显示规则转换里需要的三样东西。 */
export interface RuleRecord {
  countryId: PlaceId
  countryEn: unknown
  region: unknown
}

export interface UnifiedCountryRule {
  /** 统一写法后的旧格式字符串（normalizeLegacy 写回旧文件的值），去重、保持首次出现顺序。 */
  values: string[]
  /** 匹配不到任何地点而被丢弃的原始值的序号。 */
  invalidIndices: number[]
}

/**
 * `hiddenCountries` / `originCountries`：原始值 v 命中「某条记录（别名归一后）的 country_en === v」的国家地点
 * ——与 `classifyRecord` 相同的原字符串匹配；命中的地点换成该地点的英文名（重建值，没有则为空字符串）；
 * 匹配不到任何地点的值丢弃。
 */
export const unifyCountryRule = (
  raw: unknown,
  records: readonly RuleRecord[],
  reconstructedEnOf: (countryId: PlaceId) => string,
): UnifiedCountryRule => {
  const values: string[] = []
  const invalidIndices: number[] = []
  ruleValues(raw).forEach((value, index) => {
    const hits = unique(records.filter((record) => record.countryEn === value).map((record) => record.countryId))
    if (hits.length === 0) {
      invalidIndices.push(index)
      return
    }
    for (const countryId of hits) pushUnique(values, reconstructedEnOf(countryId))
  })
  return { values, invalidIndices }
}

/**
 * `regionMatchers`：今天每个值同时有两种语义——等于记录的 country_en，或是记录 region 的子串。
 * 命中国家的那一半换成地点英文名；命中 region 的那一半原样保留；两样都不命中的值丢弃。
 */
export const unifyRegionRule = (
  raw: unknown,
  records: readonly RuleRecord[],
  reconstructedEnOf: (countryId: PlaceId) => string,
): UnifiedCountryRule => {
  const values: string[] = []
  const invalidIndices: number[] = []
  ruleValues(raw).forEach((value, index) => {
    const countryHits = unique(records.filter((record) => record.countryEn === value).map((record) => record.countryId))
    const regionHit = typeof value === 'string' && records.some((record) => regionIncludes(record.region, value))
    if (countryHits.length === 0 && !regionHit) {
      invalidIndices.push(index)
      return
    }
    for (const countryId of countryHits) pushUnique(values, reconstructedEnOf(countryId))
    if (regionHit) pushUnique(values, value as string)
  })
  return { values, invalidIndices }
}

/** 与 `record.region?.includes(matcher)` 相同的判断。 */
export const regionIncludes = (region: unknown, matcher: string): boolean =>
  typeof region === 'string' && region.includes(matcher)

/**
 * 统一写法后的字符串 → 地点：重建英文名在集合里的国家地点。这正是旧派生在统一写法后的数据上
 * （记录的 country_en 都是地点英文名）会命中的国家，所以新旧两条路径的分类相同。
 */
export const countriesNamed = (
  values: readonly string[],
  countryIds: readonly PlaceId[],
  reconstructedEnOf: (countryId: PlaceId) => string,
): PlaceId[] => {
  const set = new Set(values)
  return countryIds.filter((countryId) => set.has(reconstructedEnOf(countryId)))
}

/** 统一写法后的 regionMatchers 中，确实是某条记录 region 子串的值（今天也只有它们以子串方式生效）。 */
export const regionIncludesFrom = (values: readonly string[], regions: readonly unknown[]): string[] =>
  values.filter((value) => regions.some((region) => regionIncludes(region, value)))

export interface DisplayedCityName {
  id: PlaceId
  /** 今天 `City.nameEn`：`city_en || city`。 */
  nameEn: string
  /** 今天 `City.nameZh`：`city`。 */
  nameZh: string
}

/**
 * `hiddenCityNames`：按显示中城市的中文名或英文名匹配（今天 `shouldHideCityFromNavigation` 的判断）。
 * 命中至少一个显示中城市的值原样保留（它本来就是地点名称）；其余丢弃。
 */
export const unifyHiddenCityNames = (raw: unknown, cities: readonly DisplayedCityName[]) => {
  const values: string[] = []
  const invalidIndices: number[] = []
  const cityIds: PlaceId[] = []
  ruleValues(raw).forEach((value, index) => {
    const hits = cities.filter((city) => city.nameEn === value || city.nameZh === value)
    if (hits.length === 0) {
      invalidIndices.push(index)
      return
    }
    pushUnique(values, value as string)
    for (const city of hits) pushUnique(cityIds, city.id)
  })
  // 按城市顺序输出，与值的顺序无关。
  const hitSet = new Set(cityIds)
  return { values, invalidIndices, cityIds: cities.map((city) => city.id).filter((id) => hitSet.has(id)) }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const unique = <T,>(items: readonly T[]): T[] => [...new Set(items)]

const pushUnique = <T,>(target: T[], value: T) => {
  if (!target.includes(value)) target.push(value)
}
