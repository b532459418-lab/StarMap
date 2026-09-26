/**
 * V2 文件格式与校验（RFC-LOC-1 §3，PR3a 规格 §2.2；决定 D：以 Canonical 为准）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。V2 文件就是 Canonical（`./types.ts`）去掉
 * 运行时字段（`travel.source`、`wantToGo.source`、`wantToGo.problems`、`media.problems`）后的 JSON，
 * 共五个文件（括号里是私人数据目录 `data/v2/` 下的文件名）：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | 地点（`places.local.json`） | `{ schema_version: 1, generated_at, places }`。地点 id 为 UUIDv7；`legacyKeys` 带命名空间前缀 `country:` / `city:` |
 * | 足迹（`travel-map.local.json`） | `{ schema_version: 2, generated_at?, privacy_level?, intended_use?, safety_notes?, display, records }`。记录坐标与所属城市地点的 `location` 完全相同时省略这两个键 |
 * | 想去（`want-to-go.local.json`） | `{ schema_version: 2, generated_at?, privacy_level?, intended_use?, items }` |
 * | 编辑状态（`editor-state.local.json`） | `CanonicalEditorState`（`schemaVersion: 2`），`addedCountries` 条目只有 `placeId` / `region?` / `visitedDate?` |
 * | 媒体（`user-media.local.json`） | `{ schemaVersion: 3, items, …旧文件的其他顶层字段 }` |
 *
 * 足迹的 `generated_at` 可以缺：私人目录里只缺足迹文件时迁移把它当作 `{ schema_version: 1, records: [] }`，
 * 没有时间可写（PR3a 规格 §3）。
 *
 * 本模块只描述「一份合法的 V2 数据长什么样」：`validateV2Files` 逐文件检查结构，再做跨文件的引用检查
 * （地点 id 唯一且为 UUIDv7、`partOf` 指向国家、记录与媒体指向城市、想去与 editor-state 指向存在的地点、
 * `legacyKeys` 全文件唯一）。V2 Reader（`./v2Reader.ts`）假定输入已通过这里的校验。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type {
  CanonicalDisplay,
  CanonicalEditorState,
  CanonicalMediaItem,
  CanonicalPlace,
  CanonicalTravelRecord,
  CanonicalWantToGoItem,
  LegacyMediaPlaceField,
  LegacyPlaceField,
} from './types.ts'
import { isUuidV7 } from './uuidv7.ts'

export const PLACES_SCHEMA_VERSION = 1
export const TRAVEL_SCHEMA_VERSION = 2
export const WANT_TO_GO_SCHEMA_VERSION = 2
export const EDITOR_STATE_SCHEMA_VERSION = 2
export const MEDIA_SCHEMA_VERSION = 3

/** 五个 V2 文件在 `data/v2/` 下的文件名：与旧文件同名，另加地点注册表（PR3 总体方案决定 B）。 */
export const V2_FILE_NAMES = {
  places: 'places.local.json',
  travel: 'travel-map.local.json',
  wantToGo: 'want-to-go.local.json',
  editorState: 'editor-state.local.json',
  media: 'user-media.local.json',
} as const

export type V2FileKey = keyof typeof V2_FILE_NAMES

export const V2_FILE_KEYS = Object.keys(V2_FILE_NAMES) as V2FileKey[]

export interface V2PlacesFile {
  schema_version: 1
  generated_at: string
  places: CanonicalPlace[]
}

/** V2 足迹记录：坐标与所属城市地点的 `location` 完全相同时省略 `lat` / `lng`，读回时由城市坐标填回。 */
export type V2TravelRecord = Omit<CanonicalTravelRecord, 'lat' | 'lng'> & {
  lat?: number | null
  lng?: number | null
}

export interface V2TravelFile {
  schema_version: 2
  generated_at?: string
  privacy_level?: string
  intended_use?: string
  safety_notes?: string[]
  display: CanonicalDisplay
  records: V2TravelRecord[]
}

export interface V2WantToGoFile {
  schema_version: 2
  generated_at?: string
  privacy_level?: string
  intended_use?: string
  items: CanonicalWantToGoItem[]
}

export type V2EditorStateFile = CanonicalEditorState

/** 媒体文件：旧文件的其他顶层字段（如 `generatedAt`、`privacyLevel`）原样保留。 */
export type V2MediaFile = {
  schemaVersion: 3
  items: CanonicalMediaItem[]
} & Record<string, unknown>

export interface V2Files {
  places: V2PlacesFile
  travel: V2TravelFile
  wantToGo: V2WantToGoFile
  editorState: V2EditorStateFile
  media: V2MediaFile
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 一处校验问题。`code` 除 `DUPLICATE_LEGACY_KEY`（迁移报告单列为 `E_DUPLICATE_LEGACY_KEY`）外都是 `INVALID`。
 * `path` 是 JSON 路径；`message` 只描述问题，不含字段的值（私人数据的名称与坐标不进日志）。
 */
export interface V2SchemaProblem {
  code: 'INVALID' | 'DUPLICATE_LEGACY_KEY'
  file: V2FileKey
  path: string
  message: string
}

const ISO_PATTERN = /^[A-Z]{2}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const LEGACY_KEY_PATTERN = /^(country|city):.+$/
/** 与 `ImportedMediaKind`（../derive/mediaCatalog.ts）相同的四种；不 import Legacy Adapter，因为 PR5 会删除它而 V2 留下。 */
const MEDIA_KINDS: readonly string[] = ['photo', 'panorama360', 'aerialPhoto', 'video']

const PLACE_KEYS = new Set(['id', 'subtype', 'names', 'originalLanguage', 'externalIds', 'partOf', 'location', 'legacyKeys'])
const TRAVEL_KEYS = new Set(['schema_version', 'generated_at', 'privacy_level', 'intended_use', 'safety_notes', 'display', 'records'])
const DISPLAY_KEYS = new Set(['overviewTarget', 'homeHiddenCountryIds', 'originCountryIds', 'regionCountryIds', 'regionIncludes', 'navigationHiddenCityIds'])
const WANT_TO_GO_KEYS = new Set(['schema_version', 'generated_at', 'privacy_level', 'intended_use', 'items'])
const WANT_TO_GO_ITEM_KEYS = new Set(['id', 'placeId', 'note', 'addedAt', 'hidden', 'source'])
const EDITOR_KEYS = new Set([
  'schemaVersion', 'addedCountries', 'countryOrder', 'hiddenCountryIds', 'cityOrderByCountry', 'hiddenCityIds',
  'mediaOrderByCity', 'hiddenMediaIds', 'coverMediaByCity', 'droneOrderByCity', 'hiddenDroneMediaIds', 'updatedAt',
])
const ADDED_COUNTRY_KEYS = new Set(['placeId', 'region', 'visitedDate'])
const LEGACY_RECORD_FIELDS: readonly LegacyPlaceField[] = ['country', 'country_en', 'country_code', 'city', 'city_en']
const LEGACY_MEDIA_FIELDS: readonly LegacyMediaPlaceField[] = ['countryId', 'cityId', 'countryName', 'cityName', 'titleZh', 'titleEn']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

const keyPath = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`)

class ProblemList {
  readonly problems: V2SchemaProblem[] = []
  add(file: V2FileKey, path: string, message: string, code: V2SchemaProblem['code'] = 'INVALID') {
    this.problems.push({ code, file, path, message })
  }
  unknownKeys(file: V2FileKey, path: string, value: Record<string, unknown>, allowed: ReadonlySet<string>) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) this.add(file, `${path}${keyPath(key)}`, '不是这个位置允许的字段')
    }
  }
  optionalString(file: V2FileKey, path: string, value: Record<string, unknown>, key: string) {
    if (value[key] !== undefined && typeof value[key] !== 'string') this.add(file, `${path}${keyPath(key)}`, '必须是字符串')
  }
}

/** 地点注册表的索引：跨文件检查用。 */
interface PlaceIndex {
  subtypeOf: Map<string, 'country' | 'city'>
}

const validateNames = (list: ProblemList, file: V2FileKey, path: string, names: unknown) => {
  if (!isObject(names) || Object.keys(names).length === 0) {
    list.add(file, path, '必须是至少有一项的对象（语言标签 → 名称）')
    return
  }
  for (const [tag, name] of Object.entries(names)) {
    if (tag === '' || !isNonEmptyString(name)) list.add(file, `${path}${keyPath(tag)}`, '语言标签与名称都必须是非空字符串')
  }
}

const validateLocation = (list: ProblemList, file: V2FileKey, path: string, location: unknown) => {
  if (!isObject(location)) {
    list.add(file, path, '必须是 { lat, lng, approximate? } 对象')
    return
  }
  list.unknownKeys(file, path, location, new Set(['lat', 'lng', 'approximate']))
  if (!isFiniteNumber(location.lat) || location.lat < -90 || location.lat > 90) list.add(file, `${path}.lat`, '必须是 -90 到 90 之间的数字')
  if (!isFiniteNumber(location.lng) || location.lng < -180 || location.lng > 180) list.add(file, `${path}.lng`, '必须是 -180 到 180 之间的数字')
  if (location.approximate !== undefined && location.approximate !== true) list.add(file, `${path}.approximate`, '只能是 true 或省略')
}

const validatePlaces = (list: ProblemList, value: unknown): PlaceIndex => {
  const index: PlaceIndex = { subtypeOf: new Map() }
  const file: V2FileKey = 'places'
  if (!isObject(value)) {
    list.add(file, '$', '必须是对象')
    return index
  }
  list.unknownKeys(file, '$', value, new Set(['schema_version', 'generated_at', 'places']))
  if (value.schema_version !== PLACES_SCHEMA_VERSION) list.add(file, '$.schema_version', `必须是 ${PLACES_SCHEMA_VERSION}`)
  if (!isNonEmptyString(value.generated_at)) list.add(file, '$.generated_at', '必须是非空字符串')
  if (!Array.isArray(value.places)) {
    list.add(file, '$.places', '必须是数组')
    return index
  }

  // 第一遍：id 与 subtype，建索引；第二遍才检查 partOf（可以引用后面的地点）。
  value.places.forEach((place, position) => {
    const path = `$.places[${position}]`
    if (!isObject(place)) return
    if (!isUuidV7(place.id)) {
      list.add(file, `${path}.id`, '必须是小写的 UUIDv7')
      return
    }
    if (index.subtypeOf.has(place.id)) {
      list.add(file, `${path}.id`, '与前面的地点重复')
      return
    }
    if (place.subtype === 'country' || place.subtype === 'city') index.subtypeOf.set(place.id, place.subtype)
  })

  const legacyKeyOwner = new Map<string, number>()
  value.places.forEach((place, position) => {
    const path = `$.places[${position}]`
    if (!isObject(place)) {
      list.add(file, path, '必须是对象')
      return
    }
    list.unknownKeys(file, path, place, PLACE_KEYS)
    if (place.subtype !== 'country' && place.subtype !== 'city') list.add(file, `${path}.subtype`, '只能是 country 或 city')
    validateNames(list, file, `${path}.names`, place.names)
    list.optionalString(file, path, place, 'originalLanguage')

    if (place.externalIds !== undefined) {
      if (!isObject(place.externalIds) || !Object.values(place.externalIds).every(isNonEmptyString)) {
        list.add(file, `${path}.externalIds`, '必须是值为非空字符串的对象')
      }
    }
    const iso = isObject(place.externalIds) ? place.externalIds.iso3166Alpha2 : undefined
    if (iso !== undefined && !(typeof iso === 'string' && ISO_PATTERN.test(iso))) {
      list.add(file, `${path}.externalIds.iso3166Alpha2`, '必须是两个大写英文字母')
    }
    if (place.subtype === 'country' && iso === undefined) {
      list.add(file, `${path}.externalIds.iso3166Alpha2`, '国家必须有 ISO 3166-1 alpha-2 代码（RFC ID-5）')
    }

    if (place.subtype === 'city') {
      if (!isNonEmptyString(place.partOf)) list.add(file, `${path}.partOf`, '城市必须有 partOf（所属国家）')
      else if (index.subtypeOf.get(place.partOf) !== 'country') list.add(file, `${path}.partOf`, '必须指向一个国家地点')
    } else if (place.partOf !== undefined) {
      list.add(file, `${path}.partOf`, '国家不能有 partOf')
    }

    if (place.location !== undefined) validateLocation(list, file, `${path}.location`, place.location)

    if (place.legacyKeys !== undefined) {
      if (!isStringArray(place.legacyKeys) || place.legacyKeys.length === 0) {
        list.add(file, `${path}.legacyKeys`, '必须是非空的字符串数组')
      } else {
        place.legacyKeys.forEach((key, keyIndex) => {
          const keyPathText = `${path}.legacyKeys[${keyIndex}]`
          if (!LEGACY_KEY_PATTERN.test(key)) {
            list.add(file, keyPathText, '必须是 country:<旧键> 或 city:<旧键>')
            return
          }
          if (!key.startsWith(`${place.subtype}:`)) list.add(file, keyPathText, '命名空间必须与地点的 subtype 相同')
          const owner = legacyKeyOwner.get(key)
          if (owner !== undefined && owner !== position) {
            list.add(file, keyPathText, `与 $.places[${owner}] 的 legacy key 重复（RFC ID-2：全文件唯一）`, 'DUPLICATE_LEGACY_KEY')
          } else {
            legacyKeyOwner.set(key, position)
          }
        })
      }
    }
  })
  return index
}

/** 引用检查：`expected` 为 undefined 时只要求地点存在。 */
const checkRef = (
  list: ProblemList,
  file: V2FileKey,
  path: string,
  id: unknown,
  places: PlaceIndex,
  expected?: 'country' | 'city',
) => {
  if (typeof id !== 'string') {
    list.add(file, path, '必须是地点 id 字符串')
    return
  }
  const subtype = places.subtypeOf.get(id)
  if (subtype === undefined) list.add(file, path, '引用的地点不存在')
  else if (expected !== undefined && subtype !== expected) list.add(file, path, `必须指向一个${expected === 'country' ? '国家' : '城市'}地点`)
}

const checkRefArray = (
  list: ProblemList,
  file: V2FileKey,
  path: string,
  value: unknown,
  places: PlaceIndex,
  expected?: 'country' | 'city',
) => {
  if (!Array.isArray(value)) {
    list.add(file, path, '必须是数组')
    return
  }
  value.forEach((id, position) => checkRef(list, file, `${path}[${position}]`, id, places, expected))
}

const validateDisplay = (list: ProblemList, path: string, display: unknown, places: PlaceIndex) => {
  const file: V2FileKey = 'travel'
  if (!isObject(display)) {
    list.add(file, path, '必须是对象')
    return
  }
  list.unknownKeys(file, path, display, DISPLAY_KEYS)
  if (display.overviewTarget !== undefined) {
    const target = display.overviewTarget
    if (!isObject(target) || !isFiniteNumber(target.lat) || !isFiniteNumber(target.lng)) {
      list.add(file, `${path}.overviewTarget`, '必须是 { lat, lng } 数字对象')
    }
  }
  checkRefArray(list, file, `${path}.homeHiddenCountryIds`, display.homeHiddenCountryIds, places, 'country')
  checkRefArray(list, file, `${path}.originCountryIds`, display.originCountryIds, places, 'country')
  checkRefArray(list, file, `${path}.regionCountryIds`, display.regionCountryIds, places, 'country')
  if (!isStringArray(display.regionIncludes)) list.add(file, `${path}.regionIncludes`, '必须是字符串数组')
  checkRefArray(list, file, `${path}.navigationHiddenCityIds`, display.navigationHiddenCityIds, places, 'city')
}

const validateTravel = (list: ProblemList, value: unknown, places: PlaceIndex) => {
  const file: V2FileKey = 'travel'
  if (!isObject(value)) {
    list.add(file, '$', '必须是对象')
    return
  }
  list.unknownKeys(file, '$', value, TRAVEL_KEYS)
  if (value.schema_version !== TRAVEL_SCHEMA_VERSION) list.add(file, '$.schema_version', `必须是 ${TRAVEL_SCHEMA_VERSION}`)
  for (const key of ['generated_at', 'privacy_level', 'intended_use']) list.optionalString(file, '$', value, key)
  if (value.safety_notes !== undefined && !isStringArray(value.safety_notes)) list.add(file, '$.safety_notes', '必须是字符串数组')
  validateDisplay(list, '$.display', value.display, places)
  if (!Array.isArray(value.records)) {
    list.add(file, '$.records', '必须是数组')
    return
  }
  value.records.forEach((record, position) => {
    const path = `$.records[${position}]`
    if (!isObject(record)) {
      list.add(file, path, '必须是对象')
      return
    }
    if (!isNonEmptyString(record.id)) list.add(file, `${path}.id`, '必须是非空字符串')
    checkRef(list, file, `${path}.placeId`, record.placeId, places, 'city')
    for (const key of ['lat', 'lng']) {
      if (record[key] !== undefined && record[key] !== null && !isFiniteNumber(record[key])) {
        list.add(file, `${path}.${key}`, '必须是数字、null 或省略')
      }
    }
    for (const key of LEGACY_RECORD_FIELDS) {
      if (Object.hasOwn(record, key)) list.add(file, `${path}.${key}`, '名称与国家代码属于地点，记录上不再保存')
    }
  })
}

const validateWantToGo = (list: ProblemList, value: unknown, places: PlaceIndex) => {
  const file: V2FileKey = 'wantToGo'
  if (!isObject(value)) {
    list.add(file, '$', '必须是对象')
    return
  }
  list.unknownKeys(file, '$', value, WANT_TO_GO_KEYS)
  if (value.schema_version !== WANT_TO_GO_SCHEMA_VERSION) list.add(file, '$.schema_version', `必须是 ${WANT_TO_GO_SCHEMA_VERSION}`)
  for (const key of ['generated_at', 'privacy_level', 'intended_use']) list.optionalString(file, '$', value, key)
  if (!Array.isArray(value.items)) {
    list.add(file, '$.items', '必须是数组')
    return
  }
  value.items.forEach((item, position) => {
    const path = `$.items[${position}]`
    if (!isObject(item)) {
      list.add(file, path, '必须是对象')
      return
    }
    list.unknownKeys(file, path, item, WANT_TO_GO_ITEM_KEYS)
    if (!isNonEmptyString(item.id)) list.add(file, `${path}.id`, '必须是非空字符串')
    checkRef(list, file, `${path}.placeId`, item.placeId, places)
    if (!(typeof item.addedAt === 'string' && DATE_PATTERN.test(item.addedAt))) list.add(file, `${path}.addedAt`, '必须是 YYYY-MM-DD')
    if (typeof item.hidden !== 'boolean') list.add(file, `${path}.hidden`, '必须是布尔值')
    list.optionalString(file, path, item, 'note')
    list.optionalString(file, path, item, 'source')
  })
}

const validateRefKeyedRecord = (
  list: ProblemList,
  path: string,
  value: unknown,
  places: PlaceIndex,
  isValue: (item: unknown) => boolean,
  valueDescription: string,
) => {
  const file: V2FileKey = 'editorState'
  if (!isObject(value)) {
    list.add(file, path, '必须是对象')
    return
  }
  for (const [key, item] of Object.entries(value)) {
    checkRef(list, file, `${path}${keyPath(key)}(键)`, key, places)
    if (!isValue(item)) list.add(file, `${path}${keyPath(key)}`, `必须是${valueDescription}`)
  }
}

const validateEditorState = (list: ProblemList, value: unknown, places: PlaceIndex) => {
  const file: V2FileKey = 'editorState'
  if (!isObject(value)) {
    list.add(file, '$', '必须是对象')
    return
  }
  list.unknownKeys(file, '$', value, EDITOR_KEYS)
  if (value.schemaVersion !== EDITOR_STATE_SCHEMA_VERSION) list.add(file, '$.schemaVersion', `必须是 ${EDITOR_STATE_SCHEMA_VERSION}`)
  if (!Array.isArray(value.addedCountries)) {
    list.add(file, '$.addedCountries', '必须是数组')
  } else {
    value.addedCountries.forEach((entry, position) => {
      const path = `$.addedCountries[${position}]`
      if (!isObject(entry)) {
        list.add(file, path, '必须是对象')
        return
      }
      list.unknownKeys(file, path, entry, ADDED_COUNTRY_KEYS)
      checkRef(list, file, `${path}.placeId`, entry.placeId, places, 'country')
      list.optionalString(file, path, entry, 'region')
      list.optionalString(file, path, entry, 'visitedDate')
    })
  }
  checkRefArray(list, file, '$.countryOrder', value.countryOrder, places)
  checkRefArray(list, file, '$.hiddenCountryIds', value.hiddenCountryIds, places)
  validateRefKeyedRecord(list, '$.cityOrderByCountry', value.cityOrderByCountry, places, () => true, '')
  if (isObject(value.cityOrderByCountry)) {
    for (const [key, cityIds] of Object.entries(value.cityOrderByCountry)) {
      checkRefArray(list, file, `$.cityOrderByCountry${keyPath(key)}`, cityIds, places)
    }
  }
  checkRefArray(list, file, '$.hiddenCityIds', value.hiddenCityIds, places)
  validateRefKeyedRecord(list, '$.mediaOrderByCity', value.mediaOrderByCity, places, isStringArray, '字符串数组（媒体 id）')
  if (!isStringArray(value.hiddenMediaIds)) list.add(file, '$.hiddenMediaIds', '必须是字符串数组')
  validateRefKeyedRecord(list, '$.coverMediaByCity', value.coverMediaByCity, places, (item) => typeof item === 'string', '字符串（媒体 id）')
  validateRefKeyedRecord(list, '$.droneOrderByCity', value.droneOrderByCity, places, isStringArray, '字符串数组（媒体 id）')
  if (!isStringArray(value.hiddenDroneMediaIds)) list.add(file, '$.hiddenDroneMediaIds', '必须是字符串数组')
  list.optionalString(file, '$', value, 'updatedAt')
}

const validateMedia = (list: ProblemList, value: unknown, places: PlaceIndex) => {
  const file: V2FileKey = 'media'
  if (!isObject(value)) {
    list.add(file, '$', '必须是对象')
    return
  }
  if (value.schemaVersion !== MEDIA_SCHEMA_VERSION) list.add(file, '$.schemaVersion', `必须是 ${MEDIA_SCHEMA_VERSION}`)
  if (!Array.isArray(value.items)) {
    list.add(file, '$.items', '必须是数组')
    return
  }
  value.items.forEach((item, position) => {
    const path = `$.items[${position}]`
    if (!isObject(item)) {
      list.add(file, path, '必须是对象')
      return
    }
    if (!isNonEmptyString(item.id)) list.add(file, `${path}.id`, '必须是非空字符串')
    if (typeof item.kind !== 'string' || !MEDIA_KINDS.includes(item.kind)) {
      list.add(file, `${path}.kind`, '必须是 photo / panorama360 / aerialPhoto / video 之一')
    }
    checkRef(list, file, `${path}.placeId`, item.placeId, places, 'city')
    if (item.title !== undefined) {
      if (!isObject(item.title)) list.add(file, `${path}.title`, '必须是 { names, originalLanguage? } 对象')
      else {
        list.unknownKeys(file, `${path}.title`, item.title, new Set(['names', 'originalLanguage']))
        validateNames(list, file, `${path}.title.names`, item.title.names)
        list.optionalString(file, `${path}.title`, item.title, 'originalLanguage')
      }
    }
    for (const key of LEGACY_MEDIA_FIELDS) {
      if (Object.hasOwn(item, key)) list.add(file, `${path}.${key}`, '地点与标题改由 placeId / title 表达，旧字段不再保存')
    }
  })
}

/** 校验五个 V2 文件（JSON 值）。返回全部问题；空数组表示合法。 */
export function validateV2Files(files: Record<V2FileKey, unknown>): V2SchemaProblem[] {
  const list = new ProblemList()
  const places = validatePlaces(list, files.places)
  validateTravel(list, files.travel, places)
  validateWantToGo(list, files.wantToGo, places)
  validateEditorState(list, files.editorState, places)
  validateMedia(list, files.media, places)
  return list.problems
}
