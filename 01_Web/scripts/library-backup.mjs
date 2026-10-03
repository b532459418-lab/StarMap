/** Offline, allowlisted directory snapshots. Never overwrite or activate a private root. */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { V2_DATA_FILE_NAMES, getPrivatePaths } from './private-profile.mjs'
import { canonicalPath, isInsideDirectory, isAllowedPrivateOutput } from './private-output.mjs'
import { legacyDataStateOf, isLegacyUnmigrated } from './legacy-data.mjs'
import { completeForWrite, integrityProblems } from '../src/data/v2write/transaction.ts'

const FORMAT = 'starmap-local-backup'
const INDEX = 'data/v2/media-source-index.local.json'
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

async function walk(root, relative) {
  const info = await safeStat(root, relative)
  if (!info) return []
  if (info.isFile()) return [portablePath(relative)]
  const found = []
  for (const name of (await readdir(path.join(root, relative))).sort()) found.push(...await walk(root, relative ? `${relative}/${name}` : name))
  return found
}

function uniquePaths(values) {
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
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path.join(root, relative))) hash.update(chunk)
  return { path: relative, bytes: info.size, sha256: hash.digest('hex') }
}

async function inventory(root) {
  if (!(await safeStat(root))?.isDirectory()) fail('E_BACKUP_ROOT')
  const paths = []
  for (const prefix of ['data/v2', 'MediaInbox', 'media/user']) {
    for (const file of await walk(root, prefix)) {
      if (ignoredFile(file)) continue
      if (!allowedFile(file)) fail('E_BACKUP_UNSUPPORTED_FILE')
      paths.push(file)
    }
  }
  uniquePaths(paths)
  paths.sort()
  const entries = []
  for (const file of paths) entries.push(await digest(root, file))
  return entries
}

async function validateLibrary(root, entries) {
  const paths = new Set(entries.map(entry => entry.path))
  const raw = {}
  for (const [key, file] of Object.entries(dataPaths)) if (paths.has(file)) raw[key] = await json(root, file)
  const files = completeForWrite(raw, new Date('2000-01-01T00:00:00Z'))
  if (integrityProblems(files).length) fail('E_BACKUP_INTEGRITY')
  const requireFile = value => {
    portablePath(value)
    if (!allowedFile(value) || !paths.has(value)) fail('E_BACKUP_MEDIA_MISSING')
  }
  for (const item of files.media.items) {
    for (const src of [item.src, ...Object.values(item.variants ?? {}).map(variant => variant.src)]) {
      if (typeof src !== 'string' || !src.startsWith('/media/user/')) fail('E_BACKUP_MEDIA_PATH')
      requireFile(src.slice(1))
    }
  }
  const warnings = []
  if (paths.has(INDEX)) {
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
  return {
    places: files.places.places.length, travelRecords: files.travel.records.length,
    wantToGo: files.wantToGo.items.length, mediaItems: files.media.items.length,
    files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), warnings,
  }
}

function destination(root, target) {
  const environment = { STARMAP_PRIVATE_ROOT: root }
  if (!isAllowedPrivateOutput(root, environment) || !isAllowedPrivateOutput(target, environment)) fail('E_BACKUP_PRIVATE_OUTPUT')
  if (isInsideDirectory(target, root) || isInsideDirectory(root, target)) fail('E_BACKUP_OVERLAP')
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
