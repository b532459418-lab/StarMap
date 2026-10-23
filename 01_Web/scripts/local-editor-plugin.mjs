import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { EnvHttpProxyAgent, fetch as proxyAwareFetch } from 'undici'
import worldCountries from 'world-countries'
import { atomicJsonWrite, exists, readJson } from './json-file.mjs'
import { isLegacyUnmigrated, legacyDataStateOf, legacyWriteRefusal } from './legacy-data.mjs'
import {
  PRIVATE_DATA_WATCH_EVENTS,
  privateDataModuleExports,
  renderPrivateDataModule,
  isStoreFileChange,
  shouldHandlePrivateDataChange,
} from './private-data-module.mjs'
import { getPrivatePaths, V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
import { privateDataState } from './private-data-source.mjs'
import { createV2WriteContext, readV2EditorState, v2EditorRoute, v2ErrorBody } from './v2-editor-store.mjs'
import { v2MediaRoute } from './v2-media-store.mjs'
import { V2WriteError } from '../src/data/editor/errors.ts'
import { filterReadModelForPersonalBuild } from '../src/data/store/personalBuildReadModel.ts'
import { normalizeLocalEditorError, readJsonBody } from './local-editor-errors.mjs'
import { allowedOrigins, authorizeRead, crossSiteRequestGuard, isLoopbackRequest } from './local-editor-request-guard.mjs'
import { safeSegment, reserveDestination, writeUpload } from './local-editor-upload.mjs'
import { firstUnsafeComponent, isPathInside } from './path-containment.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { mediaJobRoute, handleMediaJobRead, handleMediaJobPreview, handleMediaJobWrite } from './media-job-service.mjs'

/**
 * 3C-5 D: a media answer that committed once gets that commit's changed rows (`delta`), as the editor writes do; an
 * answer of several commits, or none, gets nothing (the page fetches the changes by revision).
 */
function withDelta(body, session, from) {
  if (body?.ok !== true || from === undefined || body.delta !== undefined) return body
  const delta = session.deltaSince(from)
  return delta ? { ...body, delta } : body
}

// 3C-4d：新库是私人数据唯一的写入方式。私人根的状态由 ./private-data-source.mjs 的 privateDataState 每次读写现判：
// - store：App 读新库的读模型（3C-5B；./store-session.mjs，按需加载，公开模式不加载 node:sqlite），经只读端点
//   GET /__travelatlas/editor/read-model 取得，虚拟模块只给出它的地址；8 个编辑端点（3C-4a，V2
//   写入规则作为规则引擎）、3 个媒体端点与媒体任务（3C-4c，./store-media-endpoints.mjs、./media-service.mjs）都写新库。
// - migration-required：有 V2 数据（或没迁移的旧格式数据）、还没有新库。只读显示 data/v2/ 的文件（3C-5B 起在内存里迁移成读模型
//   再给 App），页面提示运行迁移；
//   全部写入端点、媒体端点与媒体任务（含任务列表）返回 409 E_STORE_MIGRATION_REQUIRED（旧格式：E_LEGACY_UNMIGRATED）。
// - needs-recovery：data/store/ 下有残留、没有新库。同样只读，409 E_STORE_RECOVERY_REQUIRED，提示 npm run library:recover。
// - empty：开发服务器（个人、可写）启动时在库租约下建一个空的新库（./store-init.mjs），之后按 store 处理；构建不建库。
const virtualPrivateDataId = 'virtual:starmap-private-data'
// 3C-5B (review of B): the read-only endpoint the dev server serves the read model from; the virtual module names it with
// the revision (or, for a root that is not a library yet, the V2 files' digest), so a reload after a save asks for a new
// address. It is an editor endpoint: the cross-site guard and the read authorization (#70) come first.
export const READ_MODEL_PATH = '/__travelatlas/editor/read-model'
/** 3C-5 D: the changes of the library's read model since a revision (`?since=R&libraryId=…&restoreMark=…`). */
export const READ_MODEL_CHANGES_PATH = '/__travelatlas/editor/read-model/changes'
/** 3C-5 D: the event the plugin pushes to the pages after every new revision of the library. */
export const REVISION_EVENT = 'starmap:revision'
/** 3C-5 D: how often the plugin looks for commits of other processes while a page is connected. */
export const EXTERNAL_CHECK_MS = 2000
const resolvedPrivateDataId = `\0${virtualPrivateDataId}`
let privatePaths
let privateRoot
let dataRoot
let inboxRoot
let userMediaRoot
let cesiumAccessToken = ''

const configurePrivatePaths = (requestedRoot) => {
  const environment = requestedRoot
    ? { ...process.env, STARMAP_PRIVATE_ROOT: requestedRoot }
    : process.env
  const paths = getPrivatePaths(environment)
  privatePaths = paths
  privateRoot = paths.root
  dataRoot = paths.dataRoot
  inboxRoot = paths.inboxRoot
  userMediaRoot = paths.userMediaRoot
}


configurePrivatePaths()
const editorHeader = 'x-travelatlas-local-editor'
const citySearchDispatcher = new EnvHttpProxyAgent()
const userMediaContentTypes = new Map([
  ['.avif', 'image/avif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

const sendJson = (response, status, body) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

const slugify = (value) => value
  .toLowerCase()
  .normalize('NFKC')
  .trim()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-|-$/g, '')

const countryCatalog = worldCountries
  .filter((country) => country.cca2 && Array.isArray(country.latlng) && country.latlng.length === 2)
  .map((country) => ({
    id: slugify(country.name.common),
    nameZh: country.translations?.zho?.common
      ?? country.name.native?.zho?.common
      ?? country.name.common,
    nameEn: country.name.common,
    countryCode: country.cca2.toUpperCase(),
    countryCode3: country.cca3?.toUpperCase() ?? '',
    centerLat: Number(country.latlng[0]),
    centerLng: Number(country.latlng[1]),
    region: country.region || undefined,
    searchTerms: [
      country.name.common,
      country.name.official,
      country.translations?.zho?.common,
      country.translations?.zho?.official,
      country.cca2,
      country.cca3,
      ...(country.altSpellings ?? []),
    ].filter(Boolean).map((item) => String(item).toLocaleLowerCase()),
  }))

const countryCatalogByCode = new Map(countryCatalog.map((country) => [country.countryCode, country]))

const countryMatchScore = (country, rawQuery) => {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return 3
  if (
    country.countryCode.toLocaleLowerCase() === query
    || country.countryCode3.toLocaleLowerCase() === query
    || country.nameZh.toLocaleLowerCase() === query
    || country.nameEn.toLocaleLowerCase() === query
  ) return 0
  if (country.searchTerms.some((term) => term.startsWith(query))) return 1
  if (country.searchTerms.some((term) => term.includes(query))) return 2
  return Number.POSITIVE_INFINITY
}

const searchCountryCatalog = (query) => countryCatalog
  .map((country) => ({ country, score: countryMatchScore(country, query) }))
  .filter(({ score }) => Number.isFinite(score))
  .sort((left, right) => left.score - right.score || left.country.nameZh.localeCompare(right.country.nameZh, 'zh-CN'))
  .slice(0, 10)
  .map(({ country }) => ({
    id: country.id,
    nameZh: country.nameZh,
    nameEn: country.nameEn,
    countryCode: country.countryCode,
    centerLat: country.centerLat,
    centerLng: country.centerLng,
    region: country.region,
  }))

const citySearchCache = new Map()
let citySearchQueue = Promise.resolve()
let lastCitySearchAt = 0
const citySearchTimeoutMs = 9_000

const fetchCityJson = async (url, label, headers = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), citySearchTimeoutMs)
  try {
    const response = await proxyAwareFetch(url, {
      dispatcher: citySearchDispatcher,
      headers,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${label} returned ${response.status}`)
    return await response.json()
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} 请求超过 9 秒，已自动停止。`, { cause: error })
    if (error instanceof Error && error.message.startsWith(`${label} returned `)) throw error
    throw new Error(`${label} 暂时不可用。`, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

const queueCitySearch = (search) => {
  const queued = citySearchQueue.then(async () => {
    const delay = Math.max(0, 1_050 - (Date.now() - lastCitySearchAt))
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    lastCitySearchAt = Date.now()
    return search()
  })
  citySearchQueue = queued.catch(() => undefined)
  return queued
}

const normalizeCityReferer = (value) => {
  try {
    const parsed = new URL(value || 'http://127.0.0.1:5173/')
    if (
      parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) return `${parsed.origin}/`
  } catch {
    // Fall through to the fixed Codex preview origin.
  }
  return 'http://127.0.0.1:5173/'
}

const searchCesiumCityCatalog = async (query, country, requestReferer) => {
  if (!cesiumAccessToken) return []
  const url = new URL('https://api.cesium.com/v1/geocode/search')
  url.search = new URLSearchParams({
    text: `${query}, ${country.nameEn}`,
    access_token: cesiumAccessToken,
    size: '8',
    'boundary.country': country.countryCode3 || country.countryCode,
  }).toString()
  const referer = normalizeCityReferer(requestReferer)
  const body = await fetchCityJson(url, 'Cesium ion geocode', {
    origin: new URL(referer).origin,
    referer,
  })
  const seen = new Set()
  return (Array.isArray(body?.features) ? body.features : []).flatMap((feature) => {
    const coordinates = feature?.geometry?.coordinates
    const bbox = feature?.bbox
    const properties = feature?.properties ?? {}
    const lng = Number(coordinates?.[0] ?? (
      Array.isArray(bbox) && bbox.length === 4 ? (Number(bbox[0]) + Number(bbox[2])) / 2 : Number.NaN
    ))
    const lat = Number(coordinates?.[1] ?? (
      Array.isArray(bbox) && bbox.length === 4 ? (Number(bbox[1]) + Number(bbox[3])) / 2 : Number.NaN
    ))
    const resultCountryCode = String(properties.country_a ?? '').toUpperCase()
    if (
      !Number.isFinite(lat)
      || !Number.isFinite(lng)
      || (resultCountryCode && ![country.countryCode, country.countryCode3].includes(resultCountryCode))
    ) return []
    const label = String(properties.label ?? properties.name ?? '').trim()
    const nameEn = String(properties.name ?? label.split(',')[0] ?? '').trim()
    if (!nameEn) return []
    const id = String(properties.gid ?? `cesium-${lat}-${lng}`)
    if (seen.has(id)) return []
    seen.add(id)
    return [{
      id,
      nameZh: /\p{Script=Han}/u.test(query) ? query : nameEn,
      nameEn,
      countryCode: country.countryCode,
      lat,
      lng,
      detail: `${label || country.nameEn} · Cesium ion`,
      provider: 'cesium',
    }]
  })
}

const searchOpenStreetMapCityCatalog = async (query, country) => queueCitySearch(async () => {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.search = new URLSearchParams({
      q: query,
      countrycodes: country.countryCode.toLowerCase(),
      featureType: 'settlement',
      layer: 'address',
      format: 'jsonv2',
      addressdetails: '1',
      namedetails: '1',
      limit: '8',
      'accept-language': 'zh-CN,en',
    }).toString()
    const body = await fetchCityJson(url, 'OpenStreetMap 城市检索', {
      'user-agent': 'StarMap-LocalEditor/1.0 (local-first travel atlas editor)',
      referer: 'http://127.0.0.1/',
    })
    const seen = new Set()
    const normalizedQueryName = query.normalize('NFKC').toLocaleLowerCase()
    return (Array.isArray(body) ? body : []).flatMap((place) => {
      const lat = Number(place.lat)
      const lng = Number(place.lon)
      const address = place.address ?? {}
      const names = place.namedetails ?? {}
      const nameEn = names['name:en'] || names.name || String(place.display_name ?? '').split(',')[0]
      const nameZh = names['name:zh'] || names['name:zh-Hans'] || names['name:zh_CN'] || nameEn
      const id = `${place.osm_type ?? 'place'}-${place.osm_id ?? place.place_id}`
      if (!nameEn || !Number.isFinite(lat) || !Number.isFinite(lng) || seen.has(id)) return []
      const normalizedZhName = String(nameZh).normalize('NFKC').toLocaleLowerCase()
      const normalizedEnName = String(nameEn).normalize('NFKC').toLocaleLowerCase()
      const queryHan = normalizedQueryName.match(/\p{Script=Han}/gu)?.join('') ?? ''
      const resultHan = normalizedZhName.match(/\p{Script=Han}/gu)?.join('') ?? ''
      const isPlausibleLocalizedMatch = queryHan.length > 0 && queryHan.length === resultHan.length
      // Nominatim can treat a short Chinese query as a substring of an unrelated
      // Chinese label. Reject that misleading candidate, while allowing equal-length
      // simplified/traditional variants such as 波尔图 / 波爾圖.
      if (
        /\p{Script=Han}/u.test(query)
        && normalizedZhName !== normalizedQueryName
        && normalizedEnName !== normalizedQueryName
        && !isPlausibleLocalizedMatch
      ) return []
      seen.add(id)
      return [{
        id,
        nameZh,
        nameEn,
        countryCode: country.countryCode,
        lat,
        lng,
        detail: [...[address.state, address.region, address.country].filter(Boolean), 'OpenStreetMap'].join(' · '),
        provider: 'openstreetmap',
      }]
    })
  })

const searchCityCatalog = async (query, countryCode, requestReferer) => {
  const normalizedQuery = requireText(query, 'search_query')
  const normalizedCountryCode = requireText(countryCode, 'country_code').toUpperCase()
  if (!/^[A-Z]{2}$/.test(normalizedCountryCode)) throw new V2WriteError('E_NUMBER_INVALID', { field: 'country_code' })
  const country = countryCatalogByCode.get(normalizedCountryCode)
  if (!country) throw new V2WriteError('E_SEARCH_COUNTRY_NOT_FOUND')
  const cacheKey = `${cesiumAccessToken ? 'ion' : 'osm'}:${normalizedCountryCode}:${normalizedQuery.toLocaleLowerCase()}`
  const cached = citySearchCache.get(cacheKey)
  if (cached) return cached

  let cesiumError
  if (cesiumAccessToken) {
    try {
      const cesiumResults = await searchCesiumCityCatalog(normalizedQuery, country, requestReferer)
      if (cesiumResults.length > 0) {
        citySearchCache.set(cacheKey, cesiumResults)
        return cesiumResults
      }
    } catch (error) {
      cesiumError = error
      console.warn(`[StarMap editor] Cesium ion geocode unavailable; using OpenStreetMap (${error.message})`)
    }
  }

  try {
    const openStreetMapResults = await searchOpenStreetMapCityCatalog(normalizedQuery, country)
    citySearchCache.set(cacheKey, openStreetMapResults)
    return openStreetMapResults
  } catch {
    throw new V2WriteError(cesiumError ? 'E_CITY_SEARCH_ALL_UNAVAILABLE' : 'E_CITY_SEARCH_UNAVAILABLE')
  }
}

const requireText = (value, field) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new V2WriteError('E_REQUIRED', { field })
  return text
}

const updateDroneSidecar = async (cityRoot, destination, metadata, imageMetadata) => {
  const sidecarPath = path.join(cityRoot, 'media.json')
  const sidecar = await readJson(sidecarPath, {})
  const relativeKey = path.posix.join('drone', path.basename(destination))
  sidecar[relativeKey] = {
    kind: metadata.kind,
    titleZh: metadata.titleZh,
    titleEn: metadata.titleEn,
    date: metadata.date,
    resolution: `${imageMetadata.width} × ${imageMetadata.height}`,
    captureType: metadata.kind === 'panorama360' ? 'Drone 360 Panorama' : 'Aerial Photo',
    ...(metadata.lat === undefined || metadata.lng === undefined ? {} : {
      position: {
        lat: metadata.lat,
        lng: metadata.lng,
        ...(metadata.altitudeMeters === undefined ? {} : { altitudeMeters: metadata.altitudeMeters }),
      },
    }),
    ...(metadata.altitudeMeters === undefined ? {} : { altitudeMeters: metadata.altitudeMeters }),
    ...(metadata.relativeAltitudeMeters === undefined ? {} : { relativeAltitudeMeters: metadata.relativeAltitudeMeters }),
  }
  await atomicJsonWrite(sidecarPath, sidecar)
}

const normalizeInboxRelativePath = (value) => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const target = path.resolve(inboxRoot, value.trim())
  if (!isPathInside(inboxRoot, target)) throw new Error('媒体源文件路径超出投递箱范围。')
  return path.relative(inboxRoot, target).split(path.sep).join('/')
}

const serveUserMedia = async (request, response, pathname) => {
  // Private media is for this app's own pages only: other origins may neither embed nor sniff it.
  response.setHeader('cross-origin-resource-policy', 'same-origin')
  response.setHeader('x-content-type-options', 'nosniff')
  if (!authorizeRead(request)) {
    response.statusCode = 403
    response.end('Forbidden')
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405
    response.setHeader('allow', 'GET, HEAD')
    response.end('Method Not Allowed')
    return
  }

  let relativePath
  try {
    relativePath = decodeURIComponent(pathname.slice('/media/user/'.length))
  } catch {
    response.statusCode = 400
    response.end('Bad Request')
    return
  }
  const target = path.resolve(userMediaRoot, relativePath)
  // A link or junction anywhere from the private root down to the file is refused, as the media tasks and the import
  // plan refuse it (./path-containment.mjs): nothing inside the library may serve a file from somewhere else.
  if (!isPathInside(userMediaRoot, target) || await firstUnsafeComponent(privateRoot, target) !== undefined) {
    response.statusCode = 403
    response.end('Forbidden')
    return
  }

  let fileStats
  try {
    fileStats = await stat(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    response.statusCode = 404
    response.end('Not Found')
    return
  }
  if (!fileStats.isFile()) {
    response.statusCode = 404
    response.end('Not Found')
    return
  }

  response.statusCode = 200
  response.setHeader('content-type', userMediaContentTypes.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream')
  response.setHeader('content-length', String(fileStats.size))
  response.setHeader('cache-control', 'no-store')
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  await pipeline(createReadStream(target), response)
}

// Reads use authorizeRead (./local-editor-request-guard.mjs); writes additionally need the editor header.
const authorizeWrite = (request) => (
  isLoopbackRequest(request)
  && request.headers[editorHeader] === '1'
  && allowedOrigins(request)
)

/** 3C-4c：新库模式下媒体端点用到的插件辅助函数（文件名规则、接收上传、无人机 sidecar、投递箱路径），与 V2 相同。 */
const storeMediaDeps = () => ({
  safeSegment,
  reserveDestination,
  writeUpload: (stream, destination, kind) => writeUpload(stream, destination, kind, { stagingRoot: path.join(privateRoot, 'operations', 'uploads') }),
  updateDroneSidecar,
  normalizeInboxRelativePath,
})

/**
 * 3C-4d：不是新库的私人根拒绝一切写入（编辑、媒体、媒体任务）时的回答：没迁移的旧格式数据沿用 409 E_LEGACY_UNMIGRATED；
 * 有 V2 数据时 409 E_STORE_MIGRATION_REQUIRED；data/store/ 有残留（或空库没能建立）时 409 E_STORE_RECOVERY_REQUIRED。
 */
const notWritableResponse = (state) => {
  if (state.state === 'migration-required' && state.reason === 'legacy') return legacyWriteRefusal(legacyDataStateOf(privatePaths))
  return { status: 409, body: v2ErrorBody(state.state === 'migration-required' ? 'E_STORE_MIGRATION_REQUIRED' : 'E_STORE_RECOVERY_REQUIRED') }
}

export function travelAtlasLocalEditor(options = {}) {
  const profile = options.profile === 'personal' ? 'personal' : 'public'
  configurePrivatePaths(options.privateRoot)
  cesiumAccessToken = typeof options.cesiumAccessToken === 'string'
    ? options.cesiumAccessToken.trim()
    : ''
  // Filled by configResolved. Until then closeBundle treats the run as "not a build" and copies nothing.
  let command
  let outputRoot
  // Personal build only (batch 7, S3): the media files the filtered data still refers to, set when the virtual module loads.
  let buildMediaFiles = []
  // Personal build only (3C-5B spec §2.3): the data file closeBundle writes, { fileName, text }, set when the module loads.
  let buildData
  // Where the App loads its read model from; the virtual module only names it (3C-5B), the App fetches it at start-up
  // and shows an error page when it cannot.
  // - The dev server: the endpoint READ_MODEL_PATH with the store revision (`?revision=N`) or the V2 files' digest
  //   (`?v2=…`), all of the read model, because the editor restores and deletes hidden entries. Not inlining it keeps
  //   18 MB of data out of Vite's module transform (review of 3C-5B: the dev first screen).
  // - `vite build` of the personal profile (3C-5B spec §2.3): only what its pages can show (src/data/store/
  //   personalBuildReadModel.ts, batch 7's S3 filter on the read model); closeBundle writes that as the content-hashed
  //   data file data/read-model.<sha256 prefix>.json next to the bundle.
  const devReadModelUrl = (query) => `${READ_MODEL_PATH.slice(1)}?${query}`
  const buildReadModelUrl = (model) => {
    const started = performance.now()
    const { model: filtered, mediaFiles } = filterReadModelForPersonalBuild(model)
    const filterMs = Math.round(performance.now() - started)
    const text = JSON.stringify(filtered)
    const fileName = `data/read-model.${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`
    buildData = { fileName, text }
    buildMediaFiles = mediaFiles
    console.log(`[StarMap] 个人构建：读模型过滤 ${filterMs} ms；数据文件 ${fileName}（${(Buffer.byteLength(text) / 1048576).toFixed(1)} MB），媒体文件 ${mediaFiles.length} 个。`)
    return fileName
  }
  // The endpoint's bytes per read model (the session hands out the same object for one revision): JSON once per revision.
  const servedBytes = new WeakMap()
  const bytesOf = (model) => {
    let bytes = servedBytes.get(model)
    if (bytes === undefined) { bytes = Buffer.from(JSON.stringify(model), 'utf8'); servedBytes.set(model, bytes) }
    return bytes
  }
  /**
   * The endpoint's answer: { status, body (Buffer), revision? }. The library's read model; for a root that is not a library
   * yet the in-memory migration of its V2 files, and a migration that would be refused is 422 with its problems (codes,
   * paths and rules, never values), so the App's error page can say what to fix.
   */
  const readModelResponse = async () => {
    await initialized()
    if (storeMode()) {
      const view = await (await storeSession()).moduleExports()
      return { status: 200, body: bytesOf(view.model), revision: view.revision, identity: view.identity }
    }
    try {
      return { status: 200, body: bytesOf((await unmigratedReadModel()).model) }
    } catch (error) {
      if (!(error?.problems && typeof error.code === 'string')) throw error
      console.error(`[StarMap store] data/v2/ 的文件不能迁移成读模型（${error.code}）：\n${error.problems.join('\n')}`)
      return { status: 422, body: Buffer.from(JSON.stringify({ ok: false, code: error.code, problems: error.problems })) }
    }
  }
  // 3C-5B: a root that is not a library yet (migration required, needs recovery, or an empty root that got none) gives
  // the App the read model of its data/v2/ files migrated in memory (./store-migrate.mjs migrationReadModel, nothing is
  // written), so the App has one read path. Cached by the files' bytes: a reload does not migrate again; a change of the
  // files (the watcher invalidates the module) does.
  let unmigrated
  /** The V2 files as read (`values`) and the digest of their bytes (`key`), which names the migrated read model. */
  const unmigratedInputs = async () => {
    const { readV2Inputs } = await import('./store-migrate.mjs')
    const { values, bytes } = await readV2Inputs(privatePaths)
    const digest = createHash('sha256')
    for (const key of V2_PRIVATE_FILE_KEYS) digest.update(bytes[key] === undefined ? `${key}:missing;` : `${key}:${bytes[key].length}:`).update(bytes[key] ?? '')
    return { values, key: digest.digest('hex') }
  }
  const unmigratedReadModel = async () => {
    const { migrationReadModel } = await import('./store-migrate.mjs')
    const { values, key } = await unmigratedInputs()
    if (unmigrated?.key === key) return unmigrated
    const { model, timings } = migrationReadModel(values)
    console.log(`[StarMap store] 还不是新库：data/v2/ 的文件在内存里迁移成读模型（migrateV2 ${timings.migrateMs} ms，规划 ${timings.planMs} ms，读模型 ${timings.readModelMs} ms）。`)
    unmigrated = { key, model }
    return unmigrated
  }
  // 新库模式（3C-3）：这个插件实例的新库会话，第一次用到时才加载 ./store-session.mjs。整个进程只保留一个连接。
  // 3C-4b：构建（build:personal）以只读方式打开新库：不写正常关闭标记、不取写锁，开发服务器开着新库时也能构建。
  const storePaths = privatePaths
  let storeSessionLoading
  // 3C-5 D: every new revision of the library is pushed to the pages (configureServer sets `pushRevision`).
  let pushRevision = () => {}
  const storeSession = () => (storeSessionLoading ??= import('./store-session.mjs').then((module) => {
    const session = module.createStoreSession(storePaths, { countryCatalog: countryCatalogByCode, readOnly: command === 'build' })
    session.onRevision((revision) => pushRevision(revision))
    return session
  }))
  let externalCheckTimer
  const releaseStore = async () => { if (storeSessionLoading) await (await storeSessionLoading).close() }
  const dataState = () => privateDataState(storePaths)
  const storeMode = () => options.forceSample !== true && dataState().state === 'store'
  // 3C-4d（D-b A，评审 §8-1）：空的私人根在个人、可写的开发服务器启动时建一个空的新库（./store-init.mjs，在库租约下，
  // 建之前再判一次）。只在 configureServer 里开始：构建、公开模式与强制样例从不建库。虚拟模块与编辑接口先等它完成。
  // 建不成（例如另一个进程拿着库租约）时记日志，这个私人根按需要恢复处理（E_STORE_RECOVERY_REQUIRED）。
  let initialization
  let initializationFailed = false
  const initializeEmptyLibrary = () => (initialization ??= (async () => {
    if (dataState().state !== 'empty') return
    const { createEmptyLibrary } = await import('./store-init.mjs')
    const created = await createEmptyLibrary(storePaths, { actor: 'local-editor' })
    console.log(`[StarMap store] 私人根是空的：已建立新库（库 id ${created.libraryId}）。`)
  })().catch((error) => {
    initializationFailed = true
    console.error(`[StarMap store] 没有为空的私人根建立新库（${error?.code ?? error?.message ?? error}）。运行 npm run library:recover 查看。`)
  }))
  const initialized = () => initialization ?? Promise.resolve()

  return {
    name: 'travelatlas-local-editor',
    // For tests and tools: what the read-model endpoint answers ({ status, body, revision? }), without an HTTP server.
    api: { readModelResponse },
    configResolved(config) {
      command = config.command
      outputRoot = path.resolve(config.root, config.build.outDir)
    },
    resolveId(id) {
      if (id === virtualPrivateDataId) return resolvedPrivateDataId
    },
    async load(id) {
      if (id !== resolvedPrivateDataId) return undefined
      if (profile !== 'personal') return renderPrivateDataModule(privateDataModuleExports({ profile }))
      await initialized()
      if (storeMode()) {
        // 3C-3 新库模式；3C-5B 起给出新库的读模型与全库修订号。打不开就抛错（App 显示），绝不回落到 V2 文件。
        // 3C-4b：库损坏但还能读（打开检查失败）时照常给出数据，另报 storeReadOnly，页面显示只读提示。
        const view = await (await storeSession()).moduleExports()
        const legacyUnmigrated = isLegacyUnmigrated(legacyDataStateOf(privatePaths))
        const readModelUrl = command === 'build' ? buildReadModelUrl(view.model) : devReadModelUrl(`revision=${view.revision}`)
        return renderPrivateDataModule(privateDataModuleExports({ profile, readModelUrl, legacyUnmigrated, storeRevision: view.revision, storeReadOnly: view.readOnly }))
      }
      // 不是新库（3C-4d）：早先的连接（新库文件被移走）正常关闭。data/v2/ 的五个 V2 文件在内存里迁移成读模型（3C-5B；缺的文件
      // 当作空文件），外加状态：待迁移、需要恢复、没迁移的旧格式数据（只看文件在不在，不读内容）。页面据此显示提示，写入一律被拒绝。
      await releaseStore()
      // The dev server names the endpoint by the files' digest (it migrates when the App asks); a build migrates now.
      const readModelUrl = command === 'build'
        ? buildReadModelUrl((await unmigratedReadModel()).model)
        : devReadModelUrl(`v2=${(await unmigratedInputs()).key.slice(0, 16)}`)
      const state = dataState()
      const legacyUnmigrated = isLegacyUnmigrated(legacyDataStateOf(privatePaths))
      return renderPrivateDataModule(privateDataModuleExports({
        profile, readModelUrl, legacyUnmigrated,
        storeMigrationRequired: state.state === 'migration-required' && state.reason === 'v2',
        storeRecoveryRequired: state.state === 'needs-recovery' || (state.state === 'empty' && initializationFailed),
      }))
    },
    configureServer(server) {
      if (profile !== 'personal') return
      // Registered here, directly, so it runs before every Vite middleware: the private-data virtual module, /@fs/,
      // /media/user/* and the editor endpoints are all behind it. Forced sample still serves the private-data module,
      // so it keeps the guard too. Vite's own CORS is off in this profile (vite.config.ts).
      server.middlewares.use(crossSiteRequestGuard)
      if (options.forceSample === true) return
      // 3C-4d：空的私人根先建空库（建好之后，第一次读写时打开）。3C-3：本来就是新库时启动就打开它（失败只记日志；页面加载虚拟
      // 模块时会再试一次并显示错误）。
      if (dataState().state === 'empty') void initializeEmptyLibrary()
      else if (storeMode()) {
        void storeSession().then((session) => session.open()).catch((error) => console.error(error?.message ?? error))
      }
      let editorMutationDepth = 0
      let ignoreWatcherUntil = 0
      server.watcher.add(dataRoot)
      const invalidatePrivateDataModule = () => {
        const privateModule = server.moduleGraph.getModuleById(resolvedPrivateDataId)
        if (privateModule) server.moduleGraph.invalidateModule(privateModule)
      }
      // 3C-5 D: once per commit — an editor write and the revision push of its commit both invalidate it; a module already
      // invalidated (no transform result yet) is left as it is.
      const invalidatePrivateDataModuleOnce = () => {
        const privateModule = server.moduleGraph.getModuleById(resolvedPrivateDataId)
        if (privateModule && privateModule.transformResult !== null) server.moduleGraph.invalidateModule(privateModule)
      }
      // data/v2/ 的新建、修改、删除，以及四个旧数据文件的新建与删除（RFC-LOC-1 PR5a）：迁移写出 V2 文件、导入器更新媒体目录、
      // 把旧文件移走，不重启服务也会让虚拟模块失效；编辑器自己的写入期间与之后 1.5 秒内不刷新页面（原有条件）。
      const onPrivateDataEvent = (event, changedPath) => {
        if (!shouldHandlePrivateDataChange(event, changedPath, privatePaths)) return
        invalidatePrivateDataModule()
        if (editorMutationDepth > 0 || Date.now() < ignoreWatcherUntil) return
        server.ws.send({ type: 'full-reload' })
      }
      // 3C-5 D (design §3): the pages learn every new revision of the library by a push (`starmap:revision` with the
      // library id, restore mark and revision; they fetch the changes themselves). Commits of another process are looked
      // for when the library's files change (debounced) and every EXTERNAL_CHECK_MS while a page is connected (a file
      // event can be lost: chokidar drops a second change within 50 ms).
      // The private data module names the revision too (tools and tests read it): a push invalidates it (once: see above),
      // which reloads no page (the pages fetch the changes).
      pushRevision = (revision) => {
        invalidatePrivateDataModuleOnce()
        server.ws.send({ type: 'custom', event: REVISION_EVENT, data: revision })
      }
      let externalCheckPending
      const checkExternal = () => {
        if (!storeMode() || !storeSessionLoading) return
        void storeSession().then((session) => session.checkExternal()).catch(() => {})
      }
      const onStoreFileEvent = (event, changedPath) => {
        if (!isStoreFileChange(event, changedPath, privatePaths)) return
        clearTimeout(externalCheckPending)
        externalCheckPending = setTimeout(checkExternal, 100)
        externalCheckPending.unref?.()
      }
      externalCheckTimer = setInterval(() => { if ((server.ws.clients?.size ?? 0) > 0) checkExternal() }, EXTERNAL_CHECK_MS)
      externalCheckTimer.unref?.()
      for (const event of PRIVATE_DATA_WATCH_EVENTS) {
        server.watcher.on(event, (changedPath) => {
          onPrivateDataEvent(event, changedPath)
          onStoreFileEvent(event, changedPath)
        })
      }
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname.startsWith('/media/user/')) {
          try {
            await serveUserMedia(request, response, url.pathname)
          } catch {
            if (!response.headersSent) response.statusCode = 500
            response.end()
          }
          return
        }
        if (!url.pathname.startsWith('/__travelatlas/editor/')) return next()

        try {
          await initialized()
          // A sample-preview page never discovers or mutates private tasks.
          if (request.headers.referer) {
            let sample = false
            try { sample = new URL(request.headers.referer).searchParams.get('data') === 'sample' } catch { /* Other authorization still applies. */ }
            if (sample) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError(request.method === 'GET' ? 'E_EDITOR_READ_FORBIDDEN' : 'E_EDITOR_WRITE_FORBIDDEN')))
          }
          const jobRoute = mediaJobRoute(request.method, url.pathname)
          if (jobRoute && request.method === 'GET') {
            if (!authorizeWrite(request)) return sendJson(response,403,normalizeLocalEditorError(new V2WriteError('E_EDITOR_READ_FORBIDDEN')))
            // 3C-4d：媒体任务只在新库里进行；不是新库时连任务列表也回 409（页面据此说明要先迁移）。
            if (!storeMode()) {
              const refused = notWritableResponse(dataState())
              return sendJson(response, refused.status, refused.body)
            }
            // 3C-4c：任务读新库的视图与媒体登记。
            const result = await handleMediaJobRead({ privatePaths, route: jobRoute, storeMedia: { mediaStore: await (await storeSession()).mediaStore() } })
            return sendJson(response,result.status,result.body)
          }
          if (request.method === 'GET' && url.pathname === '/__travelatlas/editor/state') {
            if (!authorizeRead(request)) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError('E_EDITOR_READ_FORBIDDEN')))
            // 3C-3 新库模式：读新库的投影，不读 V2 文件。
            if (storeMode()) {
              const stored = await (await storeSession()).readEditorState()
              return sendJson(response, stored.status, stored.body)
            }
            // RFC-LOC-1 PR3b-2：读 data/v2/ 的 editor-state，转成 V1 形状返回。
            const result = await readV2EditorState({ privatePaths })
            return sendJson(response, result.status, result.body)
          }

          // 3C-5B（审查）：App 启动时从这里取读模型（只读；增量接口与推送是子批 D 的事）。地址里的修订号只为让保存后的整页
          // 刷新换一个地址；回答的总是当前的读模型，它的修订号在头里（x-starmap-revision），也在读模型本身的 revision 里。
          if (request.method === 'GET' && url.pathname === READ_MODEL_PATH) {
            if (!authorizeRead(request)) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError('E_EDITOR_READ_FORBIDDEN')))
            const served = await readModelResponse()
            response.statusCode = served.status
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.setHeader('cache-control', 'no-store')
            response.setHeader('content-length', String(served.body.length))
            if (served.revision !== undefined) response.setHeader('x-starmap-revision', String(served.revision))
            // 3C-5 D: which library the read model is of (the page checks the changes it applies against it).
            if (served.identity) {
              response.setHeader('x-starmap-library-id', served.identity.libraryId)
              response.setHeader('x-starmap-restore-mark', served.identity.restoreMark ?? '')
            }
            response.end(served.body)
            return
          }

          // 3C-5 D (design §3): the changes since the page's revision, or 410 E_CHANGES_GONE when the page has to read the
          // whole read model again (the reasons are ./store-change-log.mjs's). A root that is not a library has none.
          if (request.method === 'GET' && url.pathname === READ_MODEL_CHANGES_PATH) {
            if (!authorizeRead(request)) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError('E_EDITOR_READ_FORBIDDEN')))
            const sinceText = url.searchParams.get('since') ?? ''
            const since = Number(sinceText)
            if (!/^(0|[1-9][0-9]*)$/.test(sinceText) || !Number.isSafeInteger(since)) return sendJson(response, 400, v2ErrorBody('E_REQUEST_INVALID'))
            if (!storeMode()) return sendJson(response, 410, { ok: false, code: 'E_CHANGES_GONE', reason: 'not-a-library' })
            const libraryId = url.searchParams.get('libraryId') ?? undefined
            const restoreMark = url.searchParams.has('restoreMark') ? (url.searchParams.get('restoreMark') || null) : undefined
            const answer = await (await storeSession()).changesSince(since, { libraryId, restoreMark })
            response.setHeader('cache-control', 'no-store')
            return sendJson(response, answer.status, answer.body)
          }

          if (request.method === 'GET' && url.pathname === '/__travelatlas/editor/catalog/countries') {
            if (!authorizeRead(request)) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError('E_EDITOR_READ_FORBIDDEN')))
            return sendJson(response, 200, {
              ok: true,
              results: searchCountryCatalog(url.searchParams.get('q') ?? ''),
            })
          }

          if (request.method === 'GET' && url.pathname === '/__travelatlas/editor/catalog/cities') {
            if (!authorizeRead(request)) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError('E_EDITOR_READ_FORBIDDEN')))
            const results = await searchCityCatalog(
              url.searchParams.get('q') ?? '',
              url.searchParams.get('countryCode') ?? '',
              request.headers.referer ?? request.headers.origin,
            )
            return sendJson(response, 200, { ok: true, results })
          }

          if (!authorizeWrite(request)) return sendJson(response, 403, normalizeLocalEditorError(new V2WriteError('E_EDITOR_WRITE_FORBIDDEN')))
          // RFC-LOC-1 PR5a 决定 I：私人目录有没迁移的旧数据时，全部写入端点拒绝（409 E_LEGACY_UNMIGRATED），什么都不写（新库
          // 模式同样，沿用原来的判定）。3C-4d：不是新库的私人根（待迁移、需要恢复）同样拒绝一切写入（不认识的接口也一样），
          // 不读请求体，什么都不写。每个请求现判（只看文件在不在）。
          const legacyRefusal = legacyWriteRefusal(legacyDataStateOf(privatePaths))
          if (legacyRefusal) return sendJson(response, legacyRefusal.status, legacyRefusal.body)
          if (!storeMode()) {
            const refused = notWritableResponse(dataState())
            return sendJson(response, refused.status, refused.body)
          }
          // 8 个编辑端点写新库（3C-4a）；三个媒体端点与媒体任务也写新库（3C-4c）。
          // 3C-4b：库损坏、只读时，全部写入端点 409 E_STORE_READ_ONLY（编辑端点由会话判定，已提交请求的重放照常回原回执）。
          {
            const session = await storeSession()
            const write = session.writeRoute(request.method, url.pathname)
            if (!write) {
              const mediaRouteName = v2MediaRoute(request.method, url.pathname)
              const known = jobRoute || mediaRouteName || v2EditorRoute(request.method, url.pathname)
              if (!known) return sendJson(response, 404, v2ErrorBody('E_UNKNOWN_ENDPOINT'))
              // 3C-4c：只读的库（损坏）上，媒体端点与媒体任务一律 409 E_STORE_READ_ONLY，什么文件都不写（上传也一样）。
              if (await session.isDamaged()) return sendJson(response, 409, v2ErrorBody('E_STORE_READ_ONLY'))
              if (jobRoute) {
                // 3C-4c：媒体任务走新库（media-job-service.mjs 的 storeMedia）。预览只读、不取租约，其余在库租约之下，同 V2。
                const { releaseImageFiles } = await import('./media-service.mjs')
                releaseImageFiles()
                const jobInput = jobRoute.action === 'receive' ? undefined : await readJsonBody(request)
                const storeMedia = { mediaStore: await session.mediaStore() }
                if (jobRoute.action === 'preview') {
                  const preview = await handleMediaJobPreview({ privatePaths, route: jobRoute, input: jobInput, storeMedia })
                  return sendJson(response, preview.status, preview.body)
                }
                editorMutationDepth += 1
                const jobFrom = session.cachedRevision
                let jobResult
                try {
                  jobResult = await withLibraryOperation(privatePaths, (leaseToken) => handleMediaJobWrite({
                    privatePaths, route: jobRoute, input: jobInput, request, url, deps: { safeSegment, reserveDestination, updateDroneSidecar }, leaseToken, storeMedia,
                  }))
                } finally {
                  editorMutationDepth -= 1
                  if (editorMutationDepth === 0) ignoreWatcherUntil = Date.now() + 1_500
                  invalidatePrivateDataModuleOnce()
                }
                return sendJson(response, jobResult.status, withDelta(jobResult.body, session, jobFrom))
              }
              // 3C-4c：三个媒体端点写新库（./store-media-endpoints.mjs），在库租约之下；有未完成的媒体任务时拒绝，同 V2。
              const mediaInput = mediaRouteName === 'upload' ? undefined : await readJsonBody(request)
              editorMutationDepth += 1
              const mediaFrom = session.cachedRevision
              let mediaResult
              try {
                mediaResult = await withLibraryOperation(privatePaths, async (leaseToken) => {
                  await assertMediaJobsClear(privatePaths)
                  const { handleStoreMediaRoute } = await import('./store-media-endpoints.mjs')
                  return handleStoreMediaRoute({
                    routeName: mediaRouteName, privatePaths, mediaStore: await session.mediaStore(), query: url.searchParams, request,
                    input: mediaInput, headers: request.headers, leaseToken, deps: storeMediaDeps(),
                  })
                })
              } finally {
                editorMutationDepth -= 1
                if (editorMutationDepth === 0) ignoreWatcherUntil = Date.now() + 1_500
                invalidatePrivateDataModuleOnce()
              }
              return sendJson(response, mediaResult.status, withDelta(mediaResult.body, session, mediaFrom))
            }
            const result = await write({
              headers: request.headers, input: await readJsonBody(request), ctx: createV2WriteContext({ countryCatalog: countryCatalogByCode }),
            })
            // 提交之后（以及结果不明时）让虚拟模块失效；客户端照旧整页刷新。
            invalidatePrivateDataModuleOnce()
            return sendJson(response, result.status, result.body)
          }
        } catch (error) {
          return sendJson(response, ['E_LIBRARY_BUSY', 'E_LIBRARY_ROOT_MOVED'].includes(error?.code) ? 409 : 400, normalizeLocalEditorError(error))
        }
      })
    },
    // 3C-3：开发服务器关闭时正常关闭新库（写入「正常关闭」标记）。构建时没有打开过，什么都不做。
    async buildEnd() {
      if (externalCheckTimer) { clearInterval(externalCheckTimer); externalCheckTimer = undefined }
      await initialized()
      await releaseStore()
    },
    async closeBundle() {
      // The copy is for `build:personal` only. Vite's dev server also calls closeBundle when it shuts down (after
      // buildEnd), so without the command check every exit from `dev:personal` would quietly copy the private media
      // into the build output. The target is the resolved build.outDir (dist by default), not a hard-coded path.
      if (command !== 'build' || profile !== 'personal') return
      // 3C-5B: the read model's data file, written next to the bundle (the module names it relative to the base URL).
      if (buildData !== undefined) {
        const target = path.join(outputRoot, ...buildData.fileName.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, buildData.text)
      }
      if (!(await exists(userMediaRoot))) return
      // Only the files the kept media items refer to (originals and their derivatives), never the whole folder: hidden
      // media stay out of the build (batch 7, S3). Links are refused as when the dev server serves media.
      const outputMediaRoot = path.join(outputRoot, 'media', 'user')
      for (const relative of buildMediaFiles) {
        const source = path.join(userMediaRoot, ...relative.split('/'))
        if (!isPathInside(userMediaRoot, source) || await firstUnsafeComponent(privateRoot, source) !== undefined) continue
        const stats = await stat(source).catch(() => undefined)
        if (!stats?.isFile()) continue
        const target = path.join(outputMediaRoot, ...relative.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(source, target)
      }
    },
  }
}
