/**
 * The new library's scan of the Inbox (3C-4c, design v2 §3 step 2). It walks the Inbox with the importer's own rules
 * (walkInbox of ./media-inbox.mjs: the same folders, bindings, sidecars and messages) and returns one fact per media
 * file, without merging files of the same content (D2: each confirmed source is one record) and without covers.
 *
 * - The places come from the caller (3C-5 E: the official reader's places, in the official order; a migration's V2
 *   places file), never from `data/v2/`.
 * - Hashing: a path whose size and modification time match its scan cache row (media_scan_cache) reuses that SHA-256;
 *   every other file is hashed as a stream. Emptying the cache only makes the next scan hash again.
 * - Each fact carries a description digest: the place, kind and sidecar entry the scan resolves for the file. The
 *   planner compares it with the one recorded when the source was confirmed, to show a description that changed but is
 *   not applied (D1: the sidecar counts at the first import, or on an explicit re-read).
 * - Image checks (dimensions, the panorama ratio, the reminders) are not part of the scan: they matter only for files
 *   that become records, so describeMediaFile runs them for those files.
 *
 * Reads only; never writes.
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { sha256File } from './file-hash.mjs'
import { portablePath } from './library-backup.mjs'
import { INBOX_PREFIX, pathKeyOf } from './store-media-registry.mjs'
import { extensionProblemOf, unlabelledDroneWarning, walkInbox } from './media-inbox.mjs'
import {
  buildMediaItem, contentHashOf, createMediaPlaceIndex, generatedFilesOf, isLikelyEquirectangularPanorama, isStillMedia, orientedDimensions,
} from '../src/data/v2media/importPlan.ts'
import { jsonKey } from '../src/worldgraph/store/primitives.ts'

const toPosix = (value) => value.split(path.sep).join('/')
const isPortable = (value) => { try { portablePath(value); return true } catch { return false } }

/**
 * The reminders of a scan that block an import from the page (unresolved information and problems to handle; batch 2A:
 * folder bindings to confirm too). Moved here from the V2 editor importer (removed in 3C-4d); the media service
 * (./media-service.mjs) applies it to the scan's reminders.
 */
export const IMPORT_BLOCKING_PATTERN = /需要处理|缺少日期或分辨率|缺少日期、分辨率或有效坐标|无法读取|找不到国家|找不到城市|待确认的文件夹绑定/

/** A file or folder under the Inbox as a portable path `MediaInbox/…`. */
export const inboxPathOf = (inboxRoot, target) => `${INBOX_PREFIX}${toPosix(path.relative(inboxRoot, target))}`

/** The description a scan resolves for a file (place, kind, sidecar entry) as a SHA-256 of its canonical JSON. */
export const descriptionDigestOf = ({ placeId, kind, metadata }) => createHash('sha256')
  .update(jsonKey({ placeId, kind, metadata: metadata ?? {} })).digest('hex')

/**
 * Scan the Inbox of `privatePaths` against `places` (CanonicalPlace values: the official reader's places). `cache` is the scan cache
 * (`[{ pathKey, size, mtimeMs, sha256 }]`, media_scan_cache); `hashFile` is injectable (tests count it).
 * Resolves { facts, errors, warnings, pins, hashed }:
 * - facts: `{ path, pathKey, relativePath, absolutePath, size, mtimeMs, sha256, fromCache, extension, kind, unlabelled,
 *   placeId, metadata, originalFileName, countryFolder, cityFolder, descriptionDigest }` in walk order, one per file;
 * - errors and warnings: the importer's, for folders, control files and unsupported formats, plus a file whose path
 *   cannot be registered (not portable);
 * - pins: folder bindings found by name, `{ folder, directory, placeId, subtype, names, source }` (`folder` portable);
 * - hashed: how many files were hashed (the others came from the cache).
 */
export async function scanInbox({ privatePaths, places, cache = [], hashFile = sha256File }) {
  const inboxRoot = privatePaths.inboxRoot
  const errors = []
  const warnings = []
  const pins = []
  const facts = []
  let hashed = 0
  // 3C-5 E: the store's places, checked by Core when they were written (no V2 validation of a places file any more).
  const index = createMediaPlaceIndex(places)
  const cached = new Map(cache.map((row) => [row.pathKey, row]))
  await walkInbox({
    inboxRoot, index, errors, warnings, pins,
    onFile: async ({ filePath, kind, unlabelled, city, metadata, countryRoot, cityRoot }) => {
      const relativePath = toPosix(path.relative(inboxRoot, filePath))
      const extension = path.extname(filePath).toLowerCase()
      const problem = extensionProblemOf(relativePath, kind, extension)
      if (problem) {
        if (problem.error) errors.push(problem.error)
        else warnings.push(problem.warning)
        return
      }
      const pathValue = `${INBOX_PREFIX}${relativePath}`
      if (!isPortable(pathValue)) {
        errors.push(`${relativePath} 的文件名或路径无法登记（含有 Windows 不允许的字符、保留名或结尾的点与空格）。请改名后再导入。`)
        return
      }
      const info = await stat(filePath)
      const pathKey = pathKeyOf(pathValue)
      const hit = cached.get(pathKey)
      const fromCache = hit !== undefined && hit.size === info.size && hit.mtimeMs === info.mtimeMs
      let sha256 = hit?.sha256
      if (!fromCache) {
        sha256 = await hashFile(filePath)
        hashed += 1
      }
      const sidecar = metadata ?? {}
      facts.push(Object.freeze({
        path: pathValue, pathKey, relativePath, absolutePath: filePath, size: info.size, mtimeMs: info.mtimeMs, sha256, fromCache,
        extension, kind, unlabelled, placeId: city.id, metadata: sidecar, originalFileName: path.basename(filePath),
        countryFolder: inboxPathOf(inboxRoot, countryRoot), cityFolder: inboxPathOf(inboxRoot, cityRoot),
        descriptionDigest: descriptionDigestOf({ placeId: city.id, kind, metadata: sidecar }),
      }))
    },
  })
  return {
    facts, errors, warnings, hashed,
    pins: pins.map((pin) => ({ folder: inboxPathOf(inboxRoot, pin.directory), directory: pin.directory, placeId: pin.placeId, subtype: pin.subtype, names: pin.names, source: pin.source })),
  }
}

/** The scan cache rows of a scan's facts (`media_scan_cache` puts: path, size, modification time, SHA-256). */
export const scanCacheEntriesOf = (facts) => facts.map(({ path: pathValue, size, mtimeMs, sha256 }) => ({ op: 'put', path: pathValue, size, mtimeMs, sha256 }))

/**
 * What a fact becomes as a record, with the importer's per-file checks (the same messages): the drone kind reminder,
 * the size reminder (advisory), the image's oriented dimensions (an unreadable image or a panorama that is not 2:1 is an
 * error), and the reminder for a drone file without date or resolution. Resolves { item, generated, errors, warnings,
 * advisoryWarnings }: `item` is the V2 media item the scan resolves (buildMediaItem; its `id` is not a record's id),
 * `generated` the generated files of its content (directory, original, derivatives); both absent after an error.
 * `readImage` is injectable (tests).
 */
export async function describeMediaFile(fact, { readImage = (file) => sharp(file).metadata() } = {}) {
  const errors = []
  const warnings = []
  const advisoryWarnings = []
  if (fact.unlabelled) warnings.push(unlabelledDroneWarning(fact.relativePath))
  const sizeInMiB = fact.size / 1024 / 1024
  const warningThreshold = fact.kind === 'panorama360' ? 40 : fact.kind === 'video' ? 120 : 16
  if (sizeInMiB > warningThreshold) {
    const warning = `${fact.relativePath} 为 ${sizeInMiB.toFixed(1)} MiB，建议 Agent 生成更轻的网页版本。`
    warnings.push(warning); advisoryWarnings.push(warning)
  }
  const still = isStillMedia(fact.kind, fact.extension)
  let dimensions
  if (still) {
    try {
      dimensions = orientedDimensions(await readImage(fact.absolutePath))
    } catch (error) {
      errors.push(`${fact.relativePath} 无法读取图片尺寸：${error.message}`)
      return { errors, warnings, advisoryWarnings }
    }
    if (!dimensions) {
      errors.push(`${fact.relativePath} 缺少有效的图片宽高。`)
      return { errors, warnings, advisoryWarnings }
    }
    if (fact.kind === 'panorama360' && !isLikelyEquirectangularPanorama(dimensions)) {
      errors.push(`${fact.relativePath} 是 ${dimensions.width} × ${dimensions.height}，不是常见的 2:1 等距柱状全景图；请在 media.json 中改为 aerialPhoto，或换用正确的 360 全景图。`)
      return { errors, warnings, advisoryWarnings }
    }
  }
  const hash = contentHashOf(fact.sha256)
  const item = buildMediaItem({ hash, extension: fact.extension, kind: fact.kind, placeId: fact.placeId, originalFileName: fact.originalFileName, dimensions, metadata: fact.metadata })
  if (item.status === 'needsMetadata') warnings.push(`${fact.relativePath} 缺少日期或分辨率；会进入目录，但暂不显示为 Drone Media。`)
  const files = generatedFilesOf(hash, fact.extension)
  return {
    item, errors, warnings, advisoryWarnings,
    generated: {
      directory: `media/user/${files.directory}`,
      original: `media/user/${files.original}`,
      derivatives: still ? files.derivatives.map((derivative) => ({ file: `media/user/${derivative.file}`, maxEdge: derivative.maxEdge, quality: derivative.quality })) : [],
    },
  }
}
