/**
 * 媒体导入（RFC-LOC-1 PR3b-3 规格 §2.1–§2.3、§2.5）。
 *
 * 入口是 scripts/import-media.mjs（`npm run media:check` / `media:import`）：PR5a 起旧格式的导入器已删除，入口只检查
 * 私人目录有没有没迁移的旧数据（有则拒绝，退出码 2），然后调用这里的 runV2MediaImport。
 * 流程与旧导入器相同——扫描投递箱 → 打印报告（预检）→ 加 --apply 时生成三级网页文件并写目录——只有三处不同：
 *
 * - **归属**：从地点注册表（data/v2/places.local.json）建索引，国家文件夹按 place.json → 旧 country.json 的 countryId
 *   （经 legacyKeys）→ 文件夹名解析，城市文件夹按 place.json → 文件夹名解析；不读旧足迹文件，也不回落到样例。
 *   0 个或多个候选都报错，不猜，不新建地点。按文件夹名或旧 country.json 解析成功的文件夹，--apply 且整次导入没有错误时
 *   写入 place.json（`{ "placeId": … }`，atomicJsonWrite）固定下来（RFC ID-6），此后地点改名也不影响；预检不写，已有的不动。
 * - **内容寻址**：媒体 id = media-<源文件 sha256 前 16 位>，生成文件在 media/user/<同一哈希>/。改名、搬城市、改类型
 *   都不改变 id 与路径；重复运行，目录与源文件索引除 generatedAt 外逐字节相同。
 * - **写盘**：data/v2/user-media.local.json（PR3a 的 V3 格式）与 data/v2/media-source-index.local.json，都用
 *   atomicJsonWrite。写之前，新目录放进五个 V2 文件必须通过完整性检查（每个条目的 placeId 都是注册表里的城市……），
 *   否则一个文件都不写。
 *
 * 可测试的部分（索引、解析、内容寻址、条目、封面）是纯函数，在 src/data/v2media/importPlan.ts。
 * 报告的格式与旧导入器相同：本地编辑器（local-editor-plugin.mjs 的 runImporter）按「需要处理」「缺少日期或分辨率」
 * 等字样判断预检是否通过。扫描的其余规则（文件夹别名、支持的格式、文件大小提醒、全景比例、sidecar 的读法）照抄旧导入器。
 */

import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { atomicJsonWrite } from './json-file.mjs'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'
import {
  DRONE_FOLDER_ALIASES,
  IGNORED_CONTROL_EXTENSIONS,
  NEEDS_CONVERSION_EXTENSIONS,
  PHOTO_FOLDER_ALIASES,
  STILL_EXTENSIONS,
  VIDEO_EXTENSIONS,
  buildMediaItem,
  catalogIntegrityProblems,
  contentHashOf,
  createMediaPlaceIndex,
  droneKindOf,
  generatedFilesOf,
  isLikelyEquirectangularPanorama,
  isStillMedia,
  markCovers,
  mediaCatalogFileOf,
  mediaSourceIndexFileOf,
  metadataForFile,
  normalizeName,
  orientedDimensions,
  placeConfigOf,
  placeDisplayName,
  resolveCityFolder,
  resolveCountryFolder,
  resolveFileOverride,
  shouldPinFolder,
  sourcesByIdOf,
  uniqueById,
} from '../src/data/v2media/importPlan.ts'
import { completeForWrite } from '../src/data/v2write/transaction.ts'

const toPosix = (value) => value.split(path.sep).join('/')

const pathExists = async (target) => {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const listDirectories = async (target) => {
  if (!(await pathExists(target))) return []
  return (await readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

const listMediaFiles = async (target) => {
  if (!(await pathExists(target))) return []
  const entries = await readdir(target, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const absolutePath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listMediaFiles(absolutePath))
      continue
    }
    if (!entry.isFile() || IGNORED_CONTROL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    files.push(absolutePath)
  }
  return files
}

const sha256 = (target) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(target)
  stream.on('error', reject)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', () => resolve(hash.digest('hex')))
})

/** 读不出的 V2 数据文件：只报文件与类别（JSON.parse 的消息会带出原文片段）。 */
const describeReadFailure = (error) => (error instanceof SyntaxError ? '不是有效的 JSON' : error?.code ?? error?.name ?? '未知错误')

/** 读 data/v2/ 的五个文件；缺的为 undefined。 */
const readV2DataFiles = async (privatePaths) => {
  const files = {}
  for (const key of V2_FILE_KEYS) {
    const target = privatePaths.v2FilePaths[key]
    try {
      files[key] = JSON.parse(await readFile(target, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(`V2 数据文件 ${target} 无法读取（${describeReadFailure(error)}）。`, { cause: error })
    }
  }
  return files
}

/**
 * 运行 V2 导入。`apply` 为 false 时只预检（不写任何文件）。返回退出码：0 完成（可能有提醒），1 有需要处理的问题或读写失败。
 * `now` 与两个输出函数可注入（测试用）。
 */
export async function runV2MediaImport({ privatePaths, apply = false, now = () => new Date(), log = console.log, logError = console.error, capturePlan = false }) {
  const inboxRoot = privatePaths.inboxRoot
  const outputRoot = privatePaths.userMediaRoot
  const errors = []
  const warnings = []
  const advisoryWarnings = []
  const planned = []
  /** 按文件夹名或旧 country.json 解析成功、还没有 place.json 的文件夹：--apply 时写入 place.json 固定下来（RFC ID-6）。 */
  const pins = []
  const relative = (filePath) => path.relative(inboxRoot, filePath)
  const captured = (files = {}, unique = [], items = []) => ({ privatePaths, files, planned, unique, items, pins, errors, warnings, advisoryWarnings })

  const printReport = (items) => {
    const counts = items.reduce((result, item) => {
      result[item.kind] = (result[item.kind] ?? 0) + 1
      return result
    }, {})
    log(`StarMap 媒体${apply ? '导入' : '预检'}：${items.length} 个文件`)
    log(`普通照片 ${counts.photo ?? 0} | 360 全景 ${counts.panorama360 ?? 0} | 航拍照片 ${counts.aerialPhoto ?? 0} | 视频 ${counts.video ?? 0}`)
    if (warnings.length > 0) {
      log(`\n提醒（${warnings.length}）：`)
      for (const warning of warnings) log(`- ${warning}`)
    }
    if (errors.length > 0) {
      logError(`\n需要处理（${errors.length}）：`)
      for (const error of errors) logError(`- ${error}`)
    }
    if (!apply && errors.length === 0 && pins.length > 0) {
      log(`\n导入时将在 ${pins.length} 个按名称匹配的收件箱文件夹写入 place.json，固定为地点 id：`)
      for (const pin of pins) log(`- ${toPosix(relative(pin.directory))}/place.json`)
    }
    if (!apply && errors.length === 0) log('\n预检通过。确认无误后运行 npm run media:import。')
  }

  /** 投递箱里的控制文件（place.json、country.json、media.json）：不存在为 undefined；读不出时记错误（同旧导入器的写法）。 */
  const READ_FAILED = Symbol('read-failed')
  const readControlFile = async (target, label) => {
    if (!(await pathExists(target))) return undefined
    try {
      return JSON.parse(await readFile(target, 'utf8'))
    } catch (error) {
      errors.push(`${label} 无法读取：${error.message}`)
      return READ_FAILED
    }
  }

  // ---- 地点注册表 ----
  let files
  try {
    files = await readV2DataFiles(privatePaths)
  } catch (error) {
    errors.push(error.message)
    if (capturePlan) return captured()
    printReport([])
    return 1
  }
  const placeProblems = validateV2Files(completeForWrite(files, now())).filter((problem) => problem.file === 'places')
  if (placeProblems.length > 0) {
    errors.push(`地点注册表 ${privatePaths.v2FilePaths.places} 没有通过校验（${placeProblems.length} 处），无法解析照片归属：${placeProblems.slice(0, 5).map((problem) => `${problem.path}：${problem.message}`).join('；')}`)
    if (capturePlan) return captured(files)
    printReport([])
    return 1
  }
  const index = createMediaPlaceIndex(files.places?.places ?? [])

  // ---- 扫描（规则照抄旧导入器）----
  const validateExtension = (filePath, kind) => {
    const extension = path.extname(filePath).toLowerCase()
    const isSupported = kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : STILL_EXTENSIONS.has(extension)
    if (isSupported) return extension
    if (NEEDS_CONVERSION_EXTENSIONS.has(extension)) {
      errors.push(`${relative(filePath)} 需要先转换成网页格式。照片使用 JPG/WebP/AVIF，视频使用 MP4/WebM。`)
    } else {
      warnings.push(`${relative(filePath)} 不是支持的媒体格式，已忽略。`)
    }
    return undefined
  }

  const planFile = async ({ filePath, kind, city, metadata = {} }) => {
    const extension = validateExtension(filePath, kind)
    if (!extension) return

    const fileStats = await stat(filePath)
    const sizeInMiB = fileStats.size / 1024 / 1024
    const warningThreshold = kind === 'panorama360' ? 40 : kind === 'video' ? 120 : 16
    if (sizeInMiB > warningThreshold) {
      const warning = `${relative(filePath)} 为 ${sizeInMiB.toFixed(1)} MiB，建议 Agent 生成更轻的网页版本。`
      warnings.push(warning); advisoryWarnings.push(warning)
    }

    const fullHash = await sha256(filePath)
    const hash = contentHashOf(fullHash)
    const still = isStillMedia(kind, extension)
    let dimensions
    if (still) {
      try {
        dimensions = orientedDimensions(await sharp(filePath).metadata())
      } catch (error) {
        errors.push(`${relative(filePath)} 无法读取图片尺寸：${error.message}`)
        return
      }
      if (!dimensions) {
        errors.push(`${relative(filePath)} 缺少有效的图片宽高。`)
        return
      }
      if (kind === 'panorama360' && !isLikelyEquirectangularPanorama(dimensions)) {
        errors.push(`${relative(filePath)} 是 ${dimensions.width} × ${dimensions.height}，不是常见的 2:1 等距柱状全景图；请在 media.json 中改为 aerialPhoto，或换用正确的 360 全景图。`)
        return
      }
    }

    const item = buildMediaItem({ hash, extension, kind, placeId: city.id, originalFileName: path.basename(filePath), dimensions, metadata })
    if (item.status === 'needsMetadata') {
      warnings.push(`${relative(filePath)} 缺少日期或分辨率；会进入目录，但暂不显示为 Drone Media。`)
    }
    const generated = generatedFilesOf(hash, extension)
    const outputPathOf = (relativeFile) => path.join(outputRoot, ...relativeFile.split('/'))
    planned.push({
      id: item.id,
      item,
      sha256: fullHash,
      bytes: fileStats.size,
      metadata,
      sourcePath: filePath,
      outputDirectory: outputPathOf(generated.directory),
      outputPath: outputPathOf(generated.original),
      derivatives: still
        ? generated.derivatives.map((derivative) => ({ outputPath: outputPathOf(derivative.file), maxEdge: derivative.maxEdge, quality: derivative.quality }))
        : [],
    })
  }

  const findNamedRoot = async (cityRoot, aliases, label) => {
    const matches = (await listDirectories(cityRoot)).filter((entry) => aliases.has(normalizeName(entry.name)))
    if (matches.length > 1) {
      errors.push(`${path.basename(cityRoot)} 同时存在多个${label}目录：${matches.map((entry) => entry.name).join('、')}`)
    }
    return matches[0] ? path.join(cityRoot, matches[0].name) : undefined
  }

  const scanDrone = async (droneRoot, city, cityRoot, cityLabel) => {
    if (!droneRoot) return
    // 与旧导入器相同：城市文件夹的 media.json，没有则读 drone/media.json；两处都没有时同样报「无法读取」。
    const cityMetadataPath = path.join(cityRoot, 'media.json')
    const metadataPath = await pathExists(cityMetadataPath) ? cityMetadataPath : path.join(droneRoot, 'media.json')
    let metadata
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    } catch (error) {
      errors.push(`${cityLabel}/media.json 无法读取：${error.message}`)
      metadata = undefined
    }

    for (const filePath of await listMediaFiles(droneRoot)) {
      const fileMetadata = metadataForFile(metadata, toPosix(path.relative(cityRoot, filePath)), path.basename(filePath))
      const owner = resolveFileOverride(index, city, fileMetadata, relative(filePath))
      if (!owner.ok) {
        errors.push(owner.error)
        continue
      }
      const { kind, unlabelled } = droneKindOf(path.basename(filePath), path.extname(filePath).toLowerCase(), fileMetadata)
      if (unlabelled) {
        warnings.push(`${relative(filePath)} 未标注无人机类型，按普通航拍照片处理；360 全景请让 Agent 在 media.json 中标记 kind。`)
      }
      await planFile({ filePath, kind, city: owner.place, metadata: fileMetadata })
    }
  }

  const scanCity = async (cityRoot, country, city) => {
    const cityLabel = `${placeDisplayName(country)}/${placeDisplayName(city)}`
    const directMedia = (await readdir(cityRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !IGNORED_CONTROL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    if (directMedia.length > 0) {
      errors.push(`${cityLabel} 根目录有 ${directMedia.length} 个媒体文件；请放入 photos 或 drone。`)
    }

    const photosRoot = await findNamedRoot(cityRoot, PHOTO_FOLDER_ALIASES, '普通照片')
    const droneRoot = await findNamedRoot(cityRoot, DRONE_FOLDER_ALIASES, '无人机')
    if (photosRoot) {
      for (const filePath of await listMediaFiles(photosRoot)) await planFile({ filePath, kind: 'photo', city })
    }
    await scanDrone(droneRoot, city, cityRoot, cityLabel)

    const allowedFolderNames = new Set([...PHOTO_FOLDER_ALIASES, ...DRONE_FOLDER_ALIASES])
    for (const entry of await listDirectories(cityRoot)) {
      if (!entry.name.startsWith('_') && !allowedFolderNames.has(normalizeName(entry.name))) {
        warnings.push(`${cityLabel}/${entry.name} 不是 photos 或 drone，已忽略。`)
      }
    }
  }

  if (!(await pathExists(inboxRoot))) {
    errors.push('找不到外置私有层的 MediaInbox。请先建立 <private-root>/MediaInbox，仓库中的 02_Assets/MediaInbox 仅为公开模板。')
  } else {
    for (const countryEntry of await listDirectories(inboxRoot)) {
      if (countryEntry.name.startsWith('_')) continue
      const countryRoot = path.join(inboxRoot, countryEntry.name)
      const placeConfig = await readControlFile(path.join(countryRoot, 'place.json'), `${countryEntry.name}/place.json`)
      const countryConfig = await readControlFile(path.join(countryRoot, 'country.json'), `${countryEntry.name}/country.json`)
      if (placeConfig === READ_FAILED || countryConfig === READ_FAILED) continue
      const countryLookup = resolveCountryFolder(index, { folderName: countryEntry.name, placeConfig, countryConfig })
      if (!countryLookup.ok) {
        errors.push(countryLookup.error)
        continue
      }
      const country = countryLookup.place
      if (shouldPinFolder(countryLookup)) pins.push({ directory: countryRoot, placeId: country.id })
      const countryLabel = placeDisplayName(country)

      const countryRootMedia = (await readdir(countryRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !IGNORED_CONTROL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      if (countryRootMedia.length > 0) {
        errors.push(`${countryLabel} 根目录有 ${countryRootMedia.length} 个媒体文件；最小单位是城市，请先建立城市目录。`)
      }

      for (const cityEntry of await listDirectories(countryRoot)) {
        const cityRoot = path.join(countryRoot, cityEntry.name)
        if (cityEntry.name.startsWith('_')) {
          const unresolvedFiles = await listMediaFiles(cityRoot)
          if (unresolvedFiles.length > 0) {
            errors.push(`${countryLabel}/${cityEntry.name} 中还有 ${unresolvedFiles.length} 个文件；请让 Agent 确认城市后再导入。`)
          }
          continue
        }
        const cityPlaceConfig = await readControlFile(path.join(cityRoot, 'place.json'), `${countryEntry.name}/${cityEntry.name}/place.json`)
        if (cityPlaceConfig === READ_FAILED) continue
        const cityLookup = resolveCityFolder(index, country, { countryFolderName: countryEntry.name, folderName: cityEntry.name, placeConfig: cityPlaceConfig })
        if (!cityLookup.ok) {
          errors.push(cityLookup.error)
          continue
        }
        if (shouldPinFolder(cityLookup)) pins.push({ directory: cityRoot, placeId: cityLookup.place.id })
        await scanCity(cityRoot, country, cityLookup.place)
      }
    }
  }

  const unique = uniqueById(planned)
  if (unique.length !== planned.length) {
    const warning = `发现 ${planned.length - unique.length} 个内容完全相同的重复文件，目录中只保留一份记录。`
    warnings.push(warning); advisoryWarnings.push(warning)
  }
  const items = markCovers(unique.map((entry) => entry.item))
  if (capturePlan) return captured(files, unique, items)
  printReport(items)

  if (errors.length > 0) {
    if (apply) logError('\n未写入任何新目录。请先处理以上问题。')
    return 1
  }
  if (!apply) return 0

  // ---- 写盘：先检查，再生成网页文件，最后原子写两个 JSON ----
  const generatedAt = now().toISOString()
  const catalog = mediaCatalogFileOf(items, generatedAt)
  const problems = catalogIntegrityProblems(files, catalog, now())
  if (problems.length > 0) {
    logError(`\n需要处理（1）：\n- 新的媒体目录放进 V2 数据后没有通过完整性检查（${problems.length} 处）：${problems.slice(0, 5).join('；')}`)
    logError('\n未写入任何新目录。请先处理以上问题。')
    return 1
  }

  await applyV2MediaImportScan({ privatePaths, scan: captured(files, unique, items), now, log })
  return 0
}

/** The CLI and durable task planner share exactly one Inbox scanner. Never writes. */
export const scanV2MediaImport = (options) => runV2MediaImport({ ...options, apply: false, capturePlan: true })

/** Caller validates the full plan and holds the library lease before entering. */
export async function applyV2MediaImportScan({ privatePaths, scan, now = () => new Date(), log = () => {}, onStage = async () => {} }) {
  const { unique, planned, pins, items } = scan
  const inboxRoot = privatePaths.inboxRoot
  const relative = (filePath) => path.relative(inboxRoot, filePath)
  const generatedAt = now().toISOString()
  const catalog = mediaCatalogFileOf(items, generatedAt)
  for (const entry of unique) {
    await mkdir(entry.outputDirectory, { recursive: true })
    try {
      await copyFile(entry.sourcePath, entry.outputPath, constants.COPYFILE_EXCL)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    for (const derivative of entry.derivatives) {
      if (await pathExists(derivative.outputPath)) continue
      await sharp(entry.sourcePath)
        .rotate()
        .resize({ width: derivative.maxEdge, height: derivative.maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: derivative.quality, effort: 4 })
        .toFile(derivative.outputPath)
    }
  }
  await onStage('generated')

  // RFC ID-6：按名称（或旧 country.json）匹配成功的文件夹写入 place.json，此后按 id 解析、不再按名字重新匹配。
  // 已有 place.json 的文件夹不在 pins 里，不动。
  for (const pin of pins) await atomicJsonWrite(path.join(pin.directory, 'place.json'), placeConfigOf(pin.placeId))
  await onStage('pins')
  if (pins.length > 0) {
    log(`\n已在 ${pins.length} 个按名称匹配的收件箱文件夹写入 place.json，固定为地点 id：`)
    for (const pin of pins) log(`- ${toPosix(relative(pin.directory))}/place.json`)
  }

  await atomicJsonWrite(privatePaths.v2FilePaths.media, catalog)
  await onStage('catalog')
  const sourcesById = sourcesByIdOf(planned.map((entry) => ({ id: entry.id, sourcePath: toPosix(relative(entry.sourcePath)) })))
  const index = mediaSourceIndexFileOf(sourcesById, generatedAt)
  await atomicJsonWrite(privatePaths.v2MediaSourceIndexPath, index)
  await onStage('index')
  log('\n已更新私人目录 data/v2/ 中的媒体目录与源文件索引。')
  log('开发预览会自动刷新媒体目录；若页面未更新，请手动刷新一次。')
  return { mediaIds: items.map((item) => item.id), catalog, index }
}
