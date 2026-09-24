/**
 * 旧逻辑基线（RFC-LOC-1 PR1）：把「App 从某份数据派生出的全部结果」固定成一份可逐字节比较的 JSON。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * 本文件只接收「六个数据模块的导出」这种形状（`AppDataExports`），因此同一个函数既能在浏览器里
 * 对真实运行的 App 调用（传入六个模块的 module namespace），也能在 Node 里对 `deriveAppData()`
 * 的结果调用。两边产出相同，就证明 Node 管线与 App 一致。
 *
 * 约束：
 * - 只依赖 Core 的公开函数与类型；不 import 六个原文件（那样 Node 里加载不了）。
 * - erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，不用 import.meta。
 * - 基线的内容与格式一旦被 PR2 引用，就不能随意改；要改，先改 `BASELINE_FORMAT`。
 */

import { queryCollection } from '../../worldgraph/collection.ts'
import { officialLayers, WANT_TO_GO_LAYER_ID } from '../../worldgraph/layers.ts'
import { queryVisiblePlaces } from '../../worldgraph/query.ts'
import type { WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import type { LayerId, WorldGraphSnapshot } from '../../worldgraph/types.ts'
import type { City, CityId, Country, CountryId, TravelMapRecord } from '../../types/travel.ts'

/** 基线格式标识。基线的结构或求值口径变化时改这里，旧基线就不会被误当成可比。 */
export const BASELINE_FORMAT = 'starmap-legacy-baseline@1'

/** 恰好等于 `options.now` 的字符串在基线里一律替换成它。 */
export const NOW_PLACEHOLDER = '<now>'

type MediaVariantName = 'thumb' | 'preview' | 'original'

const mediaVariantNames: readonly MediaVariantName[] = ['thumb', 'preview', 'original']

/** 基线只关心媒体项的 id 与所属城市；完整类型在 mediaCatalog / droneMedia，不属于 Core。 */
interface CityScopedItem {
  id: string
  cityId: CityId
}

/**
 * 六个数据模块今天的导出，按模块分组，名字与原文件一致。
 *
 * 浏览器里直接传 module namespace（多出来的导出会被忽略，见 `baselineExportNames`）。
 * 函数导出写成方法签名：参数按方法的双变规则比较，App 里更具体的参数类型也能传进来。
 */
export interface AppDataExports {
  travelAtlas: {
    travelAtlasDataSource: unknown
    travelAtlasDisplay: unknown
    plannedRecords: readonly TravelMapRecord[]
    travelAtlasCountryCodes: unknown
    travelAtlasMeta: unknown
    hiddenHomeRecords: unknown
    countries: readonly Country[]
    cities: readonly City[]
    journeyDays: unknown
    routes: unknown
    countryById: unknown
    cityById: unknown
    missingCoordinateCities: unknown
    getCitiesForCountry(countryId: CountryId): unknown
    shouldHideCityFromNavigation(city: City): boolean
  }
  editorState: {
    travelAtlasEditorState: unknown
  }
  mediaCatalog: {
    allImportedMediaItems: readonly CityScopedItem[]
    importedMediaItems: unknown
    importedDroneMediaCatalogItems: unknown
    getMediaSource(item: CityScopedItem, variant: MediaVariantName): string
    getCityPhotos(cityId?: CityId): unknown
    getCityCoverPhoto(cityId?: CityId): unknown
  }
  droneMedia: {
    droneMediaItems: readonly CityScopedItem[]
    droneMediaByCity: unknown
    droneMediaById: unknown
    getDroneMediaForCity(cityId?: CityId): unknown
    hasDroneMedia(cityId?: CityId): boolean
  }
  wantToGo: {
    wantToGoDataSource: unknown
    wantToGoItems: readonly WantToGoItem[]
    wantToGoProblems: unknown
    hiddenWantToGoItems: unknown
    wantToGoItemByEntityId: unknown
    plannedRecordByEntityId: unknown
    wantToGoConvertBlockReason(item: WantToGoItem): string | undefined
    plannedConvertBlockReason(record: TravelMapRecord): string | undefined
  }
  worldGraph: {
    worldGraphSessionNow: string
    travelSnapshot: unknown
    wantToGoSnapshot: unknown
    plannedSnapshot: unknown
    worldGraphSnapshot: WorldGraphSnapshot
  }
}

export interface BaselineOptions {
  /** 快照的 createdAt / updatedAt。浏览器里是 worldGraphSessionNow，Node 里是注入值。 */
  now: string
}

type ModuleName = keyof AppDataExports

/**
 * 基线覆盖的导出名。`data` 原样放入；`evaluated` 是函数，按全集求值后放入；
 * `notCaptured` 是明确不进基线的导出及理由（见各项注释）。
 * 三者之并必须等于该模块今天的全部运行时导出——`baseline.test.ts` 用 `deriveAppData` 核对。
 */
export const baselineExportNames = {
  travelAtlas: {
    data: [
      'travelAtlasDataSource',
      'travelAtlasDisplay',
      'plannedRecords',
      'travelAtlasCountryCodes',
      'travelAtlasMeta',
      'hiddenHomeRecords',
      'countries',
      'cities',
      'journeyDays',
      'routes',
      'countryById',
      'cityById',
      'missingCoordinateCities',
    ],
    evaluated: ['getCitiesForCountry', 'shouldHideCityFromNavigation'],
    notCaptured: [],
  },
  editorState: {
    data: ['travelAtlasEditorState'],
    evaluated: [],
    // orderBySavedIds：与数据无关的通用排序工具，它对数据的作用已体现在 countries / 城市照片等结果里。
    // localEditorAvailable：由运行模式（DEV && personal）决定，不是从数据派生的。
    notCaptured: ['orderBySavedIds', 'localEditorAvailable'],
  },
  mediaCatalog: {
    data: ['allImportedMediaItems', 'importedMediaItems', 'importedDroneMediaCatalogItems'],
    evaluated: ['getMediaSource', 'getCityPhotos', 'getCityCoverPhoto'],
    notCaptured: [],
  },
  droneMedia: {
    data: ['droneMediaItems', 'droneMediaByCity', 'droneMediaById'],
    evaluated: ['getDroneMediaForCity', 'hasDroneMedia'],
    notCaptured: [],
  },
  wantToGo: {
    data: [
      'wantToGoDataSource',
      'wantToGoItems',
      'wantToGoProblems',
      'hiddenWantToGoItems',
      'wantToGoItemByEntityId',
      'plannedRecordByEntityId',
    ],
    evaluated: ['wantToGoConvertBlockReason', 'plannedConvertBlockReason'],
    notCaptured: [],
  },
  worldGraph: {
    data: ['worldGraphSessionNow', 'travelSnapshot', 'wantToGoSnapshot', 'plannedSnapshot', 'worldGraphSnapshot'],
    evaluated: [],
    notCaptured: [],
  },
} as const satisfies Record<ModuleName, { data: readonly string[]; evaluated: readonly string[]; notCaptured: readonly string[] }>

const moduleNames = Object.keys(baselineExportNames) as ModuleName[]

/** 取出一个模块的数据导出；缺任何一个都直接报错，免得基线悄悄少一块。 */
const pickData = (moduleName: ModuleName, source: object): Record<string, unknown> => {
  const picked: Record<string, unknown> = {}
  for (const name of baselineExportNames[moduleName].data) {
    if (!(name in source)) throw new Error(`buildBaseline: ${moduleName} 缺少导出 ${name}`)
    picked[name] = (source as Record<string, unknown>)[name]
  }
  return picked
}

/** 按首次出现的顺序去重。 */
const uniqueInOrder = <T,>(values: Iterable<T>): T[] => [...new Set(values)]

/**
 * 图层组合：足迹 × 想去 各开 / 关。可见图层 id 的顺序与 App 相同（按 officialLayers 过滤）。
 * 组合名是固定字符串，与 officialLayers 的顺序无关。
 */
const layerCombinations: readonly { name: string; visible: Partial<Record<LayerId, boolean>> }[] = [
  { name: 'travel+want_to_go', visible: { travel: true, want_to_go: true } },
  { name: 'travel', visible: { travel: true, want_to_go: false } },
  { name: 'want_to_go', visible: { travel: false, want_to_go: true } },
  { name: 'none', visible: { travel: false, want_to_go: false } },
]

const visibleLayerIdsFor = (visible: Partial<Record<LayerId, boolean>>): LayerId[] =>
  officialLayers.filter((layer) => visible[layer.id] === true).map((layer) => layer.id)

/**
 * 转成只含普通对象、数组与原始值的结构：Map → 按插入顺序的 [key, value] 数组，Set → 数组；
 * 恰好等于 now 的字符串（值或键）→ `<now>`。数据里不该出现函数，出现即报错。
 */
const toPlain = (value: unknown, now: string): unknown => {
  if (typeof value === 'string') return value === now ? NOW_PLACEHOLDER : value
  if (typeof value === 'function') throw new TypeError('buildBaseline: 数据导出里出现了函数，函数必须显式求值')
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Map) return [...value].map(([key, item]) => [toPlain(key, now), toPlain(item, now)])
  if (value instanceof Set) return [...value].map((item) => toPlain(item, now))
  if (Array.isArray(value)) return value.map((item) => toPlain(item, now))

  const plain: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    plain[key === now ? NOW_PLACEHOLDER : key] = toPlain(item, now)
  }
  return plain
}

/**
 * 对六个模块的导出拍一份规范化快照。返回值可直接交给 `stableStringify`。
 *
 * - 数据导出原样放入；
 * - 函数导出按全集求值：城市级函数的定义域是「足迹城市 ∪ 媒体项与无人机项引用的城市」（按首次出现顺序），
 *   结果记成 [输入 id, 输出] 数组；函数返回 undefined 时在 JSON 里写成 null；
 * - 额外跑地图查询（四种图层组合）与想去 Collection 查询；
 * - 所有恰好等于 `options.now` 的字符串替换为 `<now>`。
 */
export function buildBaseline(exports: AppDataExports, options: BaselineOptions): unknown {
  for (const moduleName of moduleNames) {
    if (!exports[moduleName] || typeof exports[moduleName] !== 'object') {
      throw new Error(`buildBaseline: 缺少模块 ${moduleName}`)
    }
  }
  const { travelAtlas, mediaCatalog, droneMedia, wantToGo, worldGraph } = exports

  const cityDomain = uniqueInOrder<CityId>([
    ...travelAtlas.cities.map((city) => city.id),
    ...mediaCatalog.allImportedMediaItems.map((item) => item.cityId),
    ...droneMedia.droneMediaItems.map((item) => item.cityId),
  ])

  const evaluated = {
    travelAtlas: {
      getCitiesForCountry: travelAtlas.countries.map((country) => [country.id, travelAtlas.getCitiesForCountry(country.id)]),
      shouldHideCityFromNavigation: travelAtlas.cities.map((city) => [city.id, travelAtlas.shouldHideCityFromNavigation(city)]),
    },
    editorState: {},
    mediaCatalog: {
      getMediaSource: mediaCatalog.allImportedMediaItems.map((item) => [
        item.id,
        Object.fromEntries(mediaVariantNames.map((variant) => [variant, mediaCatalog.getMediaSource(item, variant)])),
      ]),
      getCityPhotos: cityDomain.map((cityId) => [cityId, mediaCatalog.getCityPhotos(cityId)]),
      getCityCoverPhoto: cityDomain.map((cityId) => [cityId, mediaCatalog.getCityCoverPhoto(cityId) ?? null]),
    },
    droneMedia: {
      getDroneMediaForCity: cityDomain.map((cityId) => [cityId, droneMedia.getDroneMediaForCity(cityId)]),
      hasDroneMedia: cityDomain.map((cityId) => [cityId, droneMedia.hasDroneMedia(cityId)]),
    },
    wantToGo: {
      wantToGoConvertBlockReason: wantToGo.wantToGoItems.map((item) => [item.id, wantToGo.wantToGoConvertBlockReason(item) ?? null]),
      plannedConvertBlockReason: travelAtlas.plannedRecords.map((record) => [record.id, wantToGo.plannedConvertBlockReason(record) ?? null]),
    },
    worldGraph: {},
  } satisfies Record<ModuleName, Record<string, unknown>>

  const modules: Record<string, unknown> = {}
  for (const moduleName of moduleNames) {
    modules[moduleName] = { ...pickData(moduleName, exports[moduleName]), ...evaluated[moduleName] }
  }

  const snapshot = worldGraph.worldGraphSnapshot
  const queries = {
    visiblePlaces: layerCombinations.map(({ name, visible }) => {
      const visibleLayerIds = visibleLayerIdsFor(visible)
      return { name, visibleLayerIds, result: queryVisiblePlaces(snapshot, visibleLayerIds) }
    }),
    collection: { [WANT_TO_GO_LAYER_ID]: queryCollection(snapshot, WANT_TO_GO_LAYER_ID) },
  }

  return toPlain({ format: BASELINE_FORMAT, modules, queries }, options.now)
}

/** 与 JSON.stringify 一致的缩进格式，但对象键按 UTF-16 码元排序（不受「整数键先行」规则影响）。 */
const serialize = (value: unknown, indent: string): string | undefined => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
    case 'bigint':
      throw new TypeError('stableStringify: 不支持 bigint')
  }

  if (value instanceof Map || value instanceof Set) {
    throw new TypeError('stableStringify: Map / Set 须先经 buildBaseline 转成数组')
  }

  const innerIndent = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => `${innerIndent}${serialize(item, innerIndent) ?? 'null'}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }

  const record = value as Record<string, unknown>
  const members = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const serialized = serialize(record[key], innerIndent)
      return serialized === undefined ? [] : [`${innerIndent}${JSON.stringify(key)}: ${serialized}`]
    })
  if (members.length === 0) return '{}'
  return `{\n${members.join(',\n')}\n${indent}}`
}

/** 对象键排序、数组保序、两空格缩进；对象里值为 undefined 的键省略，数组里的 undefined 写成 null（同 JSON）。 */
export function stableStringify(value: unknown): string {
  return serialize(value, '') ?? 'null'
}
