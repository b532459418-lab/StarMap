/**
 * 媒体导入（RFC-LOC-1 PR3b-3 规格 §2.1–§2.3、§2.5）。
 *
 * 入口是 scripts/import-media.mjs（`npm run media:check` / `media:import`）：PR5a 起旧格式的导入器已删除，入口只检查
 * 私人目录有没有没迁移的旧数据（有则拒绝，退出码 2），然后调用这里的 runV2MediaImport。
 * 流程与旧导入器相同——扫描投递箱 → 打印报告（预检）→ 加 --apply 时生成三级网页文件并写目录——只有三处不同：
 *
 * - **归属**：从地点注册表（data/v2/places.local.json）建索引，国家文件夹按 place.json → 旧 country.json 的 countryId
 *   （经 legacyKeys）→ 文件夹名解析，城市文件夹按 place.json → 文件夹名解析；不读旧足迹文件，也不回落到样例。
 *   0 个或多个候选都报错，不猜，不新建地点。
 * - **文件夹绑定需要确认（第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）**：按文件夹名或旧 country.json 第一次解析出的归属
 *   （只有一个候选时也一样）是「待确认的文件夹绑定」。预检列出「文件夹 → 地点（中文名 / 英文名）」；--apply 时有待确认的
 *   绑定就拒绝写入（退出码 2，什么都不写），加 --accept-folder-bindings 才接受：整次导入没有错误时写入 place.json
 *   （`{ "placeId": … }`，atomicJsonWrite）固定下来，此后按 id 解析，地点改名也不影响。已有 place.json 的文件夹不受影响。
 *   媒体任务（恢复中心）在导入确认步骤里一并确认（./media-import-plan.mjs、./media-job-service.mjs）。
 * - **内容寻址**：媒体 id = media-<源文件 sha256 前 16 位>，生成文件在 media/user/<同一哈希>/。改名、搬城市、改类型
 *   都不改变 id 与路径；重复运行，目录与源文件索引除 generatedAt 外逐字节相同。
 * - **写盘**：data/v2/user-media.local.json（PR3a 的 V3 格式）与 data/v2/media-source-index.local.json，都用
 *   atomicJsonWrite。写之前，新目录放进五个 V2 文件必须通过完整性检查（每个条目的 placeId 都是注册表里的城市……），
 *   否则一个文件都不写。
 * - **生成文件的发布（第 1 批 D7）**：原图先复制、衍生图先由 sharp 写到同目录的临时文件
 *   `.<最终文件名>.<pid>.<uuid>.tmp`，fsync 后不覆盖地发布（`link` 到最终路径再删临时文件；文件系统不支持硬链接时，
 *   在库操作租约下先确认最终路径不存在再 rename）。最终路径已存在视为已经发布过。中断只会留下临时文件，不会留下
 *   截断的最终文件；下次导入在写入前删掉这些输出目录里由其他进程留下的临时文件（导入总在库操作租约下运行，
 *   所以其他进程的临时文件只可能是中断的遗留；本进程自己的临时文件由失败路径删除）。
 * - **校验（`media:check --verify`）**：对已存在的原图（目录里的条目与这次计划的条目）重算内容哈希，与目录名（哈希前缀）
 *   核对，只报告不一致（记为需要处理的问题），不自动修复。默认流程不做全量哈希。
 *
 * 可测试的部分（索引、解析、内容寻址、条目、封面）是纯函数，在 src/data/v2media/importPlan.ts。
 * 报告的格式与旧导入器相同：本地编辑器（local-editor-plugin.mjs 的 runImporter）按「需要处理」「缺少日期或分辨率」
 * 等字样判断预检是否通过。扫描的其余规则（文件夹别名、支持的格式、文件大小提醒、全景比例、sidecar 的读法）照抄旧导入器。
 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { sha256File } from './file-hash.mjs'
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
  folderBindingLine,
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

// ---- 生成文件：临时文件 + 不覆盖地发布（D7）----

const PUBLISH_TEMPORARY = /^\.(.+)\.([1-9]\d{0,9})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** 导入器发布用的临时文件名 → `{ finalName, pid }`；不是这种名字为 undefined。计划（media-import-plan.mjs）也用它容忍遗留。 */
export const publishTemporaryOf = (name) => {
  const match = PUBLISH_TEMPORARY.exec(name)
  return match ? { finalName: match[1], pid: Number(match[2]) } : undefined
}

const temporaryPathFor = (finalPath) => path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`)

const syncFile = async (target) => {
  const handle = await open(target, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 不覆盖地发布：返回 true 为本次发布，false 为最终路径已存在（视为已经发布过，删掉临时文件）。 */
const publishWithoutOverwrite = async (temporary, finalPath) => {
  try {
    await link(temporary, finalPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await unlink(temporary)
      return false
    }
    // 不支持硬链接的文件系统（FAT/exFAT、部分网络盘）：导入持有库操作租约，没有别的写入方，先查再 rename 等价于不覆盖。
    if (await pathExists(finalPath)) {
      await unlink(temporary)
      return false
    }
    await rename(temporary, finalPath)
    return true
  }
  await unlink(temporary)
  return true
}

/** `produce(temporary)` 写出完整内容 → fsync → 发布。任何一步失败都删除临时文件再抛出。 */
const writeThenPublish = async (finalPath, produce) => {
  const temporary = temporaryPathFor(finalPath)
  try {
    await produce(temporary)
    await syncFile(temporary)
    return await publishWithoutOverwrite(temporary, finalPath)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * 删除输出目录里其他进程遗留的发布临时文件。只删：名字完全符合 `.<名字>.<pid>.<uuid>.tmp`、是普通文件、pid 不是本进程。
 * 调用方持有库操作租约，同一时刻只有一个导入在写，所以这些文件只可能是中断的遗留。
 */
const removeStaleTemporaries = async (directory) => {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const temporary = publishTemporaryOf(name)
    if (!temporary || temporary.pid === process.pid) continue
    const target = path.join(directory, name)
    const info = await lstat(target).catch(() => undefined)
    if (!info?.isFile()) continue
    await unlink(target).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

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

/** 预检与拒绝时列出待确认绑定的标题（本地编辑器的导入器按这几个字判断预检没有通过）。 */
export const FOLDER_BINDINGS_HEADING = '待确认的文件夹绑定'
const FOLDER_BINDINGS_HINT = '确认无误后运行 npm run media:import -- --accept-folder-bindings；不对时在该文件夹里放 place.json 指定地点。'
/** --apply 遇到待确认的文件夹绑定、又没有 --accept-folder-bindings 时的退出码（什么都不写）。 */
export const FOLDER_BINDINGS_EXIT_CODE = 2

/**
 * A media file's extension against its kind (the old importer's rule): undefined when supported; `{ error }` for a format
 * that must be converted first; `{ warning }` for anything else (ignored). `relativePath` is how the message names the file.
 */
export const extensionProblemOf = (relativePath, kind, extension) => {
  const isSupported = kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : STILL_EXTENSIONS.has(extension)
  if (isSupported) return undefined
  if (NEEDS_CONVERSION_EXTENSIONS.has(extension)) return { error: `${relativePath} 需要先转换成网页格式。照片使用 JPG/WebP/AVIF，视频使用 MP4/WebM。` }
  return { warning: `${relativePath} 不是支持的媒体格式，已忽略。` }
}

/** The reminder for a drone file whose kind no sidecar entry or file name gives (it is imported as an aerial photo). */
export const unlabelledDroneWarning = (relativePath) => `${relativePath} 未标注无人机类型，按普通航拍照片处理；360 全景请让 Agent 在 media.json 中标记 kind。`

/**
 * The importer's walk through the Inbox (rules copied from the old importer, unchanged), shared by the V2 import and the
 * new library's scan (./media-scan.mjs, 3C-4c): country folders, their city folders, then a city's `photos` and `drone`
 * folders, each listed in the same sorted order as before. Problems of folders and control files go to `errors` and
 * `warnings`, folder bindings found by name (or a legacy country.json) to `pins`, in the order they are met. Every
 * media file goes to `onFile({ filePath, kind, unlabelled, city, metadata, countryRoot, cityRoot })`, awaited in walk
 * order: `city` is the place it belongs to (a file's sidecar entry may name another city), `metadata` its sidecar entry
 * (drone files; undefined for photos). Reads only; never writes.
 */
export async function walkInbox({ inboxRoot, index, errors, warnings, pins, onFile }) {
  const relative = (filePath) => path.relative(inboxRoot, filePath)
  const bindingOf = (directory, lookup) => ({
    directory,
    placeId: lookup.place.id,
    subtype: lookup.place.subtype,
    names: { ...lookup.place.names },
    source: lookup.source,
  })

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

  const findNamedRoot = async (cityRoot, aliases, label) => {
    const matches = (await listDirectories(cityRoot)).filter((entry) => aliases.has(normalizeName(entry.name)))
    if (matches.length > 1) {
      errors.push(`${path.basename(cityRoot)} 同时存在多个${label}目录：${matches.map((entry) => entry.name).join('、')}`)
    }
    return matches[0] ? path.join(cityRoot, matches[0].name) : undefined
  }

  const scanDrone = async (droneRoot, city, cityRoot, cityLabel, countryRoot) => {
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
      await onFile({ filePath, kind, unlabelled, city: owner.place, metadata: fileMetadata, countryRoot, cityRoot })
    }
  }

  const scanCity = async (cityRoot, country, city, countryRoot) => {
    const cityLabel = `${placeDisplayName(country)}/${placeDisplayName(city)}`
    const directMedia = (await readdir(cityRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !IGNORED_CONTROL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    if (directMedia.length > 0) {
      errors.push(`${cityLabel} 根目录有 ${directMedia.length} 个媒体文件；请放入 photos 或 drone。`)
    }

    const photosRoot = await findNamedRoot(cityRoot, PHOTO_FOLDER_ALIASES, '普通照片')
    const droneRoot = await findNamedRoot(cityRoot, DRONE_FOLDER_ALIASES, '无人机')
    if (photosRoot) {
      for (const filePath of await listMediaFiles(photosRoot)) {
        await onFile({ filePath, kind: 'photo', unlabelled: false, city, metadata: undefined, countryRoot, cityRoot })
      }
    }
    await scanDrone(droneRoot, city, cityRoot, cityLabel, countryRoot)

    const allowedFolderNames = new Set([...PHOTO_FOLDER_ALIASES, ...DRONE_FOLDER_ALIASES])
    for (const entry of await listDirectories(cityRoot)) {
      if (!entry.name.startsWith('_') && !allowedFolderNames.has(normalizeName(entry.name))) {
        warnings.push(`${cityLabel}/${entry.name} 不是 photos 或 drone，已忽略。`)
      }
    }
  }

  if (!(await pathExists(inboxRoot))) {
    errors.push('找不到外置私有层的 MediaInbox。请先建立 <private-root>/MediaInbox，仓库中的 02_Assets/MediaInbox 仅为公开模板。')
    return
  }
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
    if (shouldPinFolder(countryLookup)) pins.push(bindingOf(countryRoot, countryLookup))
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
      if (shouldPinFolder(cityLookup)) pins.push(bindingOf(cityRoot, cityLookup))
      await scanCity(cityRoot, country, cityLookup.place, countryRoot)
    }
  }
}

/**
 * 运行 V2 导入。`apply` 为 false 时只预检（不写任何文件）。返回退出码：0 完成（可能有提醒），1 有需要处理的问题或读写失败，
 * 2 有待确认的文件夹绑定而没有 `acceptFolderBindings`（第 2A 批；什么都不写）。
 * `now` 与两个输出函数可注入（测试用）。
 */
export async function runV2MediaImport({ privatePaths, apply = false, verify = false, acceptFolderBindings = false, excludeSourcePaths = [], now = () => new Date(), log = console.log, logError = console.error, capturePlan = false }) {
  const inboxRoot = privatePaths.inboxRoot
  // 彻底删除的预检（第 1 批 D5）按「删除之后」的投递箱扫描：要删的源文件不参与。只用于只读扫描。
  const sourceKey = (target) => (process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target))
  const excluded = new Set(excludeSourcePaths.map(sourceKey))
  const outputRoot = privatePaths.userMediaRoot
  const errors = []
  const warnings = []
  const advisoryWarnings = []
  const planned = []
  /**
   * 待确认的文件夹绑定：按文件夹名或旧 country.json 解析成功、还没有 place.json 的文件夹（第 2A 批）。确认之后
   * （CLI 的 --accept-folder-bindings，或媒体任务的导入确认）才写入 place.json 固定下来（RFC ID-6）。
   */
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
    if (pins.length > 0 && !(apply && acceptFolderBindings)) {
      log(`\n${FOLDER_BINDINGS_HEADING}（${pins.length}）：以下文件夹按名称（或旧 country.json）匹配到地点，确认之后才会写入 place.json 并按它导入：`)
      for (const pin of pins) log(`- ${folderBindingLine(toPosix(relative(pin.directory)), pin)}`)
    }
    if (!apply && errors.length === 0) {
      log(pins.length > 0
        ? `\n预检通过，但有按名称匹配的文件夹绑定需要确认。${FOLDER_BINDINGS_HINT}`
        : '\n预检通过。确认无误后运行 npm run media:import。')
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
    const problem = extensionProblemOf(relative(filePath), kind, extension)
    if (!problem) return extension
    if (problem.error) errors.push(problem.error)
    else warnings.push(problem.warning)
    return undefined
  }

  const planFile = async ({ filePath, kind, city, metadata = {} }) => {
    if (excluded.has(sourceKey(filePath))) return
    const extension = validateExtension(filePath, kind)
    if (!extension) return

    const fileStats = await stat(filePath)
    const sizeInMiB = fileStats.size / 1024 / 1024
    const warningThreshold = kind === 'panorama360' ? 40 : kind === 'video' ? 120 : 16
    if (sizeInMiB > warningThreshold) {
      const warning = `${relative(filePath)} 为 ${sizeInMiB.toFixed(1)} MiB，建议 Agent 生成更轻的网页版本。`
      warnings.push(warning); advisoryWarnings.push(warning)
    }

    const fullHash = await sha256File(filePath)
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

  // 3C-4c：遍历投递箱的规则移到 walkInbox（与新库的扫描共用），顺序、提示与错误都不变。
  await walkInbox({
    inboxRoot, index, errors, warnings, pins,
    onFile: async ({ filePath, kind, unlabelled, city, metadata }) => {
      if (unlabelled) warnings.push(unlabelledDroneWarning(relative(filePath)))
      await planFile({ filePath, kind, city, metadata })
    },
  })

  const unique = uniqueById(planned)
  if (unique.length !== planned.length) {
    const warning = `发现 ${planned.length - unique.length} 个内容完全相同的重复文件，目录中只保留一份记录。`
    warnings.push(warning); advisoryWarnings.push(warning)
  }
  const items = markCovers(unique.map((entry) => entry.item))
  if (capturePlan) return captured(files, unique, items)
  if (verify) await verifyGeneratedOriginals({ files, unique, outputRoot, errors, log })
  printReport(items)

  if (errors.length > 0) {
    if (apply) logError('\n未写入任何新目录。请先处理以上问题。')
    return 1
  }
  if (!apply) return 0
  if (pins.length > 0 && !acceptFolderBindings) {
    logError(`\n未写入任何文件：有 ${pins.length} 个按名称匹配的文件夹绑定还没有确认（见上）。${FOLDER_BINDINGS_HINT}`)
    return FOLDER_BINDINGS_EXIT_CODE
  }

  // ---- 写盘：先检查，再生成网页文件，最后原子写两个 JSON ----
  const generatedAt = now().toISOString()
  const catalog = mediaCatalogFileOf(items, generatedAt)
  const problems = catalogIntegrityProblems(files, catalog, now())
  if (problems.length > 0) {
    logError(`\n需要处理（1）：\n- 新的媒体目录放进 V2 数据后没有通过完整性检查（${problems.length} 处）：${problems.slice(0, 5).join('；')}`)
    logError('\n未写入任何新目录。请先处理以上问题。')
    return 1
  }

  await applyV2MediaImportScan({ privatePaths, scan: captured(files, unique, items), now, log, acceptFolderBindings })
  return 0
}

/**
 * `--verify`：已存在的原图（当前目录里的条目，加这次计划的条目）重算 sha256，前 16 位必须等于所在目录名。
 * 不一致记为需要处理的问题（退出码 1），不删除、不重写任何文件。
 */
async function verifyGeneratedOriginals({ files, unique, outputRoot, errors, log }) {
  const originals = new Map()
  for (const item of Array.isArray(files.media?.items) ? files.media.items : []) {
    const match = typeof item?.src === 'string' && /^\/media\/user\/([a-f0-9]{16})\/(original\.[a-z0-9]+)$/.exec(item.src)
    if (match) originals.set(path.join(outputRoot, match[1], match[2]), match[1])
  }
  for (const entry of unique) originals.set(entry.outputPath, path.basename(entry.outputDirectory))
  let checked = 0
  for (const [target, expected] of originals) {
    if (!(await pathExists(target))) continue
    checked += 1
    const actual = (await sha256File(target)).slice(0, 16)
    if (actual !== expected) {
      errors.push(`生成的原图 media/user/${expected}/${path.basename(target)} 与目录名的内容哈希不一致（实际为 ${actual}），可能被截断或改动。确认后删除这个生成目录，再运行 npm run media:import 重新生成。`)
    }
  }
  log(`校验：核对了 ${checked} 张已生成原图的内容哈希。`)
}

/** The CLI and durable task planner share exactly one Inbox scanner. Never writes. */
export const scanV2MediaImport = (options) => runV2MediaImport({ ...options, apply: false, capturePlan: true })

/**
 * The generated files of one content (D7): the original copied, the derivatives made by sharp, each written to a
 * temporary file, fsynced and published without overwriting; a final path that exists counts as published. Temporary
 * files other processes left in the directory are removed first. `entry`: { sourcePath, outputDirectory, outputPath,
 * derivatives: [{ outputPath, maxEdge, quality }] }. Shared by the V2 import and the new library's (3C-4c). The caller
 * holds the library lease.
 */
export async function publishGeneratedFiles(entry) {
  await mkdir(entry.outputDirectory, { recursive: true })
  await removeStaleTemporaries(entry.outputDirectory)
  if (!(await pathExists(entry.outputPath))) {
    await writeThenPublish(entry.outputPath, (temporary) => copyFile(entry.sourcePath, temporary, constants.COPYFILE_EXCL))
  }
  for (const derivative of entry.derivatives) {
    if (await pathExists(derivative.outputPath)) continue
    await writeThenPublish(derivative.outputPath, (temporary) => sharp(entry.sourcePath)
      .rotate()
      .resize({ width: derivative.maxEdge, height: derivative.maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: derivative.quality, effort: 4 })
      .toFile(temporary))
  }
}

/**
 * Caller validates the full plan and holds the library lease before entering. Folder bindings found by name are
 * pinned only when the caller passes `acceptFolderBindings` (batch 2A); otherwise nothing is written.
 */
export async function applyV2MediaImportScan({ privatePaths, scan, now = () => new Date(), log = () => {}, onStage = async () => {}, acceptFolderBindings = false }) {
  const { unique, planned, pins, items } = scan
  if (pins.length > 0 && !acceptFolderBindings) {
    throw Object.assign(new Error('E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED'), { code: 'E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED' })
  }
  const inboxRoot = privatePaths.inboxRoot
  const relative = (filePath) => path.relative(inboxRoot, filePath)
  const generatedAt = now().toISOString()
  const catalog = mediaCatalogFileOf(items, generatedAt)
  for (const entry of unique) await publishGeneratedFiles(entry)
  await onStage('generated')

  // RFC ID-6：已确认的按名称（或旧 country.json）匹配的文件夹写入 place.json，此后按 id 解析、不再按名字重新匹配。
  // 已有 place.json 的文件夹不在 pins 里，不动。
  for (const pin of pins) await atomicJsonWrite(path.join(pin.directory, 'place.json'), placeConfigOf(pin.placeId))
  await onStage('pins')
  if (pins.length > 0) {
    log(`\n已确认 ${pins.length} 个按名称匹配的文件夹绑定，写入 place.json，固定为地点 id：`)
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
