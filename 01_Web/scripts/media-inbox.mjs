/**
 * The Inbox walk and the publisher of generated files (RFC-LOC-1 PR3b-3 spec §2.1–§2.3, batch 1 D7), shared by the new
 * library's media import (./media-scan.mjs, ./media-service.mjs) and the read-only V2 preview
 * (./compat/v2-media-import.mjs). 3C-5 E: moved here from that preview, which is in the compat directory now.
 *
 * - **The walk** (walkInbox): country folders, their city folders, then a city's `photos` and `drone` folders, in the
 *   sorted order of the old importer, whose rules it keeps (folder aliases, supported formats, sidecars). Reads only.
 * - **Publishing generated files** (publishGeneratedFiles, D7): the original copied and the derivatives made by sharp,
 *   each into a temporary file `.<final name>.<pid>.<uuid>.tmp` beside its final path, fsynced, then published without
 *   overwriting (`link` to the final path, then the temporary file removed; where the file system has no hard links,
 *   a rename after checking, under the library lease, that the final path does not exist). A final path that exists
 *   counts as published. An interruption leaves only temporary files, never a truncated final file; the next import
 *   removes those other processes left in its output directories before writing.
 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import {
  DRONE_FOLDER_ALIASES,
  IGNORED_CONTROL_EXTENSIONS,
  NEEDS_CONVERSION_EXTENSIONS,
  PHOTO_FOLDER_ALIASES,
  STILL_EXTENSIONS,
  VIDEO_EXTENSIONS,
  droneKindOf,
  metadataForFile,
  normalizeName,
  placeDisplayName,
  resolveCityFolder,
  resolveCountryFolder,
  resolveFileOverride,
  shouldPinFolder,
} from '../src/data/v2media/importPlan.ts'

export const toPosix = (value) => value.split(path.sep).join('/')

export const pathExists = async (target) => {
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

/** 导入器发布用的临时文件名 → `{ finalName, pid }`；不是这种名字为 undefined。 */
const publishTemporaryOf = (name) => {
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
/**
 * 3C-5 G: the Inbox folders of media without a place, at the top level: `_no-place`, or `_无地点` (compared like the
 * photos and drone folder names, after normalizeName). Inside, the layout of a city folder (`photos/`, `drone/`,
 * `media.json`).
 */
export const PLACELESS_FOLDER_NAMES = Object.freeze(['_no-place', '_无地点'])
const PLACELESS_FOLDER_KEYS = new Set(PLACELESS_FOLDER_NAMES.map((name) => normalizeName(name)))
export const isPlacelessFolder = (name) => name.startsWith('_') && PLACELESS_FOLDER_KEYS.has(normalizeName(name))

/**
 * Walk the Inbox: every country folder, its city folders, their photos and drone files (`onFile` per file, with its city
 * place). Top-level folders whose name starts with `_` are skipped, except, with `placeless` (3C-5 G, the new library's
 * scan), the folders of media without a place (isPlacelessFolder): their files come with `city: null` and no country
 * folder. Such a file cannot name a place in media.json (an error): to give it one, move it into a city folder.
 */
export async function walkInbox({ inboxRoot, index, errors, warnings, pins, onFile, placeless = false }) {
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
    // `city` null: a folder of media without a place (3C-5 G).
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
      let owner
      if (city === null) {
        const named = ['placeId', 'countryId', 'cityId'].some((key) => typeof fileMetadata?.[key] === 'string' && fileMetadata[key].trim())
        if (named) {
          errors.push(`${relative(filePath)} 在没有地点的文件夹里，media.json 不能给它指定地点；要有地点，请把它移到城市文件夹。`)
          continue
        }
        owner = { ok: true, place: null }
      } else owner = resolveFileOverride(index, city, fileMetadata, relative(filePath))
      if (!owner.ok) {
        errors.push(owner.error)
        continue
      }
      const { kind, unlabelled } = droneKindOf(path.basename(filePath), path.extname(filePath).toLowerCase(), fileMetadata)
      await onFile({ filePath, kind, unlabelled, city: owner.place, metadata: fileMetadata, countryRoot, cityRoot })
    }
  }

  const scanCity = async (cityRoot, country, city, countryRoot) => {
    const cityLabel = city === null ? path.basename(cityRoot) : `${placeDisplayName(country)}/${placeDisplayName(city)}`
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
    if (countryEntry.name.startsWith('_')) {
      // 3C-5 G: a folder of media without a place is scanned like a city folder without a city.
      if (placeless && isPlacelessFolder(countryEntry.name)) await scanCity(path.join(inboxRoot, countryEntry.name), null, null, null)
      continue
    }
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
 * The generated files of one content (D7): the original copied, the derivatives made by sharp, each written to a
 * temporary file, fsynced and published without overwriting; a final path that exists counts as published. Temporary
 * files other processes left in the directory are removed first. `entry`: { sourcePath, outputDirectory, outputPath,
 * derivatives: [{ outputPath, maxEdge, quality }] }. The new library's import uses it (3C-4c), and the test fixture that
 * writes a V2 import (./compat/v2-media-import.fixture.mjs, 3C-5 E). The caller holds the library lease.
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
