/**
 * Offline, allowlisted directory snapshots. Never overwrite or activate a private root.
 *
 * The media rules (the allowlist, the ignore rules, portablePath, the reference checks) are shared with the new
 * library's backup (./store-backup.mjs, 3C-4b): mediaFilePaths, isMediaBackupPath, uniquePaths and
 * checkMediaReferences. A V2 backup behaves exactly as before. Since 3C-4c the new library's backup leaves the media
 * source index out (`sourceIndex: false`): its media registry lives in the store.
 */
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { V2_DATA_FILE_NAMES, getPrivatePaths } from './private-profile.mjs'
import { canonicalPath, isInsideDirectory, isAllowedPrivateOutput, mayBeInsideDirectory } from './private-output.mjs'
import { sha256File } from './file-hash.mjs'
import { legacyDataStateOf, isLegacyUnmigrated } from './legacy-data.mjs'
import { completeForWrite, integrityProblems } from '../src/data/canonical/v2Integrity.ts'

const FORMAT = 'starmap-local-backup'
const INDEX = 'data/v2/media-source-index.local.json'
/** The media source index of V2 mode (portable path). The new library's backup leaves it out (3C-4c). */
export const MEDIA_SOURCE_INDEX = INDEX
/** The media folders of a private root (portable paths). */
export const MEDIA_FOLDERS = Object.freeze(['MediaInbox', 'media/user'])
const dataPaths = Object.fromEntries(Object.entries(V2_DATA_FILE_NAMES).map(([key, name]) => [key, `data/v2/${name}`]))
const mediaExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.mp4', '.webm', '.heic', '.heif', '.tif', '.tiff', '.raw', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.mov'])
const fail = (code) => { throw new Error(code) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function portablePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) fail('E_BACKUP_PATH')
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"\\|?*]/.test(segment) || [...segment].some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) fail('E_BACKUP_PATH')
  return value
}

const allowedFile = value => {
  if (Object.values(dataPaths).includes(value) || value === INDEX) return true
  if (value.startsWith('media/user/')) return mediaExtensions.has(path.posix.extname(value).toLowerCase())
  if (!value.startsWith('MediaInbox/')) return false
  return mediaExtensions.has(path.posix.extname(value).toLowerCase()) || ['place.json', 'country.json', 'media.json'].includes(path.posix.basename(value))
}
const ignoredFile = value => ['.DS_Store', 'Thumbs.db', 'README.md', '.gitkeep'].includes(path.posix.basename(value)) || /\.(bak|tmp)$/i.test(value)

async function safeStat(root, relative = '') {
  const absoluteRoot = path.resolve(root)
  let target = absoluteRoot
  const segments = relative ? portablePath(relative).split('/') : []
  for (const segment of ['', ...segments]) {
    if (segment) target = path.join(target, segment)
    let info
    try { info = await lstat(target) } catch (error) { if (error.code === 'ENOENT') return undefined; fail('E_BACKUP_READ') }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail('E_BACKUP_LINK')
    if (target !== path.join(absoluteRoot, ...segments) && !info.isDirectory()) fail('E_BACKUP_PATH')
  }
  if (!isInsideDirectory(target, absoluteRoot)) fail('E_BACKUP_PATH')
  return lstat(target)
}

/**
 * Every file under `relative`, sorted by name per directory. The starting point is checked with safeStat (every
 * segment from the root); below it the walk only descends into directories it listed itself, so each entry needs no
 * more than its own type from readdir: a link, junction or special file is E_BACKUP_LINK, a name that is not portable
 * E_BACKUP_PATH (3C-4b: one safeStat per file made listing a real-scale library take minutes).
 */
async function walk(root, relative) {
  const info = await safeStat(root, relative)
  if (!info) return []
  if (info.isFile()) return [portablePath(relative)]
  const found = []
  const descend = async current => {
    let entries
    try { entries = await readdir(path.join(root, ...current.split('/').filter(Boolean)), { withFileTypes: true }) } catch { fail('E_BACKUP_READ') }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const next = current ? `${current}/${entry.name}` : entry.name
      portablePath(next)
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('E_BACKUP_LINK')
      if (entry.isDirectory()) await descend(next)
      else found.push(next)
    }
  }
  await descend(relative)
  return found
}

/** A media file a backup may hold: a portable path under MediaInbox/ or media/user/ on the allowlist, or the media source index. */
export const isMediaBackupPath = value => {
  try { portablePath(value) } catch { return false }
  return value === INDEX || (MEDIA_FOLDERS.some(prefix => value.startsWith(`${prefix}/`)) && allowedFile(value))
}

/** Portable paths that differ only by case or Unicode normalization are E_BACKUP_COLLISION. */
export function uniquePaths(values) {
  const seen = new Set()
  for (const value of values) {
    portablePath(value)
    const folded = value.normalize('NFC').toLowerCase()
    if (seen.has(folded)) fail('E_BACKUP_COLLISION')
    seen.add(folded)
  }
}

async function json(root, relative) {
  const info = await safeStat(root, relative)
  if (!info?.isFile() || info.size > 32 * 1024 * 1024) fail('E_BACKUP_JSON')
  try { return JSON.parse(await readFile(path.join(root, relative), 'utf8')) } catch { fail('E_BACKUP_JSON') }
}

async function digest(root, relative) {
  const info = await safeStat(root, relative)
  if (!info?.isFile()) fail('E_BACKUP_MISSING')
  return { path: relative, bytes: info.size, sha256: await sha256File(path.join(root, relative)) }
}

/** Every file under `prefixes`: ignored ones left out, anything outside the allowlist refused; unique and sorted. */
async function listFiles(root, prefixes) {
  if (!(await safeStat(root))?.isDirectory()) fail('E_BACKUP_ROOT')
  const paths = []
  for (const prefix of prefixes) {
    for (const file of await walk(root, prefix)) {
      if (ignoredFile(file)) continue
      if (!allowedFile(file)) fail('E_BACKUP_UNSUPPORTED_FILE')
      paths.push(file)
    }
  }
  uniquePaths(paths)
  return paths.sort()
}

async function inventory(root) {
  const entries = []
  for (const file of await listFiles(root, ['data/v2', ...MEDIA_FOLDERS])) entries.push(await digest(root, file))
  return entries
}

/**
 * The media files of a private root with the V2 backup's rules: MediaInbox/ and media/user/ (ignored files left out,
 * anything outside the allowlist refused) and the media source index when it exists, unless `sourceIndex` is false
 * (the new library, 3C-4c). Paths only (no hashing): sorted portable paths. Exported for ./store-backup.mjs.
 */
export async function mediaFilePaths(root, { sourceIndex = true } = {}) {
  const paths = await listFiles(root, MEDIA_FOLDERS)
  if (sourceIndex && (await safeStat(root, INDEX))?.isFile()) paths.push(INDEX)
  uniquePaths(paths)
  return paths.sort()
}

async function validateLibrary(root, entries) {
  const paths = new Set(entries.map(entry => entry.path))
  const raw = {}
  for (const [key, file] of Object.entries(dataPaths)) if (paths.has(file)) raw[key] = await json(root, file)
  const files = completeForWrite(raw, new Date('2000-01-01T00:00:00Z'))
  if (integrityProblems(files).length) fail('E_BACKUP_INTEGRITY')
  const warnings = await checkMediaReferences(root, paths, files)
  return {
    places: files.places.places.length, travelRecords: files.travel.records.length,
    wantToGo: files.wantToGo.items.length, mediaItems: files.media.items.length,
    files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), warnings,
  }
}

/**
 * The media references of a library against the files of a backup (`paths`, a Set of portable paths under `root`):
 * every original and variant of `files.media` (V2 files, or the new library's projection), every source of the media
 * source index, and every folder pin (`place.json`) naming a place of `files.places`. Returns the warnings; a broken
 * reference fails with its E_BACKUP_* code. Exported for ./store-backup.mjs.
 *
 * A media path outside /media/user/ is E_BACKUP_MEDIA_PATH (the V2 backup). With `outsideUserMedia: 'warn'` (the new
 * library's backup) it is not a file of the private root, so it is counted in a warning instead. With `sourceIndex:
 * false` (the new library since 3C-4c, whose registry is checked by ./store-backup.mjs) the index is not looked at.
 */
export async function checkMediaReferences(root, paths, files, { outsideUserMedia = 'refuse', sourceIndex = true } = {}) {
  const requireFile = value => {
    portablePath(value)
    if (!allowedFile(value) || !paths.has(value)) fail('E_BACKUP_MEDIA_MISSING')
  }
  let outside = 0
  for (const item of files.media.items) {
    for (const src of [item.src, ...Object.values(item.variants ?? {}).map(variant => variant.src)]) {
      if (typeof src !== 'string' || !src.startsWith('/media/user/')) {
        if (outsideUserMedia !== 'warn' || typeof src !== 'string') fail('E_BACKUP_MEDIA_PATH')
        outside++
        continue
      }
      requireFile(src.slice(1))
    }
  }
  const warnings = outside ? [`MEDIA_OUTSIDE_USER_MEDIA: ${outside} media paths are outside /media/user/ and are not files of the private root.`] : []
  if (!sourceIndex) {
    // The new library: its media registry, not the V2 index, says which Inbox files are sources.
  } else if (paths.has(INDEX)) {
    const index = await json(root, INDEX)
    if (!isObject(index) || index.schemaVersion !== 1 || !isObject(index.sourcesById) || typeof index.generatedAt !== 'string') fail('E_BACKUP_SOURCE_INDEX')
    for (const sources of Object.values(index.sourcesById)) {
      if (!Array.isArray(sources) || !sources.length) fail('E_BACKUP_SOURCE_INDEX')
      for (const source of sources) requireFile(`MediaInbox/${portablePath(source)}`)
    }
  } else if (files.media.items.length) warnings.push('SOURCE_INDEX_ABSENT: runtime media is preserved; import replay cannot be guaranteed.')
  // Imported folder pins must still refer to the same registry; pending media metadata is not guessed.
  const ids = new Set(files.places.places.map(place => place.id))
  for (const file of paths) if (file.startsWith('MediaInbox/') && path.posix.basename(file) === 'place.json') {
    const pin = await json(root, file)
    if (!isObject(pin) || !ids.has(pin.placeId)) fail('E_BACKUP_PIN')
  }
  return warnings
}

function destination(root, target) {
  const environment = { STARMAP_PRIVATE_ROOT: root }
  if (!isAllowedPrivateOutput(root, environment) || !isAllowedPrivateOutput(target, environment)) fail('E_BACKUP_PRIVATE_OUTPUT')
  // Refusal: a target that might be inside the library, or might contain it, overlaps (./path-containment.mjs).
  if (mayBeInsideDirectory(target, root) || mayBeInsideDirectory(root, target)) fail('E_BACKUP_OVERLAP')
  return canonicalPath(target)
}

async function claim(target) {
  try { await mkdir(target) } catch (error) { fail(error.code === 'EEXIST' ? 'E_BACKUP_TARGET_EXISTS' : 'E_BACKUP_TARGET_PARENT') }
}

async function copyEntries(source, target, entries) {
  for (const entry of entries) {
    await safeStat(source, entry.path)
    const output = path.join(target, entry.path)
    await mkdir(path.dirname(output), { recursive: true })
    await copyFile(path.join(source, entry.path), output, constants.COPYFILE_EXCL)
    const copied = await digest(target, entry.path)
    if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) fail('E_BACKUP_CHANGED')
  }
}

export async function createBackup(root, out) {
  const target = destination(root, out)
  const privatePaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  if (isLegacyUnmigrated(legacyDataStateOf(privatePaths))) fail('E_BACKUP_LEGACY')
  const entries = await inventory(root)
  const summary = await validateLibrary(root, entries)
  const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), entries }
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`
  if (entries.length > 100000 || Buffer.byteLength(serializedManifest) > 32 * 1024 * 1024) fail('E_BACKUP_LIMIT')
  await claim(target)
  const payload = path.join(target, 'payload')
  await mkdir(payload)
  await copyEntries(root, payload, entries)
  const after = await inventory(root)
  if (JSON.stringify(entries) !== JSON.stringify(after)) fail('E_BACKUP_CHANGED')
  await validateLibrary(payload, entries)
  // Manifest is the completion marker and is written only after all copies and checks.
  await writeFile(path.join(target, 'manifest.json'), serializedManifest, { flag: 'wx' })
  return { ...summary, status: 'backup-created' }
}

export async function inspectBackup(from) {
  if (!(await safeStat(from))?.isDirectory()) fail('E_BACKUP_ROOT')
  const manifest = await json(from, 'manifest.json')
  if (!isObject(manifest) || manifest.format !== FORMAT || manifest.version !== 1 || typeof manifest.createdAt !== 'string' || !Array.isArray(manifest.entries) || manifest.entries.length > 100000) fail('E_BACKUP_FORMAT')
  if ((await readdir(from)).some(name => !['manifest.json', 'payload'].includes(name))) fail('E_BACKUP_EXTRA_FILE')
  const entries = manifest.entries
  for (const entry of entries) {
    if (!isObject(entry) || !allowedFile(portablePath(entry.path)) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('E_BACKUP_MANIFEST')
  }
  uniquePaths(entries.map(entry => entry.path))
  const payload = path.join(from, 'payload')
  if (!(await safeStat(from, 'payload'))?.isDirectory()) fail('E_BACKUP_MISSING')
  const actual = await walk(payload, '')
  const expected = new Set(entries.map(entry => entry.path))
  if (actual.length !== entries.length || actual.some(file => !expected.has(file))) fail('E_BACKUP_EXTRA_FILE')
  for (const entry of entries) {
    const found = await digest(payload, entry.path)
    if (found.bytes !== entry.bytes || found.sha256 !== entry.sha256) fail('E_BACKUP_CHECKSUM')
  }
  return { manifest, summary: await validateLibrary(payload, entries) }
}

export async function restoreBackup(from, to, { apply = false } = {}) {
  const target = destination(from, to)
  // Even an empty existing directory is refused: no existing data is replaced.
  if (await safeStat(target)) fail('E_BACKUP_TARGET_EXISTS')
  if (!(await safeStat(path.dirname(target)))?.isDirectory()) fail('E_BACKUP_TARGET_PARENT')
  const { manifest, summary } = await inspectBackup(from)
  if (!apply) return { ...summary, status: 'restore-preview', mode: 'new-directory', activation: 'manual', originalLibrary: 'unchanged' }
  await claim(target)
  await copyEntries(path.join(from, 'payload'), target, manifest.entries)
  await validateLibrary(target, manifest.entries)
  await writeFile(path.join(target, 'restore-receipt.json'), `${JSON.stringify({ format: FORMAT, backupCreatedAt: manifest.createdAt, restoredAt: new Date().toISOString(), mode: 'new-directory' }, null, 2)}\n`, { flag: 'wx' })
  return { ...summary, status: 'restored-new-directory', activation: 'manual', originalLibrary: 'unchanged' }
}
