/**
 * 迁移规划（RFC-LOC-1 §3.4–§3.6，PR3a 规格 §2.4）：旧格式的原始数据 → V2 文件，纯函数。
 *
 * `src/data/migration/` 是 App 层的迁移工具，【不是】 StarMap Core。输入与 App 相同（`RawAppInputs`），
 * 先经 Legacy Adapter 得到 L（id 仍是旧键），然后：
 *
 *   1. 门槛检查（错误）：版本、想去与媒体的坏条目、悬空媒体、国家的 ISO 代码；
 *   2. `addedCountries` 条目保留的国家代码 / 中心坐标提升到地点上；
 *   3. 国家合并（以 ISO 为身份，全部自动）：`iso:<CC>` 地点、想去国家并入同 ISO 的国家；
 *   4. 城市合并：想去城市 W 与足迹城市 T 的 FR-MR-5 合并键相同 → 自动合并（名称或坐标不同需确认）；
 *      同国家内中文名相同或相距 ≤ 10 km → 疑似重复，由作者决定 merge / separate；
 *   5. apply：在旧 id 空间里完成合并，得到 L′；
 *   6. 每个 L′ 地点按稳定来源键向迁移清单要 UUID（没有就分配，清单只增不改）；
 *   7. 把 L′ 的地点 id 全部换成 UUID，得到 M；
 *   8. 写成 V2 文件，校验，再读回：必须与 M 相等；
 *   10. 完整性：`legacyKeys` 全文件唯一，V2 文件通过校验。
 *
 * 本文件是全仓库唯一允许「知道旧 id 约定」的地方（稳定来源键 `<subtype>:<旧 id>` 与 legacyKeys 的
 * 命名空间前缀），PR5 连同 Legacy Adapter 一起删除。它不按名字推导任何身份：合并键只用于判断
 * 「是不是同一个地点」（RFC ID-6），结论落在「哪个地点并入哪个地点」上。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 * 不读时钟、不读随机源：`now` 与 `newId` 由调用方注入。
 */

import { slugify } from '../../worldgraph/slug.ts'
import type { RawAppInputs } from '../derive/appData.ts'
import { legacyAdapter } from '../canonical/legacyAdapter.ts'
import { normalizeLegacy } from '../canonical/normalizeLegacy.ts'
import { editorStatePlaceRefs, mapPlaceIds } from '../canonical/placeIds.ts'
import { EN, ZH, isoOf } from '../canonical/reconstruct.ts'
import { isoFromCode } from '../canonical/representatives.ts'
import type { CanonicalData, CanonicalEditorState, CanonicalPlace, PlaceId } from '../canonical/types.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { validateV2Files, type V2Files } from '../canonical/v2Schema.ts'
import { WANT_TO_GO_META_KEYS, jsonClone, recordMatchesCityLocation, serializeV2 } from '../canonical/v2Serializer.ts'
import { emptyManifest, type IdentityDecisions, type IdentityManifest } from './identityFiles.ts'
import { diffJson, type DiffSummary } from './jsonDiff.ts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type MigrationErrorCode =
  | 'E_MIXED_VERSIONS'
  | 'E_WTG_PROBLEMS'
  | 'E_MEDIA_INVALID'
  | 'E_MEDIA_DANGLING'
  | 'E_PLACE_NAME_MISSING'
  | 'E_COUNTRY_ISO_DUPLICATE'
  | 'E_COUNTRY_ISO_MISSING'
  | 'E_DECISION_CONFLICT'
  | 'E_ROUNDTRIP'
  | 'E_SHADOW_CANONICAL'
  | 'E_SHADOW_DERIVED'
  | 'E_DUPLICATE_LEGACY_KEY'
  | 'E_INVALID_OUTPUT'

/** 一条错误或提示。`ids` 是记录 id、地点旧 id、文件名或 JSON 路径，不含名称与坐标。 */
export interface MigrationIssue<Code extends string = string> {
  code: Code
  message: string
  ids: string[]
}

export type DecisionKind = 'duplicate' | 'nameDifference' | 'coordinateDifference'

/** 一个需确认 / 需决定的项。`key` 照抄进决定文件对应的表即可。 */
export interface DecisionItem {
  kind: DecisionKind
  key: string
  /** 允许的取值。 */
  options: readonly string[]
  /** 决定文件里的取值；没有（或取值不合法）时不出现。 */
  decision?: string
  subtype: 'country' | 'city'
  /** 被并入 / 疑似重复的想去地点（旧 id）与引用它的想去条目。 */
  from: PlaceId
  wantToGoItemIds: string[]
  /** 存活地点 / 疑似重复的足迹城市（旧 id）。 */
  into: PlaceId
  /** 两边的名称（供作者判断；只写进 JSON 报告，CLI 摘要不打印）。 */
  names: { from: Record<string, string>; into: Record<string, string> }
  /** 两边都有坐标时的距离（千米）。 */
  distanceKm?: number
  fromHasLocation: boolean
  intoHasLocation: boolean
  /** 疑似重复的依据。 */
  reasons?: ('sameNameZh' | 'within10Km')[]
}

export type MergeRule = 'isoCountry' | 'wantToGoCountry' | 'mergeKey' | 'duplicate'

/** 一次地点合并（旧 id 空间）。 */
export interface MergeEntry {
  subtype: 'country' | 'city'
  from: PlaceId
  into: PlaceId
  rule: MergeRule
  /** silent：不需要确认；accepted：需要的确认都已给出（或决定为 merge）；pending：还有未确认项。 */
  status: 'silent' | 'accepted' | 'pending'
  confirmations: DecisionKind[]
}

/** L′ 的一个地点被分到的 UUID。 */
export interface PlaceAssignment {
  sourceKey: string
  oldId: PlaceId
  newId: string
  subtype: 'country' | 'city'
  names: Record<string, string>
  /** 本次新分配（清单里原来没有）。 */
  allocated: boolean
}

export interface MigrationCounts {
  places: number
  countries: number
  cities: number
  footprintCountries: number
  footprintCities: number
  records: number
  wantToGoItems: number
  mediaItems: number
  /** editor-state 各字段里的地点引用数。 */
  editorStateRefs: Record<string, number>
}

export interface MigrationReport {
  sourceHash: string
  plannedAt: string
  counts: { before: MigrationCounts; after: MigrationCounts }
  errors: MigrationIssue<MigrationErrorCode>[]
  needsDecision: DecisionItem[]
  info: MigrationIssue[]
  merges: MergeEntry[]
  places: PlaceAssignment[]
  /** 写出并读回（步骤 8）。有门槛错误时不运行。 */
  roundTrip: { ran: boolean; skippedBecause?: string; diff?: DiffSummary }
  canApply: boolean
}

/** 旧文件里 Canonical 没有的顶层元数据，原样写进 V2（PR3a 规格 §2.2）。足迹的元数据已在 Canonical 的 `travel.meta` 里。 */
export interface MigrationFileMeta {
  /** 旧想去文件的 `generated_at` / `privacy_level` / `intended_use`。 */
  wantToGo?: Record<string, unknown>
  /** 旧媒体文件除 `schemaVersion` 与 `items` 外的顶层字段。 */
  media?: Record<string, unknown>
}

export interface PlanMigrationInput {
  /** 旧文件（私人模式：缺的文件视为空，不回落到样例）。 */
  raw: RawAppInputs
  fileMeta: MigrationFileMeta
  /** 上次 dry-run 留下的迁移清单；没有就新建。 */
  manifest?: IdentityManifest
  decisions?: IdentityDecisions
  /** 由 CLI 计算：四个旧文件原文的 sha256。 */
  sourceHash: string
  /** 分配新 UUID。 */
  newId: () => string
  /** 规划时间（ISO 8601）：写进清单的 plannedAt 与地点注册表的 generated_at。 */
  now: string
}

/** 规划的中间结果，只给测试与诊断用。 */
export interface MigrationCanonicals {
  /** L：Legacy Adapter 的输出。 */
  legacy: CanonicalData
  /** L′：在旧 id 空间里完成合并与决定之后。 */
  applied: CanonicalData
  /** M：地点 id 换成 UUID 之后（有门槛错误时没有）。 */
  migrated?: CanonicalData
  /** UUID → 旧 id。 */
  oldIdOf: Map<string, PlaceId>
}

export interface MigrationPlan {
  report: MigrationReport
  /** 追加了新分配的 id、记录了本次 sourceHash 的迁移清单。 */
  manifest: IdentityManifest
  /** 仅当没有错误时产出。 */
  files?: V2Files
  canonical: MigrationCanonicals
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFootprint = (place: CanonicalPlace) => place.legacyKeys !== undefined

const sameNames = (left: Record<string, string>, right: Record<string, string>) => {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

const EARTH_RADIUS_KM = 6371.0088

/** 大圆距离（haversine），千米。 */
export const distanceKm = (from: { lat: number; lng: number }, to: { lat: number; lng: number }): number => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = radians(to.lat - from.lat)
  const dLng = radians(to.lng - from.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 静默合并允许的最大坐标差。 */
export const SAME_PLACE_KM = 1
/** 疑似重复的距离阈值。 */
export const SUSPECTED_DUPLICATE_KM = 10

// ---------------------------------------------------------------------------
// FR-MR-5 合并键：与 src/worldgraph/query.ts 的 mergeKeyOf 逐字一致
// ---------------------------------------------------------------------------
//
// Core 的 mergeKeyOf 不导出（本 PR 不改 Core），这里照抄它与它的两个输入：
// - 国家代码：`asCountryCode`（两位字母才算，统一大写）。足迹城市取所属国家 Entity 的 flagCode
//   （= 国家地点 ISO 的小写），想去地点取自身的 countryCode（= 所属国家地点的 ISO）；
// - 名称：Entity 的 title。足迹城市的 title 由 Core travel 适配器 `buildTitle(city.nameZh, city.nameEn)`
//   得到，City 的名称由 ../canonical/derive.ts 从地点重建（nameZh = 中文名，nameEn = 英文名 || 中文名）；
//   想去地点的 title 是 `{ zh: nameZh, en: nameEn }`，由 ../canonical/reconstruct.ts 从地点重建。
// planMigration.test.ts 用真实管线 queryVisiblePlaces 对拍这套判断。

type EntityTitle = { zh: string; en?: string }

const asCountryCode = (value: unknown): string | undefined => {
  const code = typeof value === 'string' && value !== '' ? value.trim().toUpperCase() : undefined
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
}

const footprintCityTitle = (place: CanonicalPlace): EntityTitle => {
  const nameZh = place.names[ZH] ?? ''
  const nameEn = (place.names[EN] ?? '') || nameZh
  const title: EntityTitle = { zh: nameZh || nameEn || '' }
  if (nameEn) title.en = nameEn
  return title
}

const wantToGoTitle = (place: CanonicalPlace): EntityTitle => ({ zh: place.names[ZH] ?? '', en: place.names[EN] ?? '' })

const mergeKeyOf = (countryCode: string | undefined, title: EntityTitle): string | undefined => {
  if (countryCode === undefined) return undefined
  const slug = slugify(title.en ?? title.zh)
  return slug === '' ? undefined : `${countryCode}:${slug}`
}

// ---------------------------------------------------------------------------
// 版本门槛
// ---------------------------------------------------------------------------

/** 旧格式认识的版本（四个旧文件）。V2 文件的版本（足迹 2、想去 2、编辑状态 2、媒体 3）出现在旧位置即为「混杂」。 */
const LEGACY_VERSIONS = {
  'travel-map': { key: 'schema_version', known: [1] },
  'want-to-go': { key: 'schema_version', known: [1] },
  'editor-state': { key: 'schemaVersion', known: [1] },
  'user-media': { key: 'schemaVersion', known: [1, 2] },
} as const

const versionIssue = (raw: RawAppInputs): MigrationIssue<MigrationErrorCode> | undefined => {
  const values: Record<keyof typeof LEGACY_VERSIONS, unknown> = {
    'travel-map': raw.travelMap,
    'want-to-go': raw.wantToGo.source === 'none' ? undefined : raw.wantToGo.value,
    'editor-state': raw.editorState,
    'user-media': raw.mediaCatalog,
  }
  const problems: string[] = []
  const ids: string[] = []
  for (const [file, { key, known }] of Object.entries(LEGACY_VERSIONS) as [keyof typeof LEGACY_VERSIONS, (typeof LEGACY_VERSIONS)[keyof typeof LEGACY_VERSIONS]][]) {
    const value = values[file]
    // 不存在（undefined）或内容为 null：与 App 一样按空处理。
    if (value === undefined || value === null) continue
    if (!isObject(value)) {
      problems.push(`${file} 不是对象`)
      ids.push(file)
      continue
    }
    const version = value[key]
    if (!(known as readonly unknown[]).includes(version)) {
      problems.push(`${file} 的 ${key} 为 ${typeof version === 'number' ? version : typeof version}（旧格式只认 ${known.join(' / ')}）`)
      ids.push(file)
    } else if (file === 'user-media' && !Array.isArray(value.items)) {
      problems.push(`${file} 的 items 不是数组`)
      ids.push(file)
    }
  }
  if (problems.length === 0) return undefined
  return { code: 'E_MIXED_VERSIONS', message: `旧文件版本混杂或出现未知版本：${problems.join('；')}。`, ids }
}

// ---------------------------------------------------------------------------
// 计数与提示
// ---------------------------------------------------------------------------

const countsOf = (data: CanonicalData): MigrationCounts => {
  const editorStateRefs: Record<string, number> = {}
  for (const { where } of editorStatePlaceRefs(data.editorState)) editorStateRefs[where] = (editorStateRefs[where] ?? 0) + 1
  return {
    places: data.places.length,
    countries: data.places.filter((place) => place.subtype === 'country').length,
    cities: data.places.filter((place) => place.subtype === 'city').length,
    footprintCountries: data.places.filter((place) => place.subtype === 'country' && isFootprint(place)).length,
    footprintCities: data.places.filter((place) => place.subtype === 'city' && isFootprint(place)).length,
    records: data.travel.records.length,
    wantToGoItems: data.wantToGo.items.length,
    mediaItems: data.media.items.length,
    editorStateRefs,
  }
}

/** PR2 normalizeLegacy 报告里与迁移错误重复的类别（它们在这里是错误，不再当提示列出）。 */
const NORMALIZE_CATEGORIES_REPORTED_AS_ERRORS = new Set(['mediaInvalid', 'mediaDangling', 'countryWithoutIso'])

// ---------------------------------------------------------------------------
// editor-state 的悬空引用
// ---------------------------------------------------------------------------

const dropStaleEditorRefs = (state: CanonicalEditorState, exists: (id: PlaceId) => boolean) => {
  const stale: string[] = []
  const keep = (where: string) => (id: PlaceId) => {
    if (exists(id)) return true
    stale.push(`${where}:${id}`)
    return false
  }
  const keepKeys = <T,>(where: string, record: Record<PlaceId, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => keep(where)(id)))
  const cityOrderByCountry = Object.fromEntries(
    Object.entries(state.cityOrderByCountry)
      .filter(([countryId]) => keep('cityOrderByCountry')(countryId))
      .map(([countryId, cityIds]) => [countryId, cityIds.filter(keep(`cityOrderByCountry.${countryId}`))]),
  )
  const next: CanonicalEditorState = {
    ...state,
    addedCountries: state.addedCountries.filter((entry) => keep('addedCountries')(entry.placeId)),
    countryOrder: state.countryOrder.filter(keep('countryOrder')),
    hiddenCountryIds: state.hiddenCountryIds.filter(keep('hiddenCountryIds')),
    cityOrderByCountry,
    hiddenCityIds: state.hiddenCityIds.filter(keep('hiddenCityIds')),
    mediaOrderByCity: keepKeys('mediaOrderByCity', state.mediaOrderByCity),
    coverMediaByCity: keepKeys('coverMediaByCity', state.coverMediaByCity),
    droneOrderByCity: keepKeys('droneOrderByCity', state.droneOrderByCity),
  }
  return { state: next, stale }
}

// ---------------------------------------------------------------------------
// 文件级元数据
// ---------------------------------------------------------------------------

/** 从旧文件（`RawAppInputs`）取出 Canonical 没有的顶层元数据，交给 `planMigration`。 */
export const fileMetaFromRaw = (raw: RawAppInputs): MigrationFileMeta => {
  const meta: MigrationFileMeta = {}
  const wantToGo = raw.wantToGo.source === 'none' ? undefined : raw.wantToGo.value
  if (isObject(wantToGo)) {
    meta.wantToGo = Object.fromEntries(WANT_TO_GO_META_KEYS.filter((key) => wantToGo[key] !== undefined).map((key) => [key, wantToGo[key]]))
  }
  if (isObject(raw.mediaCatalog)) {
    meta.media = Object.fromEntries(Object.entries(raw.mediaCatalog).filter(([key]) => key !== 'schemaVersion' && key !== 'items'))
  }
  return meta
}

// ---------------------------------------------------------------------------
// 规划
// ---------------------------------------------------------------------------

/** 稳定来源键（PR3a 规格 §2.4 第 6 步）：有 legacyKeys 的地点为 `<subtype>:<旧 id>`，想去与 `iso:` 地点为旧 id 本身。 */
export const sourceKeyOf = (place: CanonicalPlace): string =>
  isFootprint(place) ? `${place.subtype}:${place.id}` : place.id

/** 旧格式原始数据 → 迁移规划（报告、迁移清单、V2 文件）。纯函数。 */
export function planMigration(input: PlanMigrationInput): MigrationPlan {
  const { raw, ...rest } = input
  const versions = versionIssue(raw)
  const normalizeInfo: MigrationIssue[] = normalizeLegacy(raw).report.categories
    .filter((category) => category.count > 0 && !NORMALIZE_CATEGORIES_REPORTED_AS_ERRORS.has(category.key))
    .map((category) => ({ code: `I_NORMALIZE_${category.key}`, message: `${category.label}：${category.count}`, ids: category.ids }))
  return planFromCanonical({
    ...rest,
    legacy: legacyAdapter(raw),
    preErrors: versions ? [versions] : [],
    preInfo: normalizeInfo,
  })
}

export interface PlanFromCanonicalInput extends Omit<PlanMigrationInput, 'raw'> {
  /** L：Legacy Adapter 的输出（不会被修改）。 */
  legacy: CanonicalData
  /** 只能从原始文件判断的错误（版本门槛）。 */
  preErrors?: MigrationIssue<MigrationErrorCode>[]
  /** 只能从原始文件得到的提示（normalizeLegacy 报告）。 */
  preInfo?: MigrationIssue[]
}

/**
 * `planMigration` 的主体：从 L 开始规划。单独导出只为测试能构造 Legacy Adapter 产不出来的 L
 * （例如两个地点带同一个 legacy key），App 与 CLI 都调用 `planMigration`。
 */
export function planFromCanonical(input: PlanFromCanonicalInput): MigrationPlan {
  const { decisions } = input
  const errors: MigrationIssue<MigrationErrorCode>[] = [...(input.preErrors ?? [])]
  const info: MigrationIssue[] = [...(input.preInfo ?? [])]
  const addError = (code: MigrationErrorCode, message: string, ids: string[] = []) => errors.push({ code, message, ids })
  const addInfo = (code: string, message: string, ids: string[] = []) => info.push({ code, message, ids })

  // ---- 0. L ----
  const legacy = input.legacy
  const L = jsonClone(legacy)

  // ---- 1. 门槛（一）：坏条目、悬空媒体（版本门槛在 planMigration 里判断）----
  if (L.wantToGo.problems.length > 0) {
    addError('E_WTG_PROBLEMS', `想去数据有 ${L.wantToGo.problems.length} 处解析问题；被跳过的条目迁移后会丢，请先修正想去文件。`, L.wantToGo.problems)
  }
  if (L.media.problems.length > 0) {
    addError('E_MEDIA_INVALID', `媒体目录有 ${L.media.problems.length} 个坏条目；被跳过的条目迁移后会丢，请先修正媒体目录。`, L.media.problems)
  }
  const placeById = new Map(L.places.map((place) => [place.id, place]))
  const danglingMedia = L.media.items.filter((item) => placeById.get(item.placeId)?.subtype !== 'city').map((item) => item.id)
  if (danglingMedia.length > 0) {
    addError('E_MEDIA_DANGLING', `${danglingMedia.length} 个媒体项引用的城市不存在。`, danglingMedia)
  }

  // ---- 2. addedCountries 提升 ----
  const promoted: string[] = []
  for (const entry of L.editorState.addedCountries) {
    if (entry.countryCode === undefined && entry.center === undefined) continue
    const place = placeById.get(entry.placeId)
    let changed = false
    if (entry.countryCode !== undefined) {
      const iso = isoFromCode(entry.countryCode)
      if (place && iso && !isoOf(place)) {
        place.externalIds = { ...place.externalIds, iso3166Alpha2: iso }
        changed = true
      }
      delete entry.countryCode
    }
    if (entry.center !== undefined) {
      if (place && !place.location) {
        place.location = { lat: entry.center.lat, lng: entry.center.lng }
        changed = true
      }
      delete entry.center
    }
    if (changed) promoted.push(entry.placeId)
  }
  if (promoted.length > 0) {
    addInfo('I_ADDED_COUNTRY_PROMOTED', `${promoted.length} 个手动添加国家的国家代码 / 中心坐标已提升到地点上。`, promoted)
  }

  // ---- 1. 门槛（二）：国家的 ISO 代码（提升之后判断）----
  const footprintCountries = L.places.filter((place) => place.subtype === 'country' && isFootprint(place))
  const withoutIso = footprintCountries.filter((place) => !isoOf(place)).map((place) => place.id)
  if (withoutIso.length > 0) {
    addError('E_COUNTRY_ISO_MISSING', `${withoutIso.length} 个足迹国家没有 ISO 国家代码（RFC ID-5）；请在记录的 country_code 或 display.countryCodes 里补齐。`, withoutIso)
  }
  const footprintByIso = new Map<string, PlaceId[]>()
  for (const place of footprintCountries) {
    const iso = isoOf(place)
    if (iso) footprintByIso.set(iso, [...(footprintByIso.get(iso) ?? []), place.id])
  }
  for (const [iso, ids] of footprintByIso) {
    if (ids.length > 1) addError('E_COUNTRY_ISO_DUPLICATE', `${ids.length} 个足迹国家的 ISO 代码都是 ${iso}。`, ids)
  }

  // ---- 想去地点 ----
  const itemIdsByPlace = new Map<PlaceId, string[]>()
  for (const item of L.wantToGo.items) itemIdsByPlace.set(item.placeId, [...(itemIdsByPlace.get(item.placeId) ?? []), item.id])
  const isWantToGoPlace = (place: CanonicalPlace) => itemIdsByPlace.has(place.id)

  const merges: MergeEntry[] = []
  const needsDecision: DecisionItem[] = []
  const decisionOf = (kind: DecisionKind, key: string): string | undefined => {
    const table = kind === 'duplicate' ? decisions?.duplicates : kind === 'nameDifference' ? decisions?.nameDifferences : decisions?.coordinateDifferences
    const value = table?.[key]
    const allowed = kind === 'duplicate' ? ['merge', 'separate'] : ['accept']
    return typeof value === 'string' && allowed.includes(value) ? value : undefined
  }
  const decisionItem = (
    kind: DecisionKind,
    key: string,
    from: CanonicalPlace,
    into: CanonicalPlace,
    reasons?: DecisionItem['reasons'],
  ): DecisionItem => {
    const decision = decisionOf(kind, key)
    const item: DecisionItem = {
      kind,
      key,
      options: kind === 'duplicate' ? ['merge', 'separate'] : ['accept'],
      subtype: from.subtype,
      from: from.id,
      wantToGoItemIds: itemIdsByPlace.get(from.id) ?? [],
      into: into.id,
      names: { from: { ...from.names }, into: { ...into.names } },
      fromHasLocation: from.location !== undefined,
      intoHasLocation: into.location !== undefined,
    }
    if (decision !== undefined) item.decision = decision
    if (from.location && into.location) item.distanceKm = Math.round(distanceKm(from.location, into.location) * 1000) / 1000
    if (reasons) item.reasons = reasons
    needsDecision.push(item)
    return item
  }
  /** 需确认的合并：返回合并的状态。 */
  const confirmMerge = (from: CanonicalPlace, into: CanonicalPlace, confirmations: DecisionKind[]): MergeEntry['status'] => {
    if (confirmations.length === 0) return 'silent'
    const items = confirmations.map((kind) => decisionItem(kind, from.id, from, into))
    return items.every((item) => item.decision === 'accept') ? 'accepted' : 'pending'
  }

  // ---- 3. 国家合并：以 ISO 为身份 ----
  const countryMergedInto = new Map<PlaceId, PlaceId>()
  const countriesByIso = new Map<string, CanonicalPlace[]>()
  for (const place of L.places) {
    const iso = place.subtype === 'country' ? isoOf(place) : undefined
    if (iso) countriesByIso.set(iso, [...(countriesByIso.get(iso) ?? []), place])
  }
  for (const group of countriesByIso.values()) {
    const survivor = group.find(isFootprint) ?? group.find(isWantToGoPlace) ?? group[0]
    for (const place of group) {
      // 两个足迹国家同 ISO 是错误（上面已报），不合并。
      if (place === survivor || isFootprint(place)) continue
      const wantToGo = isWantToGoPlace(place)
      const confirmations: DecisionKind[] = wantToGo && !sameNames(place.names, survivor.names) ? ['nameDifference'] : []
      merges.push({
        subtype: 'country',
        from: place.id,
        into: survivor.id,
        rule: wantToGo ? 'wantToGoCountry' : 'isoCountry',
        status: confirmMerge(place, survivor, confirmations),
        confirmations,
      })
      countryMergedInto.set(place.id, survivor.id)
    }
  }
  const countryOf = (place: CanonicalPlace): PlaceId | undefined =>
    place.partOf === undefined ? undefined : countryMergedInto.get(place.partOf) ?? place.partOf

  // ---- 4. 城市合并：想去城市 W ↔ 足迹城市 T ----
  const footprintCities = L.places.filter((place) => place.subtype === 'city' && isFootprint(place))
  const wantToGoCities = L.places.filter((place) => place.subtype === 'city' && isWantToGoPlace(place))
  const countryCodeOf = (countryId: PlaceId | undefined) => asCountryCode(isoOf(countryId === undefined ? undefined : placeById.get(countryId)))
  // 足迹城市：Core 取所属国家 Entity 的 flagCode（ISO 的小写）再经 asCountryCode 大写回来，结果就是 ISO。
  const footprintKey = new Map(footprintCities.map((city) => [city.id, mergeKeyOf(countryCodeOf(countryOf(city)), footprintCityTitle(city))]))

  const conflicts: string[] = []
  for (const wantToGo of wantToGoCities) {
    const country = countryOf(wantToGo)
    const key = mergeKeyOf(countryCodeOf(country), wantToGoTitle(wantToGo))
    const target = key === undefined ? undefined : footprintCities.find((city) => footprintKey.get(city.id) === key)
    if (target) {
      const confirmations: DecisionKind[] = []
      if (!sameNames(wantToGo.names, target.names)) confirmations.push('nameDifference')
      if (wantToGo.location && (!target.location || distanceKm(wantToGo.location, target.location) > SAME_PLACE_KM)) {
        confirmations.push('coordinateDifference')
      }
      merges.push({
        subtype: 'city',
        from: wantToGo.id,
        into: target.id,
        rule: 'mergeKey',
        status: confirmMerge(wantToGo, target, confirmations),
        confirmations,
      })
      continue
    }

    // 疑似重复：同一国家内、不满足自动合并，但中文名相同或相距 ≤ 10 km。
    const zh = wantToGo.names[ZH]
    const decidedMerges: DecisionItem[] = []
    for (const city of footprintCities) {
      if (countryOf(city) !== country) continue
      const reasons: NonNullable<DecisionItem['reasons']> = []
      if (zh !== undefined && zh === city.names[ZH]) reasons.push('sameNameZh')
      if (wantToGo.location && city.location && distanceKm(wantToGo.location, city.location) <= SUSPECTED_DUPLICATE_KM) reasons.push('within10Km')
      if (reasons.length === 0) continue
      const item = decisionItem('duplicate', `${wantToGo.id}|city:${city.id}`, wantToGo, city, reasons)
      if (item.decision === 'merge') decidedMerges.push(item)
    }
    if (decidedMerges.length > 1) {
      conflicts.push(...decidedMerges.map((item) => item.key))
    } else if (decidedMerges.length === 1) {
      merges.push({ subtype: 'city', from: wantToGo.id, into: decidedMerges[0].into, rule: 'duplicate', status: 'accepted', confirmations: ['duplicate'] })
    }
  }
  if (conflicts.length > 0) {
    addError('E_DECISION_CONFLICT', '同一个想去地点被决定并入多个足迹城市；每个想去地点最多并入一个。', conflicts)
  }

  // 用不上的决定（多半是键抄错了）。
  const usedKeys = new Set(needsDecision.map((item) => `${item.kind}\u0000${item.key}`))
  const unused = [
    ...Object.keys(decisions?.duplicates ?? {}).filter((key) => !usedKeys.has(`duplicate\u0000${key}`)).map((key) => `duplicates:${key}`),
    ...Object.keys(decisions?.nameDifferences ?? {}).filter((key) => !usedKeys.has(`nameDifference\u0000${key}`)).map((key) => `nameDifferences:${key}`),
    ...Object.keys(decisions?.coordinateDifferences ?? {}).filter((key) => !usedKeys.has(`coordinateDifference\u0000${key}`)).map((key) => `coordinateDifferences:${key}`),
  ]
  if (unused.length > 0) addInfo('I_UNUSED_DECISION', `决定文件里有 ${unused.length} 个键不对应任何待决项（键抄错了，或数据已经变了）。`, unused)

  // ---- 5. apply：在旧 id 空间里完成合并 → L′ ----
  const mergedInto = new Map(merges.map((merge) => [merge.from, merge.into]))
  for (const merge of merges) {
    const survivor = placeById.get(merge.into)!
    const merged = placeById.get(merge.from)!
    if (merged.legacyKeys) survivor.legacyKeys = [...new Set([...(survivor.legacyKeys ?? []), ...merged.legacyKeys])]
    // 存活地点用自己的坐标；没有坐标时改用被并入地点的（PR3a 规格 §2.4 第 4 步）。
    if (!survivor.location && merged.location) survivor.location = { ...merged.location }
  }
  const withoutMerged: CanonicalData = { ...L, places: L.places.filter((place) => !mergedInto.has(place.id)) }
  const repointed = mapPlaceIds(withoutMerged, (id) => mergedInto.get(id) ?? id)
  const survivingIds = new Set(repointed.places.map((place) => place.id))
  const { state: editorState, stale } = dropStaleEditorRefs(repointed.editorState, (id) => survivingIds.has(id))
  if (stale.length > 0) addInfo('I_STALE_EDITOR_REF', `editor-state 里有 ${stale.length} 处引用了不存在的地点，已删除（今天也不起作用）。`, stale)
  const applied: CanonicalData = jsonClone({
    ...repointed,
    travel: { ...repointed.travel, meta: { ...repointed.travel.meta, schemaVersion: 2 } },
    editorState,
  })

  const nameless = applied.places.filter((place) => Object.keys(place.names).length === 0).map((place) => place.id)
  if (nameless.length > 0) addError('E_PLACE_NAME_MISSING', `${nameless.length} 个地点没有任何名称。`, nameless)

  // ---- 提示 ----
  if (merges.length > 0) {
    addInfo('I_MERGE', `合并 ${merges.length} 处：静默 ${merges.filter((merge) => merge.status === 'silent').length}，已确认 / 已决定 ${merges.filter((merge) => merge.status === 'accepted').length}，待确认 ${merges.filter((merge) => merge.status === 'pending').length}。`, merges.map((merge) => `${merge.from} → ${merge.into}`))
  }
  const byOld = new Map(applied.places.map((place) => [place.id, place]))
  const withoutEnglish = applied.places.filter((place) => place.names[EN] === undefined).map((place) => place.id)
  if (withoutEnglish.length > 0) addInfo('I_PLACE_WITHOUT_EN', `${withoutEnglish.length} 个地点没有英文名。`, withoutEnglish)
  const citiesWithoutLocation = applied.places.filter((place) => place.subtype === 'city' && !place.location).map((place) => place.id)
  if (citiesWithoutLocation.length > 0) addInfo('I_CITY_WITHOUT_LOCATION', `${citiesWithoutLocation.length} 个城市没有坐标。`, citiesWithoutLocation)
  const approximateCities = applied.places.filter((place) => place.subtype === 'city' && place.location?.approximate).map((place) => place.id)
  if (approximateCities.length > 0) addInfo('I_CITY_APPROXIMATE', `${approximateCities.length} 个城市的坐标是按名查表或兜底得来的（approximate）。`, approximateCities)
  const ownCoordinates = applied.travel.records
    .filter((record) => (typeof record.lat === 'number' || typeof record.lng === 'number') && !recordMatchesCityLocation(record, byOld.get(record.placeId)))
    .map((record) => record.id)
  if (ownCoordinates.length > 0) addInfo('I_RECORD_OWN_COORDINATES', `${ownCoordinates.length} 条记录保留了与所属城市不同的自身坐标。`, ownCoordinates)

  const survivingWantToGoCities = applied.places.filter((place) => place.subtype === 'city' && !isFootprint(place))
  const wantToGoPairs: string[] = []
  survivingWantToGoCities.forEach((left, index) => {
    for (const right of survivingWantToGoCities.slice(index + 1)) {
      if (left.partOf !== right.partOf) continue
      const leftKey = mergeKeyOf(countryCodeOf(left.partOf), wantToGoTitle(left))
      const sameKey = leftKey !== undefined && leftKey === mergeKeyOf(countryCodeOf(right.partOf), wantToGoTitle(right))
      const sameZh = left.names[ZH] !== undefined && left.names[ZH] === right.names[ZH]
      if (sameKey || sameZh) wantToGoPairs.push(`${left.id} | ${right.id}`)
    }
  })
  if (wantToGoPairs.length > 0) addInfo('I_WTG_DUPLICATE', `${wantToGoPairs.length} 对想去地点疑似重复（只报告，按各自的地点迁移）。`, wantToGoPairs)
  const itemIdCounts = new Map<string, number>()
  for (const item of applied.wantToGo.items) itemIdCounts.set(item.id, (itemIdCounts.get(item.id) ?? 0) + 1)
  const repeatedItemIds = [...itemIdCounts].filter(([, count]) => count > 1).map(([id]) => id)
  if (repeatedItemIds.length > 0) addInfo('I_WTG_DUPLICATE_ITEM_ID', `${repeatedItemIds.length} 个想去条目 id 出现了不止一次（各自保留）。`, repeatedItemIds)

  // ---- 6. 分配 id：迁移清单只增不改 ----
  const sources: Record<string, string> = { ...(input.manifest ?? emptyManifest()).sources }
  const places: PlaceAssignment[] = applied.places.map((place) => {
    const sourceKey = sourceKeyOf(place)
    const existing = sources[sourceKey]
    const newId = existing ?? input.newId()
    if (existing === undefined) sources[sourceKey] = newId
    return { sourceKey, oldId: place.id, newId, subtype: place.subtype, names: { ...place.names }, allocated: existing === undefined }
  })
  const allocated = places.filter((place) => place.allocated)
  if (allocated.length > 0) addInfo('I_MANIFEST_ALLOCATED', `迁移清单新分配 ${allocated.length} 个 UUID。`, allocated.map((place) => place.sourceKey))
  const manifest: IdentityManifest = { schema_version: 1, sources, sourceHash: input.sourceHash, plannedAt: input.now }
  const uuidOf = new Map(places.map((place) => [place.oldId, place.newId]))
  const oldIdOf = new Map(places.map((place) => [place.newId, place.oldId]))

  // ---- 7–10. 换 id、写出、校验、读回 ----
  const gateErrors = errors.length
  let migrated: CanonicalData | undefined
  let files: V2Files | undefined
  let roundTrip: MigrationReport['roundTrip'] = { ran: false, skippedBecause: `存在 ${gateErrors} 个门槛错误` }
  if (gateErrors === 0) {
    const renamed = mapPlaceIds(applied, (id) => uuidOf.get(id) ?? id)
    migrated = jsonClone({
      places: renamed.places.map((place) => ({
        ...place,
        ...(place.legacyKeys !== undefined ? { legacyKeys: place.legacyKeys.map((legacyKey) => `${place.subtype}:${legacyKey}`) } : {}),
      })),
      travel: { ...renamed.travel, source: 'local' },
      wantToGo: { ...renamed.wantToGo, source: 'local', problems: [] },
      editorState: renamed.editorState,
      media: { ...renamed.media, problems: [] },
    } satisfies CanonicalData)

    const written = serializeV2(migrated, {
      placesGeneratedAt: input.now,
      wantToGo: input.fileMeta.wantToGo,
      media: input.fileMeta.media,
    })

    const problems = validateV2Files(written)
    const duplicateKeys = problems.filter((problem) => problem.code === 'DUPLICATE_LEGACY_KEY')
    const invalid = problems.filter((problem) => problem.code !== 'DUPLICATE_LEGACY_KEY')
    if (duplicateKeys.length > 0) {
      addError('E_DUPLICATE_LEGACY_KEY', `${duplicateKeys.length} 个 legacy key 属于不止一个地点（RFC ID-2）。`, duplicateKeys.map((problem) => `${problem.file} ${problem.path}`))
    }
    if (invalid.length > 0) {
      addError('E_INVALID_OUTPUT', `写出的 V2 文件有 ${invalid.length} 处没通过校验。`, invalid.map((problem) => `${problem.file} ${problem.path}：${problem.message}`))
    }

    // 经磁盘往返（JSON 文本）再读回。
    let read: CanonicalData | undefined
    try {
      read = readV2(JSON.parse(JSON.stringify(written)) as V2Files)
    } catch (error) {
      addError('E_ROUNDTRIP', `V2 文件读回失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (read) {
      const diff = diffJson(migrated, read)
      roundTrip = { ran: true, diff }
      if (!diff.equal) addError('E_ROUNDTRIP', `V2 文件读回后与写出前不同（${diff.total} 处）。`, diff.paths)
    } else {
      roundTrip = { ran: true }
    }
    if (errors.length === 0) files = written
  }

  const report: MigrationReport = {
    sourceHash: input.sourceHash,
    plannedAt: input.now,
    counts: { before: countsOf(legacy), after: countsOf(applied) },
    errors,
    needsDecision,
    info,
    merges,
    places,
    roundTrip,
    canApply: errors.length === 0 && files !== undefined && needsDecision.every((item) => item.decision !== undefined),
  }

  return { report, manifest, ...(files ? { files } : {}), canonical: { legacy, applied, ...(migrated ? { migrated } : {}), oldIdOf } }
}
