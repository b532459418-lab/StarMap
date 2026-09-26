/**
 * Legacy Adapter（RFC-LOC-1 §3.6，PR2）：旧格式的原始数据 → Canonical Model。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。输入与 PR1 的 `deriveAppData` 相同
 * （`RawAppInputs`：调用方已经选好用哪份文件），输出是 `./types.ts` 的 `CanonicalData`。
 *
 * legacy 模式下的地点 id（PR2 规格 §2.2）：
 * - 足迹国家 = 今天的 CountryId（`countryKeyForRecord`，含国家别名归一）；
 * - 足迹城市 = 今天的 CityId（`cityKeyForRecord`），visited 与 planned 共用；
 * - `addedCountries` 的国家 = 条目自带的 id（与同键足迹国家是同一个地点）；
 * - 想去条目的地点 = `wtg:<item.id>`，每个条目一个，不与足迹合并（legacy 模式不做地点合并，RFC §3.6）；
 * - 想去城市的所属国家 = 恰好一个足迹国家具有同一 ISO 代码时用它，否则 `iso:<CC>`。
 *
 * 名称、国家代码、坐标、显示规则怎样选，见 `./representatives.ts`（与 `./normalizeLegacy.ts` 共用）。
 *
 * 【旧键规则】本文件是 RFC §3.6「原则 5 的过渡期例外」之一：legacy 模式下仍按名字推导旧键。
 * eslint 只允许本文件、`./representatives.ts`、`./normalizeLegacy.ts` 及其测试引用这些函数；PR5 删除。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { parseWantToGoFile } from '../../worldgraph/adapters/wantToGo.ts'
import type { RawAppInputs } from '../derive/appData.ts'
import { deriveEditorState } from '../derive/editorState.ts'
import { isCatalog } from '../derive/mediaCatalog.ts'
import type { TravelMapDisplay } from '../derive/travelAtlas.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import { classifyByPlace, displaySets, hiddenFromHomeFor } from './classify.ts'
import { isoOf, reconstructRecord } from './reconstruct.ts'
import {
  aliasRecords,
  cityLocationOf,
  countriesNamed,
  countryIsoOf,
  countryLocationOf,
  isoFromCode,
  legacyCategoryOf,
  legacyJourneyIdOf,
  legacyKeysOf,
  placeNames,
  regionIncludesFrom,
  selectCityRepresentative,
  selectRepresentative,
  unifyCountryRule,
  unifyHiddenCityNames,
  unifyRegionRule,
  type LegacyCategory,
  type RuleRecord,
} from './representatives.ts'
import type {
  CanonicalAddedCountry,
  CanonicalData,
  CanonicalDisplay,
  CanonicalMediaItem,
  CanonicalPlace,
  CanonicalTravelMeta,
  CanonicalTravelRecord,
  CanonicalWantToGoItem,
  LegacyMediaPlaceField,
  LegacyPlaceField,
  PlaceId,
} from './types.ts'

/** 统一写法后的旧格式显示规则：`./normalizeLegacy.ts` 把它们写回旧文件。与 `canonical.travel.display` 等价。 */
export interface LegacyDisplayRules {
  hiddenCountries: string[]
  originCountries: string[]
  regionMatchers: string[]
  hiddenCityNames: string[]
}

/** `legacyAdapter` 的完整结果；除 `canonical` 外都只给 `./normalizeLegacy.ts` 与测试用。 */
export interface LegacyCanonicalBuild {
  canonical: CanonicalData
  legacyDisplay: LegacyDisplayRules
  /** 原始显示规则里匹配不到任何地点、因而被丢弃的值（JSON 路径，不含值本身）。 */
  invalidDisplayPaths: string[]
  /** 每条原始记录别名归一之后的样子（文件顺序）。 */
  aliasedRecords: TravelMapRecord[]
  /** 每条原始记录的旧分类（按原始显示规则）；planned 为 undefined。 */
  legacyCategories: (LegacyCategory | undefined)[]
  /** 每条原始记录的新分类（按 Canonical 的显示规则）；planned 为 undefined。 */
  canonicalCategories: (LegacyCategory | undefined)[]
}

export const KNOWN_MEDIA_KINDS: readonly string[] = ['photo', 'panorama360', 'aerialPhoto', 'video']

const LEGACY_PLACE_FIELDS: ReadonlySet<string> = new Set<LegacyPlaceField>(['country', 'country_en', 'country_code', 'city', 'city_en'])
const LEGACY_MEDIA_PLACE_FIELDS: ReadonlySet<string> = new Set<LegacyMediaPlaceField>(['countryId', 'cityId', 'countryName', 'cityName', 'titleZh', 'titleEn'])

const omitKeys = (value: object, keys: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)))

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 媒体项逐条校验（PR1 发现 7，PR2 规格 §2.6）：必须是对象，`id` 为非空字符串，`kind` 属于已知四种，
 * `cityId` 为非空字符串。不合格返回原因（不含条目内容），合格返回 undefined。
 */
export const mediaItemProblem = (item: unknown): string | undefined => {
  if (!isRecordObject(item)) return '不是一个对象'
  if (typeof item.id !== 'string' || !item.id) return '缺少 id'
  if (typeof item.kind !== 'string' || !KNOWN_MEDIA_KINDS.includes(item.kind)) return '的 kind 不是 photo / panorama360 / aerialPhoto / video 之一'
  if (typeof item.cityId !== 'string' || !item.cityId) return '缺少 cityId'
  return undefined
}

let regionNameCache: Map<string, Intl.DisplayNames | null> | undefined

/**
 * 两位国家代码 → 地区名（`iso:<CC>` 地点的名称）。与 UI 显示想去国家名的方式一致：
 * `Intl.DisplayNames(…, { type: 'region' })`，环境不支持或代码不认识时回落为代码本身。
 * 这些地点今天不在任何界面作为国家显示，名称只为 Canonical 完整。
 */
const regionName = (locale: string, code: string): string => {
  regionNameCache ??= new Map()
  if (!regionNameCache.has(locale)) {
    try {
      regionNameCache.set(locale, new Intl.DisplayNames([locale], { type: 'region' }))
    } catch {
      regionNameCache.set(locale, null)
    }
  }
  try {
    return regionNameCache.get(locale)?.of(code) ?? code
  } catch {
    return code
  }
}

/** Legacy Adapter 的完整构造。`legacyAdapter` 只取其中的 `canonical`。 */
export function buildLegacyCanonical(raw: RawAppInputs): LegacyCanonicalBuild {
  const travelMap = raw.travelMap
  const display: TravelMapDisplay = travelMap.display ?? {}
  const editor = deriveEditorState(raw.editorState)

  // ---- 1. 国家别名归一、旧键、旧分类 ----
  const aliased = aliasRecords(travelMap.records, display)
  const keys = aliased.map(legacyKeysOf)
  const planned = aliased.map((record) => record.status === 'planned')
  const isPlanned = (index: number) => planned[index]
  const legacyCategories = aliased.map((record, index) => (planned[index] ? undefined : legacyCategoryOf(record, display)))
  const editorHiddenCountries = new Set(editor.hiddenCountryIds)
  const editorHiddenCities = new Set(editor.hiddenCityIds)
  const editorHidden = (index: number) =>
    editorHiddenCountries.has(keys[index].countryId) || editorHiddenCities.has(keys[index].cityId)
  const shownToday = (index: number) => !planned[index] && !legacyCategories[index]?.hiddenFromHome && !editorHidden(index)

  const countryGroups = new Map<PlaceId, number[]>()
  const cityGroups = new Map<PlaceId, number[]>()
  keys.forEach(({ countryId, cityId }, index) => {
    countryGroups.set(countryId, [...(countryGroups.get(countryId) ?? []), index])
    cityGroups.set(cityId, [...(cityGroups.get(cityId) ?? []), index])
  })

  // ---- 2. 足迹地点：名称与 ISO 取自代表记录 ----
  const places = new Map<PlaceId, CanonicalPlace>()
  const addPlace = (place: CanonicalPlace) => {
    if (!places.has(place.id)) places.set(place.id, place)
  }

  for (const [countryId, indices] of countryGroups) {
    const rep = aliased[selectRepresentative(indices, shownToday, isPlanned)]
    const iso = countryIsoOf(rep, display)
    addPlace({
      id: countryId,
      subtype: 'country',
      names: placeNames(rep.country, rep.country_en),
      ...(iso ? { externalIds: { iso3166Alpha2: iso } } : {}),
      legacyKeys: [countryId],
    })
  }
  for (const [cityId, indices] of cityGroups) {
    const rep = aliased[selectCityRepresentative(indices, aliased, shownToday, isPlanned)]
    addPlace({
      id: cityId,
      subtype: 'city',
      names: placeNames(rep.city, rep.city_en),
      partOf: keys[indices[0]].countryId,
      legacyKeys: [cityId],
    })
  }

  // ---- 3. 显示规则：变体写法统一成地点名称，再落到地点上 ----
  const recordCountryIds = [...countryGroups.keys()]
  const reconstructedEnOf = (countryId: PlaceId) => places.get(countryId)?.names.en ?? ''
  const ruleRecords: RuleRecord[] = aliased.map((record, index) => ({
    countryId: keys[index].countryId,
    countryEn: record.country_en,
    region: record.region,
  }))
  const hiddenRule = unifyCountryRule(display.hiddenCountries, ruleRecords, reconstructedEnOf)
  const originRule = unifyCountryRule(display.originCountries, ruleRecords, reconstructedEnOf)
  const regionRule = unifyRegionRule(display.regionMatchers, ruleRecords, reconstructedEnOf)

  const canonicalDisplay: CanonicalDisplay = {
    ...(display.overviewTarget !== undefined && display.overviewTarget !== null ? { overviewTarget: display.overviewTarget } : {}),
    homeHiddenCountryIds: countriesNamed(hiddenRule.values, recordCountryIds, reconstructedEnOf),
    originCountryIds: countriesNamed(originRule.values, recordCountryIds, reconstructedEnOf),
    regionCountryIds: countriesNamed(regionRule.values, recordCountryIds, reconstructedEnOf),
    regionIncludes: regionIncludesFrom(regionRule.values, aliased.map((record) => record.region)),
    navigationHiddenCityIds: [],
  }

  // ---- 4. 足迹记录：去掉名称字段，引用城市地点；非 planned 记录写入 journeyId ----
  const records: CanonicalTravelRecord[] = aliased.map((record, index) => {
    const canonical = { ...omitKeys(record, LEGACY_PLACE_FIELDS), placeId: keys[index].cityId } as CanonicalTravelRecord
    if (!planned[index]) canonical.journeyId = legacyJourneyIdOf(record, display)
    return canonical
  })

  // ---- 5. 新分类（与 ./derive.ts 同一个函数）→ 显示中的记录 ----
  const sets = displaySets(canonicalDisplay)
  const canonicalCategories = records.map((record, index): LegacyCategory | undefined => {
    if (planned[index]) return undefined
    const travelCategory = classifyByPlace(record, keys[index].countryId, sets)
    return { travelCategory, hiddenFromHome: hiddenFromHomeFor(record, travelCategory) }
  })
  const shownNow = (index: number) => !planned[index] && !canonicalCategories[index]?.hiddenFromHome && !editorHidden(index)

  // ---- 6. 坐标：在重建后的记录上算（名称已统一，按名查表与新旧路径一致）----
  const reconstructed = records.map((record) => reconstructRecord(record, places))
  const locationSet = (indices: readonly number[]) => {
    const shown = indices.filter(shownNow)
    if (shown.length > 0) return shown
    const nonPlanned = indices.filter((index) => !planned[index])
    return nonPlanned.length > 0 ? nonPlanned : indices
  }
  for (const [countryId, indices] of countryGroups) {
    const location = countryLocationOf(locationSet(indices).map((index) => reconstructed[index]))
    if (location) places.set(countryId, { ...places.get(countryId)!, location })
  }
  for (const [cityId, indices] of cityGroups) {
    const location = cityLocationOf(locationSet(indices).map((index) => reconstructed[index]))
    if (location) places.set(cityId, { ...places.get(cityId)!, location })
  }

  // ---- 7. hiddenCityNames：按显示中城市的名称匹配 ----
  const shownCities = new Map<PlaceId, { id: PlaceId; nameEn: string; nameZh: string }>()
  records.forEach((record, index) => {
    if (!shownNow(index) || shownCities.has(record.placeId)) return
    const { city, city_en } = reconstructed[index]
    shownCities.set(record.placeId, { id: record.placeId, nameEn: city_en || city, nameZh: city })
  })
  const hiddenCityRule = unifyHiddenCityNames(display.hiddenCityNames, [...shownCities.values()])
  canonicalDisplay.navigationHiddenCityIds = hiddenCityRule.cityIds

  // ---- 8. editor-state 的手动添加国家 ----
  const addedCountries: CanonicalAddedCountry[] = editor.addedCountries.map((entry) => {
    if (!places.has(entry.id)) {
      const iso = isoFromCode(entry.countryCode)
      addPlace({
        id: entry.id,
        subtype: 'country',
        names: placeNames(entry.nameZh, entry.nameEn),
        ...(iso ? { externalIds: { iso3166Alpha2: iso } } : {}),
        location: { lat: entry.centerLat, lng: entry.centerLng },
        legacyKeys: [entry.id],
      })
    }
    const place = places.get(entry.id)!
    const canonical: CanonicalAddedCountry = { placeId: entry.id }
    if (entry.region !== undefined) canonical.region = entry.region
    if (entry.visitedDate !== undefined) canonical.visitedDate = entry.visitedDate
    if (!isoOf(place)) canonical.countryCode = entry.countryCode
    if (!place.location) canonical.center = { lat: entry.centerLat, lng: entry.centerLng }
    return canonical
  })

  // ---- 9. 想去：每个条目一个地点；城市的所属国家按 ISO 找足迹国家 ----
  const wantToGoParsed = raw.wantToGo.source === 'sample' || raw.wantToGo.source === 'local'
    ? parseWantToGoFile(raw.wantToGo.value)
    : { items: [], problems: [] }
  const footprintCountriesByIso = new Map<string, PlaceId[]>()
  for (const countryId of [...recordCountryIds, ...addedCountries.map((entry) => entry.placeId)]) {
    const iso = isoOf(places.get(countryId))
    if (!iso) continue
    const ids = footprintCountriesByIso.get(iso) ?? []
    if (!ids.includes(countryId)) footprintCountriesByIso.set(iso, [...ids, countryId])
  }
  const wantToGoItems: CanonicalWantToGoItem[] = wantToGoParsed.items.map((item) => {
    // 同一个 item.id 出现多次（手改文件）时，后面的条目加序号，保证「每个条目一个地点」。
    let placeId = `wtg:${item.id}`
    for (let suffix = 2; places.has(placeId); suffix += 1) placeId = `wtg:${item.id}#${suffix}`
    const { kind, nameZh, nameEn, countryCode, lat, lng } = item.place
    const location = lat !== undefined && lng !== undefined ? { location: { lat, lng } } : {}
    if (kind === 'country') {
      addPlace({ id: placeId, subtype: 'country', names: placeNames(nameZh, nameEn), externalIds: { iso3166Alpha2: countryCode }, ...location })
    } else {
      const matches = footprintCountriesByIso.get(countryCode) ?? []
      const partOf = matches.length === 1 ? matches[0] : `iso:${countryCode}`
      if (!places.has(partOf)) {
        addPlace({
          id: partOf,
          subtype: 'country',
          names: placeNames(regionName('zh-Hans', countryCode), regionName('en', countryCode)),
          externalIds: { iso3166Alpha2: countryCode },
        })
      }
      addPlace({ id: placeId, subtype: 'city', names: placeNames(nameZh, nameEn), partOf, ...location })
    }
    const canonical: CanonicalWantToGoItem = { id: item.id, placeId, addedAt: item.addedAt, hidden: item.hidden }
    if (item.note !== undefined) canonical.note = item.note
    if (item.source !== undefined) canonical.source = item.source
    return canonical
  })

  // ---- 10. 媒体：逐条校验；引用不存在城市的条目保留（悬空引用）----
  const mediaProblems: string[] = []
  const mediaItems: CanonicalMediaItem[] = []
  const rawMediaItems: unknown[] = isCatalog(raw.mediaCatalog) ? raw.mediaCatalog.items : []
  rawMediaItems.forEach((item, index) => {
    const problem = mediaItemProblem(item)
    if (problem) {
      mediaProblems.push(`第 ${index + 1} 条媒体记录${problem}，已跳过。`)
      return
    }
    const source = item as Record<string, unknown>
    const names = placeNames(source.titleZh, source.titleEn)
    mediaItems.push({
      ...omitKeys(source, LEGACY_MEDIA_PLACE_FIELDS),
      placeId: source.cityId as string,
      ...(Object.keys(names).length > 0 ? { title: { names } } : {}),
    } as CanonicalMediaItem)
  })

  // ---- 组装 ----
  const meta: CanonicalTravelMeta = {
    schemaVersion: travelMap.schema_version,
    generatedAt: travelMap.generated_at,
    ...(travelMap.privacy_level !== undefined ? { privacyLevel: travelMap.privacy_level } : {}),
    ...(travelMap.intended_use !== undefined ? { intendedUse: travelMap.intended_use } : {}),
    ...(travelMap.safety_notes !== undefined ? { safetyNotes: travelMap.safety_notes } : {}),
  }

  const canonical: CanonicalData = {
    places: [...places.values()],
    travel: { source: raw.travelAtlasDataSource, meta, display: canonicalDisplay, records },
    wantToGo: { source: raw.wantToGo.source, items: wantToGoItems, problems: wantToGoParsed.problems },
    editorState: {
      schemaVersion: 2,
      addedCountries,
      countryOrder: editor.countryOrder,
      hiddenCountryIds: editor.hiddenCountryIds,
      cityOrderByCountry: editor.cityOrderByCountry,
      hiddenCityIds: editor.hiddenCityIds,
      mediaOrderByCity: editor.mediaOrderByCity,
      hiddenMediaIds: editor.hiddenMediaIds,
      coverMediaByCity: editor.coverMediaByCity,
      droneOrderByCity: editor.droneOrderByCity,
      hiddenDroneMediaIds: editor.hiddenDroneMediaIds,
      ...(editor.updatedAt !== undefined ? { updatedAt: editor.updatedAt } : {}),
    },
    media: { items: mediaItems, problems: mediaProblems },
  }

  const invalidDisplayPaths = [
    ...hiddenRule.invalidIndices.map((index) => `display.hiddenCountries[${index}]`),
    ...originRule.invalidIndices.map((index) => `display.originCountries[${index}]`),
    ...regionRule.invalidIndices.map((index) => `display.regionMatchers[${index}]`),
    ...hiddenCityRule.invalidIndices.map((index) => `display.hiddenCityNames[${index}]`),
  ]

  return {
    canonical,
    legacyDisplay: {
      hiddenCountries: hiddenRule.values,
      originCountries: originRule.values,
      regionMatchers: regionRule.values,
      hiddenCityNames: hiddenCityRule.values,
    },
    invalidDisplayPaths,
    aliasedRecords: aliased,
    legacyCategories,
    canonicalCategories,
  }
}

/** 旧格式的原始数据 → Canonical Model。 */
export function legacyAdapter(raw: RawAppInputs): CanonicalData {
  return buildLegacyCanonical(raw).canonical
}
