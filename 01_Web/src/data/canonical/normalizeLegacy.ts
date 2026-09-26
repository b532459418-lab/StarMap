/**
 * normalizeLegacy（RFC-LOC-1 PR2 规格 §2.1、§2.5）：旧格式 → 旧格式，把每个地点的写法统一成
 * Legacy Adapter 会选的那一套，并报告改了哪些地方。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。PR2 的验收用三份基线、两道比较：
 *   A = PR1 的 deriveAppData(原始数据)                         今天 App 看到的
 *   B = PR1 的 deriveAppData(normalizeLegacy(原始数据))        统一写法后，旧 App 会看到的
 *   C = deriveAppDataFromCanonical(legacyAdapter(原始数据))    PR2 之后 App 看到的
 * B ≡ C（逐字节）是适配器与派生的正确性；A 与 B 的差异就是「数据里的写法不一致会让哪些显示变化」，只报告。
 *
 * 统一的依据全部来自 Legacy Adapter（`buildLegacyCanonical`，它用 `./representatives.ts` 的选择函数）
 * 与 `./reconstruct.ts` 的重建：记录、媒体项、手动添加国家都写成由地点重建的值，所以两条路径
 * 看到的名称与代码逐字相同。
 *
 * 【旧键规则】本文件是 RFC §3.6「原则 5 的过渡期例外」之一；PR5 连同 Legacy Adapter 一起删除。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { RawAppInputs } from '../derive/appData.ts'
import { stableStringify } from '../derive/baseline.ts'
import { deriveEditorState, parseEditorState } from '../derive/editorState.ts'
import { isCatalog } from '../derive/mediaCatalog.ts'
import type { TravelMapDisplay } from '../derive/travelAtlas.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import { buildLegacyCanonical, mediaItemProblem, type LegacyDisplayRules } from './legacyAdapter.ts'
import {
  EN,
  ZH,
  countryPlaceOf,
  footprintCountryIds,
  indexPlaces,
  isoOf,
  rebuildCountryCodes,
  reconstructAddedCountry,
  reconstructMediaItem,
  reconstructRecord,
  type PlaceIndex,
} from './reconstruct.ts'
import type { CanonicalPlace, PlaceId } from './types.ts'

/** 报告的类别键。前六类是 PR1 审查记录里名称不一致测试检出的六类。 */
export type NormalizeCategoryKey =
  | 'countryNameZh'
  | 'countryNameEn'
  | 'countryCode'
  | 'cityNameZh'
  | 'cityNameEn'
  | 'suspectedSplitCity'
  | 'countryCodeSpelling'
  | 'addedCountryMismatch'
  | 'mediaNameMismatch'
  | 'displayRuleVariant'
  | 'invalidDisplayRule'
  | 'countryCodesTable'
  | 'mediaInvalid'
  | 'mediaDangling'
  | 'journeyRuleWithoutId'
  | 'placeWithoutEnglishName'
  | 'countryWithoutIso'

export interface NormalizeReportCategory {
  key: NormalizeCategoryKey
  label: string
  /** 「一处」的口径见各类别说明；名称类按地点计（同一键下取值不止一种即为一处）。 */
  count: number
  /** 记录 / 条目 / 地点 id 或 JSON 路径，不含名称等内容。 */
  ids: string[]
}

export interface NormalizeLegacyReport {
  categories: NormalizeReportCategory[]
}

export interface NormalizeLegacyResult {
  normalized: RawAppInputs
  report: NormalizeLegacyReport
}

const categoryLabels: Record<NormalizeCategoryKey, string> = {
  countryNameZh: '国家中文名不一致（按国家计）',
  countryNameEn: '国家英文名不一致（按国家计）',
  countryCode: '国家代码冲突：同一国家的记录写了不同的代码（按国家计）',
  cityNameZh: '城市中文名不一致（按城市计）',
  cityNameEn: '城市英文名不一致（按城市计）',
  suspectedSplitCity: '疑似拆分城市：同一国家下两个城市键的名称只差变音符 / 大小写 / 行政后缀（按城市对计，只报告不改）',
  countryCodeSpelling: '记录上的国家代码与重建值写法不同：大小写、缺失或空字符串（按国家计）',
  addedCountryMismatch: 'addedCountries 条目与地点不一致：名称、代码或中心坐标（按条目计）',
  mediaNameMismatch: '媒体项的国家 id、名称或标题与重建值不同（按媒体项计）',
  displayRuleVariant: '显示规则因写法变体改变匹配：分类或是否上首页改变的记录（按记录计）',
  invalidDisplayRule: '无效显示规则值：匹配不到任何地点，已删去（按值计）',
  countryCodesTable: 'display.countryCodes 与重建映射不同：新增、删去或改值（按项计）',
  mediaInvalid: '无效媒体条目：已跳过（按条目计）',
  mediaDangling: '媒体项引用不存在的城市：保留，删去国家 id 与名称（按媒体项计）',
  journeyRuleWithoutId: 'journeyRules 分出的行程 id 为空：保留 journeyRules 不删（按记录计，只报告）',
  placeWithoutEnglishName: '没有英文名的足迹国家 / 城市（只报告）',
  countryWithoutIso: '没有国家代码的足迹国家（只报告；PR3 迁移时是错误）',
}

const categoryOrder = Object.keys(categoryLabels) as NormalizeCategoryKey[]

/** 按「处」累计：`unit` 是计数单位（地点、条目等），`id` 是列出的 id。 */
class ReportBuilder {
  private readonly units = new Map<NormalizeCategoryKey, Set<string>>()
  private readonly ids = new Map<NormalizeCategoryKey, string[]>()

  add(key: NormalizeCategoryKey, unit: string, id: string = unit) {
    const units = this.units.get(key) ?? new Set<string>()
    units.add(unit)
    this.units.set(key, units)
    const ids = this.ids.get(key) ?? []
    if (!ids.includes(id)) ids.push(id)
    this.ids.set(key, ids)
  }

  build(): NormalizeLegacyReport {
    return {
      categories: categoryOrder.map((key) => ({
        key,
        label: categoryLabels[key],
        count: this.units.get(key)?.size ?? 0,
        ids: this.ids.get(key) ?? [],
      })),
    }
  }
}

// ---- 疑似拆分城市的比较键（只用于报告，不参与任何身份）----

/** 去掉末尾一个行政后缀（市镇县村区乡）。不用「互相包含」：维克 与 胡萨维克 不是同一个城市。 */
const foldZh = (name: string | undefined) => {
  const trimmed = (name ?? '').trim()
  return trimmed.length > 1 && /[市镇县村区乡]$/u.test(trimmed) ? trimmed.slice(0, -1) : trimmed
}

/** 去变音符、不分大小写、只留字母数字。 */
const foldEn = (name: string | undefined) =>
  (name ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

// ---- 写回旧格式 ----

const hasOwn = (value: object | undefined, key: string) => value !== undefined && Object.hasOwn(value, key)

/**
 * 显示规则写回旧格式：别名与行程规则已被消耗掉；其余换成统一写法后的值，国家代码表换成重建映射。
 *
 * 例外：某条记录经 `journeyRules` 分到的行程 id 为空（规则的 `id` 为空字符串或缺失）时保留 `journeyRules`。
 * 旧格式无法在记录上表达「空的 journeyId」（`getJourneyId` 会把它当成没写而继续匹配规则），
 * 删掉规则会让统一写法后的数据换一个行程分组；保留规则则得到与今天相同的结果。
 */
const normalizeDisplay = (
  display: TravelMapDisplay | undefined,
  rules: LegacyDisplayRules,
  countryCodes: Record<string, string>,
  keepJourneyRules: boolean,
): TravelMapDisplay | undefined => {
  const next: TravelMapDisplay = { ...(display ?? {}) }
  delete next.countryAliases
  if (!keepJourneyRules) delete next.journeyRules
  const assign = <K extends 'hiddenCountries' | 'originCountries' | 'regionMatchers' | 'hiddenCityNames'>(key: K, values: string[]) => {
    if (hasOwn(display, key) || values.length > 0) next[key] = values
  }
  assign('hiddenCountries', rules.hiddenCountries)
  assign('originCountries', rules.originCountries)
  assign('regionMatchers', rules.regionMatchers)
  assign('hiddenCityNames', rules.hiddenCityNames)
  if (hasOwn(display, 'countryCodes') || Object.keys(countryCodes).length > 0) next.countryCodes = countryCodes
  return display === undefined && Object.keys(next).length === 0 ? undefined : next
}

// ---- 报告 ----

const reportRecordNames = (
  report: ReportBuilder,
  aliased: readonly TravelMapRecord[],
  normalized: readonly TravelMapRecord[],
  cityIds: readonly PlaceId[],
  places: PlaceIndex,
) => {
  // 每个国家地点里记录写过的（小写）国家代码：多于一种即为冲突。
  const codesByCountry = new Map<PlaceId, Set<string>>()
  aliased.forEach((record, index) => {
    const countryId = countryPlaceOf(places, places.get(cityIds[index]))?.id ?? ''
    const code = record.country_code
    if (typeof code !== 'string' || !code) return
    const codes = codesByCountry.get(countryId) ?? new Set<string>()
    codes.add(code.toLowerCase())
    codesByCountry.set(countryId, codes)
  })

  aliased.forEach((record, index) => {
    const after = normalized[index]
    const cityId = cityIds[index]
    const countryId = countryPlaceOf(places, places.get(cityId))?.id ?? ''
    if (record.country !== after.country) report.add('countryNameZh', countryId, record.id)
    if (record.country_en !== after.country_en) report.add('countryNameEn', countryId, record.id)
    if (record.city !== after.city) report.add('cityNameZh', cityId, record.id)
    if (record.city_en !== after.city_en) report.add('cityNameEn', cityId, record.id)
    if (record.country_code !== after.country_code) {
      const conflict = (codesByCountry.get(countryId)?.size ?? 0) > 1
        && typeof record.country_code === 'string'
        && record.country_code.toLowerCase() !== (after.country_code ?? '')
      report.add(conflict ? 'countryCode' : 'countryCodeSpelling', countryId, record.id)
    }
  })
}

const reportSplitCities = (
  report: ReportBuilder,
  aliased: readonly TravelMapRecord[],
  cityIds: readonly PlaceId[],
  places: PlaceIndex,
) => {
  const recordIdsByCity = new Map<PlaceId, string[]>()
  const citiesByCountry = new Map<PlaceId, PlaceId[]>()
  cityIds.forEach((cityId, index) => {
    recordIdsByCity.set(cityId, [...(recordIdsByCity.get(cityId) ?? []), aliased[index].id])
    const countryId = countryPlaceOf(places, places.get(cityId))?.id ?? ''
    const cities = citiesByCountry.get(countryId) ?? []
    if (!cities.includes(cityId)) citiesByCountry.set(countryId, [...cities, cityId])
  })
  for (const cities of citiesByCountry.values()) {
    cities.forEach((leftId, leftIndex) => {
      for (const rightId of cities.slice(leftIndex + 1)) {
        const left = places.get(leftId)
        const right = places.get(rightId)
        const zh = foldZh(left?.names[ZH])
        const en = foldEn(left?.names[EN])
        const sameZh = zh !== '' && zh === foldZh(right?.names[ZH])
        const sameEn = en !== '' && en === foldEn(right?.names[EN])
        if (!sameZh && !sameEn) continue
        for (const id of [...(recordIdsByCity.get(leftId) ?? []), ...(recordIdsByCity.get(rightId) ?? [])]) {
          report.add('suspectedSplitCity', `${leftId}|${rightId}`, id)
        }
      }
    })
  }
}

const reportCountryCodesTable = (
  report: ReportBuilder,
  raw: Record<string, string> | undefined,
  rebuilt: Record<string, string>,
  keyToPlace: ReadonlyMap<string, PlaceId>,
) => {
  const rawEntries = Object.entries(raw ?? {})
  rawEntries.forEach(([key, value], index) => {
    if (rebuilt[key] !== value) report.add('countryCodesTable', `raw#${index}`, `display.countryCodes#${index}`)
  })
  for (const key of Object.keys(rebuilt)) {
    if (raw === undefined || !Object.hasOwn(raw, key)) {
      // 新增项列出国家地点 id（重建映射的每个键都来自一个足迹国家）。
      report.add('countryCodesTable', `new:${key}`, keyToPlace.get(key) ?? '(unknown)')
    }
  }
}

const isFootprintPlace = (place: CanonicalPlace) => place.legacyKeys !== undefined

/** 旧格式 → 旧格式：每个地点的写法统一成 Legacy Adapter 的选择，并报告改动。 */
export function normalizeLegacy(raw: RawAppInputs): NormalizeLegacyResult {
  const build = buildLegacyCanonical(raw)
  const { canonical } = build
  const places = indexPlaces(canonical.places)
  const report = new ReportBuilder()

  // ---- 足迹：记录的名称与代码、region（别名）、journeyId；显示规则 ----
  const records = canonical.travel.records.map((record) => reconstructRecord(record, places))
  const cityIds = canonical.travel.records.map((record) => record.placeId)
  const countryCodes = rebuildCountryCodes(canonical.travel.records, places)
  const emptyJourneyIds = canonical.travel.records
    .filter((record) => record.status !== 'planned' && !record.journeyId)
    .map((record) => record.id)
  for (const id of emptyJourneyIds) report.add('journeyRuleWithoutId', id)
  const display = normalizeDisplay(raw.travelMap.display, build.legacyDisplay, countryCodes, emptyJourneyIds.length > 0)
  const travelMap = { ...raw.travelMap, records }
  if (display === undefined) delete travelMap.display
  else travelMap.display = display

  reportRecordNames(report, build.aliasedRecords, records, cityIds, places)
  reportSplitCities(report, build.aliasedRecords, cityIds, places)

  build.legacyCategories.forEach((before, index) => {
    const after = build.canonicalCategories[index]
    if (before?.travelCategory !== after?.travelCategory || before?.hiddenFromHome !== after?.hiddenFromHome) {
      report.add('displayRuleVariant', build.aliasedRecords[index].id)
    }
  })
  for (const path of build.invalidDisplayPaths) report.add('invalidDisplayRule', path)

  const keyToPlace = new Map<string, PlaceId>()
  for (const id of footprintCountryIds(canonical.travel.records, places)) {
    const place = places.get(id)
    if (place) keyToPlace.set(place.names[EN] || place.names[ZH] || '', id)
  }
  reportCountryCodesTable(report, raw.travelMap.display?.countryCodes, countryCodes, keyToPlace)

  // ---- editor-state：手动添加国家的名称、代码、中心坐标换成地点的值 ----
  let editorState = raw.editorState
  if (parseEditorState(raw.editorState) !== undefined) {
    const before = deriveEditorState(raw.editorState).addedCountries
    const after = canonical.editorState.addedCountries.map((entry) => reconstructAddedCountry(entry, places))
    after.forEach((entry, index) => {
      if (stableStringify(before[index]) !== stableStringify(entry)) report.add('addedCountryMismatch', `#${index}`, entry.id)
    })
    editorState = { ...(raw.editorState as object), addedCountries: after }
  }

  // ---- 媒体：坏条目删去；名称与标题换成重建值；悬空引用删去国家 id 与名称 ----
  let mediaCatalog = raw.mediaCatalog
  if (isCatalog(raw.mediaCatalog)) {
    const rawItems: unknown[] = raw.mediaCatalog.items
    const items = canonical.media.items.map((item) => reconstructMediaItem(item, places))
    let next = 0
    rawItems.forEach((item, index) => {
      if (mediaItemProblem(item)) {
        report.add('mediaInvalid', `items[${index}]`)
        return
      }
      const before = item as Record<string, unknown>
      const after = items[next] as unknown as Record<string, unknown>
      next += 1
      const place = places.get(after.cityId as string)
      if (place?.subtype !== 'city') {
        report.add('mediaDangling', after.id as string)
        return
      }
      const fields = ['countryId', 'countryName', 'cityName', 'titleZh', 'titleEn']
      if (fields.some((field) => before[field] !== after[field])) report.add('mediaNameMismatch', after.id as string)
    })
    mediaCatalog = { ...raw.mediaCatalog, items }
  }

  // ---- 只报告：没有英文名的地点、没有国家代码的国家 ----
  for (const place of canonical.places) {
    if (!isFootprintPlace(place)) continue
    if (place.names[EN] === undefined) report.add('placeWithoutEnglishName', place.id)
    if (place.subtype === 'country' && !isoOf(place)) report.add('countryWithoutIso', place.id)
  }

  return {
    normalized: { ...raw, travelMap, editorState, mediaCatalog },
    report: report.build(),
  }
}
