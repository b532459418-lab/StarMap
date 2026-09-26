/**
 * Canonical Model（RFC-LOC-1 §3.6，PR2）：RFC §3 新格式在内存里的形态。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core（`src/worldgraph/**`）。这些类型在 Core Model RFC
 * 定稿时再决定是否下沉进 Core。
 *
 * App 只读 Canonical，不知道磁盘上是哪种格式：
 *
 *   legacy 模式：旧文件 ──Legacy Adapter（./legacyAdapter.ts）──> Canonical ──> 派生（./derive.ts）──> Core ──> UI
 *
 * 与旧格式的根本区别：地点只在 `places` 里定义一次（名称、国家代码、坐标）；足迹记录、想去条目、
 * 媒体与 editor-state 都只按地点 id 引用它，不再各自带一份名称。
 *
 * legacy 模式下地点 id 就是今天已存储的旧键（RFC §3.6、PR2 规格 §2.2）：足迹国家 = CountryId，
 * 足迹城市 = CityId，想去条目的地点 = `wtg:<item.id>`，想去城市所属的无足迹国家 = `iso:<CC>`。
 * 代码不得解析 id 的结构（RFC ID-1）；这些前缀只是保证 id 空间不相交。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { WantToGoDataSource } from '../derive/wantToGo.ts'
import type { ImportedMediaCatalogItem } from '../derive/mediaCatalog.ts'
import type { TravelMapRecord } from '../../types/travel.ts'

/** 地点 id。不透明字符串：不得解析其结构，也不得从名称重新计算（RFC ID-1）。 */
export type PlaceId = string

/** BCP 47 语言标签（RFC LOC-1）。现有中文名全为简体，统一标 `zh-Hans`（LOC-2）。 */
export type LanguageTag = string

/** RFC LOC-1。`names` 只写非空值。 */
export interface LocalizedText {
  names: Record<LanguageTag, string>
  originalLanguage?: LanguageTag
}

/** RFC §3.1 的地点记录。 */
export interface CanonicalPlace {
  id: PlaceId
  subtype: 'country' | 'city'
  /** 只写非空值；legacy 模式下最多 `zh-Hans` 与 `en` 两项。 */
  names: Record<LanguageTag, string>
  /** 国家的 ISO 3166-1 alpha-2，大写。legacy 模式允许缺（缺代码是 PR3 迁移时的错误，RFC ID-5）。 */
  externalIds?: { iso3166Alpha2?: string }
  /** city → country。 */
  partOf?: PlaceId
  /** 地点的规范坐标（RFC Q8）。`approximate` 表示不是来自记录自身的坐标。 */
  location?: { lat: number; lng: number; approximate?: true }
  /** 被持久化引用过的旧键（RFC ID-2）。legacy 模式下就是 id 本身；想去与 `iso:` 地点没有。 */
  legacyKeys?: string[]
}

/** 足迹记录里由地点决定、因而不再存于记录上的五个字段。 */
export type LegacyPlaceField = 'country' | 'country_en' | 'country_code' | 'city' | 'city_en'

/**
 * 足迹记录：原记录的全部事实字段（含未知字段）去掉五个名称 / 代码字段，改为引用城市地点。
 * - 国家别名已应用：`region` 是归一后的值（含 `regionSuffix`）。
 * - 非 planned 记录的 `journeyId` 已按今天的分组规则写入（`journeyRules` 因此被消耗掉）。
 * - 记录自身的 `lat` / `lng` 在 legacy 模式下原样保留。
 */
export type CanonicalTravelRecord = Omit<TravelMapRecord, LegacyPlaceField> & { placeId: PlaceId }

/**
 * 显示规则的 v2 形态：按地点 id 写。
 *
 * 旧规则按字符串匹配记录上的 `country_en` / 城市名；转换时先把同一地点的各种写法统一成地点名称，
 * 匹配不到任何地点的值丢弃（见 ./legacyAdapter.ts）。`countryAliases`、`journeyRules`、`countryCodes`
 * 不在这里：前两者在适配器里被消耗掉，后者进了地点的 ISO 代码。
 */
export interface CanonicalDisplay {
  overviewTarget?: { lat: number; lng: number }
  /** 旧 `hiddenCountries`：这些国家的记录分类为 transit（或 origin），不上首页。 */
  homeHiddenCountryIds: PlaceId[]
  /** 旧 `originCountries`：与上一项同时命中时分类为 origin。 */
  originCountryIds: PlaceId[]
  /** 旧 `regionMatchers` 中「等于国家英文名」的那一半：这些国家的记录分类为 region。 */
  regionCountryIds: PlaceId[]
  /** 旧 `regionMatchers` 中「是记录 region 的子串」的那一半。region 只是记录上的字符串，不是地点（RFC §3.1）。 */
  regionIncludes: string[]
  /** 旧 `hiddenCityNames`：不出现在导航里的城市。 */
  navigationHiddenCityIds: PlaceId[]
}

export interface CanonicalTravelMeta {
  schemaVersion: number
  generatedAt: string
  privacyLevel?: string
  intendedUse?: string
  safetyNotes?: string[]
}

export interface CanonicalTravel {
  /** 调用方选了哪份足迹数据（私有文件或样例）。 */
  source: 'local' | 'sample'
  meta: CanonicalTravelMeta
  display: CanonicalDisplay
  /** 文件顺序，含 planned 记录。 */
  records: CanonicalTravelRecord[]
}

/** 想去条目：`item.place` 换为 `placeId`（RFC §3.2）；`item.id` 不变。 */
export interface CanonicalWantToGoItem {
  id: string
  placeId: PlaceId
  note?: string
  addedAt: string
  hidden: boolean
  source?: string
}

export interface CanonicalWantToGo {
  source: WantToGoDataSource
  items: CanonicalWantToGoItem[]
  /** 解析时被丢弃的坏数据说明（同 Core `parseWantToGoFile`）。 */
  problems: string[]
}

/**
 * editor-state 里手动添加的国家：名称、国家代码、中心坐标在 `places` 里，这里只留条目自己的字段。
 *
 * 条目与某个足迹国家同键时是同一个地点，地点的值优先（PR2 规格 §2.2、§2.5）。只有地点本身
 * 没有国家代码 / 坐标时，条目才保留自己的 `countryCode` / `center`——否则这两项信息会丢，
 * 而今天这个条目在国家没有显示中记录时仍会作为独立国家显示出来。
 */
export interface CanonicalAddedCountry {
  placeId: PlaceId
  region?: string
  visitedDate?: string
  /** 条目原样的国家代码，仅当地点没有 ISO 时存在。 */
  countryCode?: string
  /** 条目原样的中心坐标，仅当地点没有 location 时存在。 */
  center?: { lat: number; lng: number }
}

/** editor-state 的 v2 形态：键与值里的国家 / 城市都是地点 id（legacy 模式下与旧键相同）。 */
export interface CanonicalEditorState {
  schemaVersion: 2
  addedCountries: CanonicalAddedCountry[]
  countryOrder: PlaceId[]
  hiddenCountryIds: PlaceId[]
  cityOrderByCountry: Record<PlaceId, PlaceId[]>
  hiddenCityIds: PlaceId[]
  mediaOrderByCity: Record<PlaceId, string[]>
  hiddenMediaIds: string[]
  coverMediaByCity: Record<PlaceId, string>
  droneOrderByCity: Record<PlaceId, string[]>
  hiddenDroneMediaIds: string[]
  updatedAt?: string
}

/** 媒体项里由地点决定、因而不再存于媒体项上的字段；标题改为 `title`。 */
export type LegacyMediaPlaceField = 'countryId' | 'cityId' | 'countryName' | 'cityName' | 'titleZh' | 'titleEn'

/** 媒体项：引用城市地点；标题是可选的 LocalizedText（RFC Q9）。引用不存在的城市时是悬空引用（保留）。 */
export type CanonicalMediaItem = Omit<ImportedMediaCatalogItem, LegacyMediaPlaceField> & {
  placeId: PlaceId
  title?: LocalizedText
}

export interface CanonicalMedia {
  items: CanonicalMediaItem[]
  /** 被跳过的坏条目：只写序号与原因，不写内容。 */
  problems: string[]
}

export interface CanonicalData {
  places: CanonicalPlace[]
  travel: CanonicalTravel
  wantToGo: CanonicalWantToGo
  editorState: CanonicalEditorState
  media: CanonicalMedia
}
