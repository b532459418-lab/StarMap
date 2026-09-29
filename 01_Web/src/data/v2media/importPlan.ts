/**
 * V2 媒体导入的纯函数（RFC-LOC-1 PR3b-3 规格 §2.1–§2.3、§2.5）：地点索引、投递箱文件夹的归属解析、
 * 内容寻址、目录条目的生成、封面与去重。
 *
 * `src/data/v2media/` 是 App 层，【不是】 StarMap Core。IO（扫描投递箱、算哈希、读图片尺寸、生成网页文件、写盘）
 * 在 scripts/v2-media-import.mjs；这里只有纯函数，所以能单独测试。旧模式的导入器（scripts/import-media.mjs 的旧分支）
 * 一行不改，也不 import 这里——下面有几个小函数照抄了它（`normalizeName` 等），PR5 删除旧导入器时只剩这一份。
 *
 * **内容寻址（§2.1）**：媒体 id = `media-<源文件 sha256 的前 16 位十六进制>`，生成文件放在 `media/user/<同一个哈希>/`
 * （`original.<扩展名>`、`thumb.webp`、`preview.webp`）。id 与路径只由文件内容决定，与地名、所在城市、媒体类型都无关：
 * 地点改名、照片换城市文件夹、在全景与航拍之间改类型，id 与路径都不变；导入器重复运行，结果也不变。
 * sidecar（`media.json`）里显式写的 `id` 仍然优先（同旧行为）。
 *
 * **归属（§2.2）**：导入器从地点注册表（`data/v2/places.local.json`）建索引，不读旧足迹文件。
 * - 国家文件夹：`place.json` 的 `placeId` → 旧 `country.json` 的 `countryId`（经 `legacyKeys`，RFC §3.3）→
 *   文件夹名（与国家的中文名、英文名或 ISO 代码按 `normalizeName` 规范化后相等）。
 * - 城市文件夹：`place.json`（必须是城市，且属于所在国家文件夹解析出的国家）→ 文件夹名（在该国家的城市里与中英文名比对）。
 * - 逐文件覆盖（sidecar 条目）：`placeId`（城市），或旧的 `countryId` + `cityId`（经 `legacyKeys`）；两种都有且不一致是错误。
 * 排在前面的一种存在就以它为准；候选恰好一个才算找到，0 个或多个都报错。不猜，不新建地点。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { EN, ZH, isoOf, namesOf } from '../canonical/reconstruct.ts'
import type { CanonicalMediaItem, CanonicalPlace, PlaceId } from '../canonical/types.ts'
import { MEDIA_SCHEMA_VERSION } from '../canonical/v2Schema.ts'
import { completeForWrite, integrityProblems, type V2FilesOrEmpty } from '../v2write/transaction.ts'

export type MediaKind = 'photo' | 'panorama360' | 'aerialPhoto' | 'video'

/** V2 媒体目录（`data/v2/user-media.local.json`）的一项：PR3a 的 V3 格式（按 `placeId` 引用城市，标题为 LocalizedText）。 */
export type V2MediaCatalogItem = CanonicalMediaItem

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------
// 与旧导入器相同的规则（照抄 scripts/import-media.mjs）
// ---------------------------------------------------------------------------

/** 文件夹名与地点名的比对规则（照抄旧导入器）：兼容 Unicode 组合形式与拉丁重音，忽略大小写、空白、`_` 与 `-`。 */
export const normalizeName = (value: unknown): string => String(value ?? '')
  .normalize('NFKD')
  .replace(/\p{Mark}+/gu, '')
  .trim()
  .toLocaleLowerCase('en-US')
  .replace(/[\s_-]+/g, '')

export const STILL_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif'])
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.webm'])
export const NEEDS_CONVERSION_EXTENSIONS: ReadonlySet<string> = new Set([
  '.heic', '.heif', '.tif', '.tiff', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.mov',
])
/** 投递箱里不当作媒体的控制文件（sidecar、备份、临时文件）。 */
export const IGNORED_CONTROL_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.bak', '.tmp'])

export const PHOTO_FOLDER_ALIASES: ReadonlySet<string> = new Set(['photos', 'photo', '普通照片', '照片'].map(normalizeName))
export const DRONE_FOLDER_ALIASES: ReadonlySet<string> = new Set(['drone', '无人机', '无人机影像'].map(normalizeName))

const DRONE_TYPE_ALIASES: ReadonlyMap<string, MediaKind> = new Map([
  ...['panorama360', 'panorama', '360', '全景', '全景照片'].map((name) => [normalizeName(name), 'panorama360'] as const),
  ...['aerial-photo', 'aerial_photo', 'aerial', '航拍', '航拍照片'].map((name) => [normalizeName(name), 'aerialPhoto'] as const),
  ...['video', 'videos', '航拍视频', '视频'].map((name) => [normalizeName(name), 'video'] as const),
])

/**
 * 无人机文件夹里一个文件的媒体类型（照抄旧导入器）：视频扩展名为 video；sidecar 的 `kind` / `type`；
 * 文件名含 360 / pano / panorama 为全景；都没有时按航拍照片处理，并提醒（`unlabelled`）。
 */
export const droneKindOf = (fileName: string, extension: string, metadata: Record<string, unknown>): { kind: MediaKind; unlabelled: boolean } => {
  if (VIDEO_EXTENSIONS.has(extension) || extension === '.mov') return { kind: 'video', unlabelled: false }
  const declared = DRONE_TYPE_ALIASES.get(normalizeName(metadata.kind ?? metadata.type))
  if (declared) return { kind: declared, unlabelled: false }
  if (/(?:^|[-_. ])(?:360|pano|panorama)(?:[-_. ]|$)/i.test(fileName)) return { kind: 'panorama360', unlabelled: false }
  return { kind: 'aerialPhoto', unlabelled: true }
}

/** sidecar 里这个文件的条目：先按相对城市文件夹的路径（`drone/a.jpg`），再按文件名（照抄旧导入器）。 */
export const metadataForFile = (sidecar: unknown, relativeKey: string, baseName: string): Record<string, unknown> => {
  if (!isObject(sidecar)) return {}
  const entry = sidecar[relativeKey] ?? sidecar[baseName]
  return isObject(entry) ? entry : {}
}

export interface Dimensions {
  width: number
  height: number
}

/** 按 EXIF 方向校正后的宽高（照抄旧导入器）。 */
export const orientedDimensions = (metadata: { width?: number; height?: number; orientation?: number }): Dimensions | undefined => {
  const orientation = metadata.orientation ?? 1
  const swapsAxes = orientation >= 5 && orientation <= 8
  const width = swapsAxes ? metadata.height : metadata.width
  const height = swapsAxes ? metadata.width : metadata.height
  return width && height ? { width, height } : undefined
}

export const dimensionsInside = (width: number, height: number, maxEdge: number): Dimensions => {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export const isLikelyEquirectangularPanorama = (dimensions: Dimensions | undefined): boolean => {
  if (!dimensions?.width || !dimensions?.height) return false
  const ratio = dimensions.width / dimensions.height
  return ratio >= 1.9 && ratio <= 2.1
}

export const hasValidPosition = (position: unknown): position is { lat: number; lng: number } => isObject(position)
  && typeof position.lat === 'number'
  && typeof position.lng === 'number'
  && position.lat >= -90
  && position.lat <= 90
  && position.lng >= -180
  && position.lng <= 180

/** 静态图片的两个网页版本（照抄旧导入器的尺寸与质量）。 */
export const STILL_DERIVATIVES = Object.freeze([
  Object.freeze({ name: 'thumb.webp', maxEdge: 640, quality: 76 }),
  Object.freeze({ name: 'preview.webp', maxEdge: 2400, quality: 84 }),
])

// ---------------------------------------------------------------------------
// 地点索引
// ---------------------------------------------------------------------------

export interface MediaPlaceIndex {
  placeById: ReadonlyMap<PlaceId, CanonicalPlace>
  /** 国家地点，按注册表顺序。 */
  countries: readonly CanonicalPlace[]
  /** 某个国家的城市地点，按注册表顺序。 */
  citiesOf: (countryId: PlaceId) => readonly CanonicalPlace[]
  /** 带命名空间的旧键（`country:iceland`、`city:iceland__reykjavik`）→ 地点；同一个键属于多个地点时为 null（有歧义）。 */
  byLegacyKey: ReadonlyMap<string, CanonicalPlace | null>
}

/** 地点注册表 → 导入用的索引（§2.2）：国家带名称、ISO 代码与 legacyKeys，城市带名称、legacyKeys 与 partOf。 */
export const createMediaPlaceIndex = (places: readonly CanonicalPlace[]): MediaPlaceIndex => {
  const placeById = new Map<PlaceId, CanonicalPlace>()
  const citiesByCountry = new Map<PlaceId, CanonicalPlace[]>()
  const byLegacyKey = new Map<string, CanonicalPlace | null>()
  const countries: CanonicalPlace[] = []
  for (const place of places) {
    placeById.set(place.id, place)
    if (place.subtype === 'country') countries.push(place)
    else if (place.partOf !== undefined) citiesByCountry.set(place.partOf, [...(citiesByCountry.get(place.partOf) ?? []), place])
    for (const key of place.legacyKeys ?? []) {
      const previous = byLegacyKey.get(key)
      byLegacyKey.set(key, previous === undefined || previous?.id === place.id ? place : null)
    }
  }
  return { placeById, countries, citiesOf: (countryId) => citiesByCountry.get(countryId) ?? [], byLegacyKey }
}

/** 显示名：英文名，没有则中文名（与上传时的收件箱文件夹名、旧导入器的 countryName / cityName 取法一致）。 */
export const placeDisplayName = (place: CanonicalPlace): string =>
  place.names[EN] || place.names[ZH] || Object.values(place.names).find(Boolean) || place.id

const countryAliases = (place: CanonicalPlace): unknown[] => [place.names[ZH], place.names[EN], isoOf(place)]
const cityAliases = (place: CanonicalPlace): unknown[] => [place.names[ZH], place.names[EN]]

const matchByName = (candidates: readonly CanonicalPlace[], aliasesOf: (place: CanonicalPlace) => unknown[], folderName: string): CanonicalPlace[] => {
  const key = normalizeName(folderName)
  if (!key) return []
  return candidates.filter((place) => aliasesOf(place).some((alias) => {
    const normalized = normalizeName(alias)
    return normalized !== '' && normalized === key
  }))
}

// ---------------------------------------------------------------------------
// 归属解析
// ---------------------------------------------------------------------------

export type PlaceLookup = { ok: true; place: CanonicalPlace } | { ok: false; error: string }

const found = (place: CanonicalPlace): PlaceLookup => ({ ok: true, place })
const failed = (error: string): PlaceLookup => ({ ok: false, error })

/** `place.json` 的内容 → 地点 id；格式不对（不是对象、没有非空的 placeId）时为 undefined。 */
export const placeIdOfConfig = (value: unknown): string | undefined =>
  isObject(value) && typeof value.placeId === 'string' && value.placeId.trim() ? value.placeId.trim() : undefined

/** `place.json` 的内容（上传时写入）。 */
export const placeConfigOf = (placeId: PlaceId): { placeId: PlaceId } => ({ placeId })

const SUBTYPE_LABELS = { country: '国家', city: '城市' } as const

const placeFromConfig = (
  index: MediaPlaceIndex,
  config: unknown,
  label: string,
  expected: 'country' | 'city',
  country?: CanonicalPlace,
): PlaceLookup => {
  const id = placeIdOfConfig(config)
  if (id === undefined) return failed(`${label} 格式无效：内容应为 { "placeId": "<地点 id>" }。`)
  const place = index.placeById.get(id)
  if (!place) return failed(`${label} 指定了不存在的地点：${id}`)
  if (place.subtype !== expected) return failed(`${label} 指定的地点不是${SUBTYPE_LABELS[expected]}：${id}`)
  if (country !== undefined && place.partOf !== country.id) return failed(`${label} 指定的城市不属于 ${placeDisplayName(country)}：${id}`)
  return found(place)
}

export interface CountryFolderInput {
  folderName: string
  /** 国家文件夹里 `place.json` 的内容；文件不存在时为 undefined。 */
  placeConfig?: unknown
  /** 旧 `country.json` 的内容；文件不存在时为 undefined。 */
  countryConfig?: unknown
}

/** 国家文件夹 → 国家地点（§2.2）：place.json → country.json 的 countryId（经 legacyKeys）→ 文件夹名。 */
export const resolveCountryFolder = (index: MediaPlaceIndex, input: CountryFolderInput): PlaceLookup => {
  const { folderName } = input
  if (input.placeConfig !== undefined) return placeFromConfig(index, input.placeConfig, `${folderName}/place.json`, 'country')

  const legacyId = isObject(input.countryConfig) && typeof input.countryConfig.countryId === 'string' ? input.countryConfig.countryId : undefined
  if (legacyId) {
    const place = index.byLegacyKey.get(`country:${legacyId}`)
    if (place === null) return failed(`${folderName}/country.json 的 countryId 对应了不止一个国家：${legacyId}。请改用 place.json 填写 placeId。`)
    if (place === undefined || place.subtype !== 'country') return failed(`${folderName}/country.json 指定了不存在的 countryId：${legacyId}`)
    return found(place)
  }

  const matches = matchByName(index.countries, countryAliases, folderName)
  if (matches.length > 1) return failed(`国家目录名称存在歧义：${folderName}。请在 place.json 中填写 placeId。`)
  if (matches.length === 0) return failed(`找不到国家：${folderName}。目录名需与 StarMap 中的国家中文名、英文名或国家代码一致，或在 place.json 中填写 placeId。`)
  return found(matches[0])
}

export interface CityFolderInput {
  /** 所在国家文件夹的名称（只用于错误信息里的路径）。 */
  countryFolderName: string
  folderName: string
  /** 城市文件夹里 `place.json` 的内容；文件不存在时为 undefined。 */
  placeConfig?: unknown
}

/** 城市文件夹 → 城市地点（§2.2）：place.json（必须是这个国家的城市）→ 文件夹名。 */
export const resolveCityFolder = (index: MediaPlaceIndex, country: CanonicalPlace, input: CityFolderInput): PlaceLookup => {
  const { folderName } = input
  if (input.placeConfig !== undefined) {
    return placeFromConfig(index, input.placeConfig, `${input.countryFolderName}/${folderName}/place.json`, 'city', country)
  }
  const matches = matchByName(index.citiesOf(country.id), cityAliases, folderName)
  const countryName = placeDisplayName(country)
  if (matches.length > 1) return failed(`${countryName} 内的城市目录名称存在歧义：${folderName}。请在 place.json 中填写 placeId。`)
  if (matches.length === 0) return failed(`在 ${countryName} 中找不到城市：${folderName}。请先在 StarMap 中添加这个城市。`)
  return found(matches[0])
}

const trimmedText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * 逐文件的归属覆盖（sidecar 条目，§2.2）：`placeId`（城市地点 id），或旧的 `countryId` + `cityId`（经 legacyKeys，
 * 两个字段必须成对）；两种都有且指向不同城市是错误。都没有时归属所在的城市文件夹（`fallback`）。
 */
export const resolveFileOverride = (
  index: MediaPlaceIndex,
  fallback: CanonicalPlace,
  metadata: Record<string, unknown>,
  relativePath: string,
): PlaceLookup => {
  const placeId = trimmedText(metadata.placeId)
  const countryId = trimmedText(metadata.countryId)
  const cityId = trimmedText(metadata.cityId)
  if (!placeId && !countryId && !cityId) return found(fallback)

  let byPlaceId: CanonicalPlace | undefined
  if (placeId) {
    const place = index.placeById.get(placeId)
    if (!place || place.subtype !== 'city') return failed(`${relativePath} 的 placeId 不是 StarMap 中的城市：${placeId}`)
    byPlaceId = place
  }

  let byLegacy: CanonicalPlace | undefined
  if (countryId || cityId) {
    if (!countryId || !cityId) return failed(`${relativePath} 的归属覆盖必须同时填写 countryId 和 cityId。`)
    const country = index.byLegacyKey.get(`country:${countryId}`)
    if (!country || country.subtype !== 'country') return failed(`${relativePath} 指定了不存在的 countryId：${countryId}`)
    const city = index.byLegacyKey.get(`city:${cityId}`)
    if (!city || city.subtype !== 'city' || city.partOf !== country.id) {
      return failed(`${relativePath} 指定了不属于 ${placeDisplayName(country)} 的 cityId：${cityId}`)
    }
    byLegacy = city
  }

  if (byPlaceId && byLegacy && byPlaceId.id !== byLegacy.id) {
    return failed(`${relativePath} 的 placeId 与 countryId / cityId 指向不同的城市，请只保留一种。`)
  }
  return found((byPlaceId ?? byLegacy) as CanonicalPlace)
}

// ---------------------------------------------------------------------------
// 内容寻址
// ---------------------------------------------------------------------------

/** 内容哈希：源文件 sha256（十六进制）的前 16 位。 */
export const CONTENT_HASH_LENGTH = 16
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{16}$/

/** 源文件 sha256 的十六进制 → 16 位内容哈希。 */
export const contentHashOf = (sha256Hex: string): string => {
  const hash = sha256Hex.slice(0, CONTENT_HASH_LENGTH).toLowerCase()
  if (!CONTENT_HASH_PATTERN.test(hash)) throw new TypeError('sha256 必须是十六进制字符串')
  return hash
}

const assertHash = (hash: string) => {
  if (!CONTENT_HASH_PATTERN.test(hash)) throw new TypeError(`内容哈希必须是 ${CONTENT_HASH_LENGTH} 位小写十六进制`)
}

/** 由内容决定的媒体 id：`media-<哈希>`。 */
export const mediaIdOf = (hash: string): string => {
  assertHash(hash)
  return `media-${hash}`
}

/** 页面引用生成文件的前缀（开发服务器从私人目录的 media/user/ 提供）。 */
export const MEDIA_PUBLIC_PREFIX = '/media/user/'

/** 生成文件相对 `media/user/` 的位置：目录就是内容哈希。 */
export const generatedFilesOf = (hash: string, extension: string) => {
  assertHash(hash)
  return {
    directory: hash,
    original: `${hash}/original${extension}`,
    derivatives: STILL_DERIVATIVES.map((derivative) => ({ ...derivative, file: `${hash}/${derivative.name}` })),
  }
}

export const publicSrcOf = (relativeFile: string): string => `${MEDIA_PUBLIC_PREFIX}${relativeFile}`

/**
 * 目录条目的 `src` → 内容寻址的生成目录（相对 `media/user/`，就是那个哈希）。
 * 不是 `/media/user/<16 位哈希>/<文件名>` 的形状时为 undefined——删除只认内容寻址的目录，别的一律不碰。
 */
export const generatedDirectoryOfSrc = (src: unknown): string | undefined => {
  if (typeof src !== 'string') return undefined
  const normalized = src.replaceAll('\\', '/')
  if (!normalized.startsWith(MEDIA_PUBLIC_PREFIX)) return undefined
  const match = /^([0-9a-f]{16})\/[^/]+$/.exec(normalized.slice(MEDIA_PUBLIC_PREFIX.length))
  if (!match) return undefined
  const fileName = normalized.slice(MEDIA_PUBLIC_PREFIX.length + CONTENT_HASH_LENGTH + 1)
  return fileName === '.' || fileName === '..' ? undefined : match[1]
}

// ---------------------------------------------------------------------------
// 目录条目
// ---------------------------------------------------------------------------

export interface MediaFileFacts {
  /** 16 位内容哈希（`contentHashOf`）。 */
  hash: string
  /** 小写、带点的扩展名，例如 `.jpg`。 */
  extension: string
  kind: MediaKind
  /** 归属的城市地点。 */
  placeId: PlaceId
  originalFileName: string
  /** 静态图片按 EXIF 方向校正后的宽高；视频没有。 */
  dimensions?: Dimensions
  /** sidecar 里这个文件的条目；普通照片为 {}。 */
  metadata?: Record<string, unknown>
}

export const isStillMedia = (kind: MediaKind, extension: string): boolean => kind !== 'video' && STILL_EXTENSIONS.has(extension)

export const isDroneKind = (kind: MediaKind): boolean => kind === 'panorama360' || kind === 'aerialPhoto' || kind === 'video'

/** 无人机影像要有日期与分辨率才进 Drone Media（照抄旧导入器）；普通照片总是 ready。 */
export const mediaStatusOf = (kind: MediaKind, metadata: Record<string, unknown>): 'ready' | 'needsMetadata' =>
  !isDroneKind(kind) || (typeof metadata.date === 'string' && typeof metadata.resolution === 'string') ? 'ready' : 'needsMetadata'

/**
 * 一个文件 → V2 媒体目录的一项（§2.3，PR3a 的 V3 格式）。字段与旧导入器相同，只有两处不同：
 * 归属写成 `placeId`（不再有 countryId / cityId / countryName / cityName）；标题来自 sidecar 的 `titleZh` / `titleEn`，
 * 写成 `title?: LocalizedText`（只写非空值，都没有就不写）。id 与 `src` 按内容寻址；`isCover` 由 `markCovers` 决定。
 */
export const buildMediaItem = (facts: MediaFileFacts): V2MediaCatalogItem => {
  const metadata = facts.metadata ?? {}
  const files = generatedFilesOf(facts.hash, facts.extension)
  const src = publicSrcOf(files.original)
  const still = isStillMedia(facts.kind, facts.extension)
  if (still && !facts.dimensions) throw new TypeError('静态图片需要宽高')
  const dimensions = still ? facts.dimensions : undefined

  const variants = dimensions
    ? {
        thumb: { src: publicSrcOf(files.derivatives[0].file), ...dimensionsInside(dimensions.width, dimensions.height, files.derivatives[0].maxEdge) },
        preview: { src: publicSrcOf(files.derivatives[1].file), ...dimensionsInside(dimensions.width, dimensions.height, files.derivatives[1].maxEdge) },
        original: { src, ...dimensions },
      }
    : { original: { src } }

  const explicitId = trimmedText(metadata.id)
  const names = namesOf(metadata.titleZh, metadata.titleEn)
  return {
    id: explicitId || mediaIdOf(facts.hash),
    kind: facts.kind,
    scope: 'city',
    placeId: facts.placeId,
    src,
    variants,
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    originalFileName: facts.originalFileName,
    ...(Object.keys(names).length > 0 ? { title: { names } } : {}),
    ...(typeof metadata.date === 'string' ? { date: metadata.date } : {}),
    ...(typeof metadata.resolution === 'string' ? { resolution: metadata.resolution } : {}),
    ...(typeof metadata.captureType === 'string' ? { captureType: metadata.captureType } : {}),
    ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}),
    ...(hasValidPosition(metadata.position) ? { position: JSON.parse(JSON.stringify(metadata.position)) } : {}),
    ...(typeof metadata.altitudeMeters === 'number' ? { altitudeMeters: metadata.altitudeMeters } : {}),
    ...(typeof metadata.relativeAltitudeMeters === 'number' ? { relativeAltitudeMeters: metadata.relativeAltitudeMeters } : {}),
    isCover: false,
    status: mediaStatusOf(facts.kind, metadata),
  } as V2MediaCatalogItem
}

const COVER_FILE_PATTERN = /^cover(?:[-_. ]|$)/i

/**
 * 封面（§2.3）：按 `placeId` 分组，每个城市的普通照片里，文件名以 cover 开头的优先，其余按文件名排序，取第一张。
 * 其余规则与旧导入器相同（旧导入器按 cityId 分组）。返回新数组，不改变条目顺序。
 */
export const markCovers = <T extends { kind: string; placeId: PlaceId; originalFileName: string; isCover: boolean }>(items: readonly T[]): T[] => {
  const groups = new Map<PlaceId, number[]>()
  items.forEach((item, position) => {
    if (item.kind !== 'photo') return
    groups.set(item.placeId, [...(groups.get(item.placeId) ?? []), position])
  })
  const covers = new Set<number>()
  for (const positions of groups.values()) {
    const sorted = [...positions].sort((left, right) => {
      const leftName = items[left].originalFileName
      const rightName = items[right].originalFileName
      const leftCover = COVER_FILE_PATTERN.test(leftName) ? 0 : 1
      const rightCover = COVER_FILE_PATTERN.test(rightName) ? 0 : 1
      return leftCover - rightCover || leftName.localeCompare(rightName, 'zh-CN')
    })
    covers.add(sorted[0])
  }
  return items.map((item, position) => ({ ...item, isCover: covers.has(position) }))
}

/**
 * 同一个 id 只留一条（旧导入器「内容完全相同的重复文件」的处理，沿用）：位置取第一次出现的，值取最后一次出现的。
 * 内容寻址之后，内容相同的文件不论放在哪个城市、哪个类型都是同一个 id。
 */
export const uniqueById = <T extends { id: string }>(items: readonly T[]): T[] => [...new Map(items.map((item) => [item.id, item])).values()]

/** 源文件索引：媒体 id → 投递箱里的相对路径（含重复文件，去重、保持先后）。 */
export const sourcesByIdOf = (entries: readonly { id: string; sourcePath: string }[]): Record<string, string[]> => {
  const result: Record<string, string[]> = {}
  for (const entry of entries) result[entry.id] = [...new Set([...(result[entry.id] ?? []), entry.sourcePath])]
  return result
}

// ---------------------------------------------------------------------------
// 两个文件
// ---------------------------------------------------------------------------

/** V2 源文件索引的文件名（`data/v2/` 下）。它不属于 V2 的五个文件，不进 `validateV2Files`（§2.3）。 */
export const V2_MEDIA_SOURCE_INDEX_FILE_NAME = 'media-source-index.local.json'

/** V2 媒体目录（`data/v2/user-media.local.json`）。 */
export const mediaCatalogFileOf = (items: readonly V2MediaCatalogItem[], generatedAt: string) => ({
  schemaVersion: MEDIA_SCHEMA_VERSION,
  generatedAt,
  privacyLevel: 'local-only',
  items,
})

/** V2 源文件索引（形状同旧模式的索引；id 空间不同，所以分开存）。 */
export const mediaSourceIndexFileOf = (sourcesById: Record<string, string[]>, generatedAt: string) => ({
  schemaVersion: 1,
  generatedAt,
  sourcesById,
})

/**
 * 写目录前的完整性检查（§2.3）：新目录放进五个 V2 文件之后，必须通过 PR3a 的 `validateV2Files` 且没有悬空引用——
 * 其中就包括「每个条目的 placeId 都是注册表里的城市」。返回问题的简述，空数组表示可以写。
 */
export const catalogIntegrityProblems = (files: V2FilesOrEmpty | undefined, catalog: unknown, now: Date): string[] =>
  integrityProblems(completeForWrite({ ...files, media: catalog }, now))
