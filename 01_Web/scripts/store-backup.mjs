/**
 * Backup and restore of the new library (3C-3, design 3B §5.2 and §7). Since 3C-4b a backup holds the media too. The
 * export as V2 (`npm run store:export-v2`, design 3B §8) is in the compat directory since 3C-5 E
 * (./compat/store-export-v2.mjs).
 *
 * - `npm run store:backup -- --out <new directory>`:
 *   1. under the library lease: no unfinished media task (assertMediaJobsClear), quick_check (checkIntegrity), a
 *      `VACUUM INTO` snapshot `world.sqlite`, and the list of media files: `MediaInbox/` and `media/user/`, with the
 *      rules of `npm run backup` (./library-backup.mjs: the allowlist, the ignored files, portablePath; a file outside
 *      the allowlist refuses the backup). Since 3C-4c the V2 media source index (`data/v2/media-source-index.local.json`)
 *      is left out: the store's media registry replaced it, and it goes stale once the new library imports or deletes;
 *   2. the lease is released, so ordinary edits go on; deletions queued in `pending_file_ops` wait meanwhile (design
 *      §5.2 step 3: the mark under `operations/store-backup/`, see mediaCopyInProgress; ./media-file-ops.mjs);
 *   3. every media file is hashed (SHA-256), copied into `payload/` and the copy hashed again (the copy check of
 *      `npm run backup`); then the snapshot's media references are checked against the copies (every original and
 *      variant of the projection, every folder pin names a place) and so is its media registry (checkRegistryFiles:
 *      every generated file it records is copied with the SHA-256 it records);
 *   4. `manifest.json` (format, library id, revision, row counts, the snapshot's size and SHA-256, and the size and
 *      SHA-256 of every media file) and finally `COMPLETE.json` (the manifest's SHA-256).
 *   The directory is created exclusively: an existing one is refused. Any failure removes it again.
 * - `npm run store:restore -- --from <backup> --to <new private root>`: checks the completion mark, both hashes and the
 *   media list (no file outside it, no path outside the media folders), creates `<new root>/data/store/world.sqlite`
 *   and copies every media file, checking each copy against its SHA-256 in the manifest; records in store_meta which
 *   backup it came from (one layer, replacing any earlier one), then runs `PRAGMA integrity_check`, the full check
 *   (readFormalState and the host's own tables) and the media references. The new root must not exist: a restore never
 *   overwrites anything. Any failure, a single media file included, removes the new root again. A backup of 3C-3
 *   (format version 1, database only) is still restored, without media. After a restore the media registry and the
 *   media files correspond (checkRegistryFiles, 3C-4c); a backup of 3C-4b (a format-1 store with the media source index)
 *   is upgraded and its registry seeded from the restored files and index.
 *
 * Every output is private data: it may only go inside the private root or outside this repository
 * (./private-output.mjs, the gate of the baseline tool). Messages carry codes, counts, ids and output paths, never values
 * (media paths name places: they are never printed). Exit codes: 0 done, 1 refused or failed.
 */
import { createHash } from 'node:crypto'
import { constants, createReadStream, lstatSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MEDIA_SOURCE_INDEX, checkMediaReferences, isMediaBackupPath, mediaFilePaths, uniquePaths,
} from './library-backup.mjs'
import { sha256File } from './file-hash.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { isAllowedPrivateOutput, mayBeInsideDirectory } from './private-output.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { StoreToolError } from './store-tool-error.mjs'
import { projectStoreToCanonical } from '../src/data/store/projectCanonical.ts'
import { openStore } from './store-host.mjs'
import { upgradeStore } from './store-upgrade.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

export const BACKUP_FORMAT = 'starmap.store-backup'
/** 2 since 3C-4b (with media). Restore also reads version 1 (3C-3: the database only). */
export const BACKUP_FORMAT_VERSION = 2
const READABLE_VERSIONS = Object.freeze([1, 2])
/** The entries of a backup directory: the snapshot, the manifest, the completion mark and the media copies (`payload/`). */
export const BACKUP_FILES = Object.freeze({ store: 'world.sqlite', manifest: 'manifest.json', complete: 'COMPLETE.json', media: 'payload' })
/** What a backup leaves out (written into the manifest and the documentation). */
export const BACKUP_EXCLUDES = Object.freeze(['config', 'data/v2 (the V2 files and the media source index of V2 mode; the media registry is in the store)', 'operations'])
/** At most this many media files in one backup (the limit of `npm run backup`). */
export const MEDIA_FILE_LIMIT = 100_000
/** Where a backup marks that it is copying media (design 3B §5.2 step 3): `<private root>/operations/store-backup/<backup id>.json`. */
export const MEDIA_COPY_MARK_SEGMENTS = Object.freeze(['operations', 'store-backup'])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const missing = (error) => error?.code === 'ENOENT'
const SHA256 = /^[a-f0-9]{64}$/

/** The privacy gate and "must not exist" for an output path; returns the absolute path. */
export function newOutput(target, label) {
  if (typeof target !== 'string' || !target.trim()) throw new StoreToolError('E_ARGUMENT', [`缺少 ${label}。`])
  const resolved = path.resolve(target)
  if (!isAllowedPrivateOutput(resolved)) {
    throw new StoreToolError('E_PRIVATE_OUTPUT', [`${resolved} 在 Git 仓库之内（且不在私人根之内）。私人数据只能写到私人根之内或仓库之外。`])
  }
  try { lstatSync(resolved) } catch (error) {
    if (missing(error)) return resolved
    throw error
  }
  throw new StoreToolError('E_TARGET_EXISTS', [`${resolved} 已经存在。这个命令只写到一个新的位置，从不覆盖。`])
}

/** Create `directory` exclusively (its parent may be created); EEXIST is the refusal "already exists". */
export async function createExclusive(directory) {
  await mkdir(path.dirname(directory), { recursive: true })
  try { await mkdir(directory) } catch (error) {
    if (error?.code === 'EEXIST') throw new StoreToolError('E_TARGET_EXISTS', [`${directory} 已经存在。`])
    throw error
  }
}

/** Write a JSON file exclusively and fsync it. */
export async function writeJsonExclusive(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
}

/** fsync a file that something else wrote (the snapshot, a copy). */
async function syncFile(file) {
  const handle = await open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

export function requireStoreMode(privatePaths) {
  if (privateDataSource(privatePaths) !== 'store') {
    throw new StoreToolError('E_NOT_STORE_MODE', ['这个私人根没有 data/store/world.sqlite（不是新库模式），没有可以处理的新库。'])
  }
}

/** Open the store read-only; an open diagnostic is a refusal. */
export function openReadOnly(file) {
  const handle = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
  if (handle.diagnostic) {
    const { code } = handle.diagnostic
    void handle.close()
    throw new StoreToolError(code, [`新库没有通过打开检查（${code}）。`])
  }
  return handle
}

/**
 * What the media references of a store are checked against (checkMediaReferences of ./library-backup.mjs): the media
 * items and the places of its official view, in the shape of the V2 files that function reads (3C-5 E: before, the V2
 * files of the projection, whose media items and places are these).
 */
const mediaReferencesOf = (rows) => {
  const { canonical } = projectStoreToCanonical(rows, { source: 'local', track: false, freeze: false })
  return { media: canonical.media, places: { places: canonical.places } }
}

/** The media references of a store's rows, and its media registry. */
async function projectedFiles(file) {
  const handle = openReadOnly(file)
  try { return { files: mediaReferencesOf(handle.readRowsUnchecked()), registry: handle.mediaRegistry() } } finally { await handle.close() }
}

const CONTENT_DIRECTORY = /^media\/user\/[0-9a-f]{16}$/

/**
 * The media registry against media files (3C-4c): every generated file of every registered content is among `entries`
 * ({ path, sha256 }: a backup's copies, or a restored root's files, both checked against the manifest) with the SHA-256
 * the registry recorded. A content whose directory a queued deletion removes is skipped. Content-addressed directories
 * no registry row names (an interrupted import leaves them) are counted in a warning. A mismatch is
 * E_BACKUP_MEDIA_REGISTRY. Returns the warnings.
 */
export function checkRegistryFiles(registry, entries) {
  const copies = new Map(entries.map((entry) => [entry.path, entry.sha256]))
  const leaving = new Set(registry.pendingFileOps.filter((op) => op.kind === 'delete-generated').map((op) => op.target))
  let broken = 0
  for (const file of registry.files) {
    if (leaving.has(file.directory)) continue
    for (const output of file.outputs) if (copies.get(`${file.directory}/${output.name}`) !== output.sha256) broken++
  }
  if (broken) throw new StoreToolError('E_BACKUP_MEDIA_REGISTRY', [`新库媒体登记的 ${broken} 个生成文件不在媒体目录里，或者内容与登记不一致。`])
  const registered = new Set(registry.files.map((file) => file.directory))
  const directories = new Set([...copies.keys()].map((file) => file.split('/').slice(0, 3).join('/')).filter((directory) => CONTENT_DIRECTORY.test(directory)))
  const unregistered = [...directories].filter((directory) => !registered.has(directory)).length
  return unregistered ? [`MEDIA_UNREGISTERED: ${unregistered} content-addressed directories have no registry row (an interrupted import leaves them; library:recover lists them).`] : []
}

/** What a media failure of ./library-backup.mjs (an Error whose message is its code) means here. Never names a file. */
const MEDIA_PROBLEMS = Object.freeze({
  E_BACKUP_UNSUPPORTED_FILE: 'MediaInbox/ 或 media/user/ 里有白名单之外的文件（与 npm run backup 相同的规则）。',
  E_BACKUP_LINK: '媒体目录里有符号链接、目录联接或特殊文件。',
  E_BACKUP_PATH: '媒体目录里有不可移植的文件名或路径。',
  E_BACKUP_COLLISION: '媒体目录里有只差大小写或 Unicode 规范化的同名文件。',
  E_BACKUP_ROOT: '私人根不是一个目录。',
  E_BACKUP_READ: '媒体目录读取失败。',
  E_BACKUP_JSON: '媒体源索引或投递箱的 place.json 不是有效的 JSON。',
  E_BACKUP_MEDIA_MISSING: '新库引用的媒体文件（或媒体源索引列出的原图）不在媒体目录里。',
  E_BACKUP_MEDIA_PATH: '新库里有不在 /media/user/ 之下的媒体路径。',
  E_BACKUP_SOURCE_INDEX: '媒体源索引的格式无效。',
  E_BACKUP_PIN: '投递箱里有 place.json 指向新库里没有的地点。',
  E_BACKUP_MISSING: '媒体文件在复制时不见了。',
  E_BACKUP_CHANGED: '媒体文件的复制与原文件的大小或 SHA-256 不一致。',
})
function mediaFailure(error) {
  const code = typeof error?.message === 'string' && Object.hasOwn(MEDIA_PROBLEMS, error.message) ? error.message : undefined
  return code ? new StoreToolError(code, [MEDIA_PROBLEMS[code]]) : error
}
/** `{ bytes, sha256 }` of a file, streamed. */
async function fileHash(file) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length }
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Copy one listed media file (`relative`, a portable path) from `sourceRoot` into `targetRoot`, exclusively, and
 * return { path, bytes, sha256 } of the copy: the hashing of `npm run backup` (SHA-256 of the file, and of the copy,
 * which must match) without its per-file path walk, because mediaFilePaths has just checked the tree (no link, no
 * junction). The source is lstat'ed once more: a link that appeared since is E_BACKUP_LINK. With `expected` (restore:
 * the manifest's entry) the copy must match it instead of the source's own hash. Failures are E_BACKUP_* errors as in
 * ./library-backup.mjs. `made` remembers the directories already created.
 */
async function copyMediaFile(sourceRoot, targetRoot, relative, made, expected) {
  const segments = relative.split('/')
  const source = path.join(sourceRoot, ...segments)
  const target = path.join(targetRoot, ...segments)
  let info
  try { info = await lstat(source) } catch (error) {
    if (missing(error)) throw new Error('E_BACKUP_MISSING', { cause: error })
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('E_BACKUP_LINK')
  const wanted = expected ?? await fileHash(source)
  const directory = path.dirname(target)
  if (!made.has(directory)) {
    await mkdir(directory, { recursive: true })
    made.add(directory)
  }
  await copyFile(source, target, constants.COPYFILE_EXCL)
  const copied = await fileHash(target)
  if (copied.bytes !== wanted.bytes || copied.sha256 !== wanted.sha256) throw new Error('E_BACKUP_CHANGED')
  return { path: relative, ...copied }
}

/** Run a media step of ./library-backup.mjs with its failures as StoreToolError. */
async function media(step) {
  try { return await step() } catch (error) { throw mediaFailure(error) }
}

// ---------------------------------------------------------------------------
// Pausing pending_file_ops deletions while media is copied (design 3B §5.2 step 3)
// ---------------------------------------------------------------------------

const markDirectory = (privatePaths) => path.join(privatePaths.root, ...MEDIA_COPY_MARK_SEGMENTS)

/**
 * Whether a backup is copying media out of this private root right now: a mark exists under
 * `operations/store-backup/`. This is the checkpoint for the deletions queued in `pending_file_ops` (design 3B §5.1 and
 * §5.2; the table has no deletion logic yet, it arrives with 3C-4c): before deleting a file, under the library lease,
 * that step must call this and keep every file while it is true. A mark left by a killed backup keeps deletions paused
 * until it is removed by hand: deleting nothing is the safe side.
 */
export async function mediaCopyInProgress(privatePaths) {
  try { return (await readdir(markDirectory(privatePaths))).some((name) => name.endsWith('.json')) } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** Write this backup's mark (deletions wait from now on); returns its removal. */
async function markMediaCopy(privatePaths, backupId, now) {
  await mkdir(markDirectory(privatePaths), { recursive: true })
  const mark = path.join(markDirectory(privatePaths), `${backupId}.json`)
  await writeJsonExclusive(mark, { format: `${BACKUP_FORMAT}.media-copy`, backupId, startedAt: now, pid: process.pid })
  return () => rm(mark, { force: true })
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * A backup inside the folders it copies (or the data folder) would copy itself. A refusal, so a name that merely begins
 * with `..` counts as inside (./path-containment.mjs `mayBeInside`).
 */
function refuseOverlap(privatePaths, target) {
  for (const directory of [privatePaths.inboxRoot, privatePaths.userMediaRoot, privatePaths.dataRoot]) {
    if (mayBeInsideDirectory(target, directory)) {
      throw new StoreToolError('E_TARGET_OVERLAP', [`${target} 在私人根的 ${path.relative(privatePaths.root, directory).split(path.sep).join('/')}/ 之内，备份会复制到自己。请换一个位置。`])
    }
  }
}

/**
 * `store:backup`: returns { out, manifest, lines }. `now` (ISO time) and `backupId` are injectable (tests);
 * `onMediaCopy` is called after the lease is released, before the first media file is copied (tests).
 * A failure removes the backup directory this call created.
 */
export async function backupStore(privatePaths, { out, now = new Date().toISOString(), backupId = uuidv7(), onMediaCopy } = {}) {
  const target = newOutput(out, '--out <新目录>')
  requireStoreMode(privatePaths)
  refuseOverlap(privatePaths, target)
  let created = false
  let unmark
  try {
    // 1. Under the lease: media tasks, quick_check, the snapshot, the mark.
    const { meta, tables } = await withLibraryOperation(privatePaths, async () => {
      try { await assertMediaJobsClear(privatePaths) } catch (error) {
        if (error?.code === 'E_MEDIA_JOB_PENDING') throw new StoreToolError('E_MEDIA_JOB_PENDING', ['这个私人库还有没有完成的媒体任务。请先完成或放弃它，再备份。'])
        throw error
      }
      await createExclusive(target)
      created = true
      const snapshot = path.join(target, BACKUP_FILES.store)
      const source = openReadOnly(storeFileOf(privatePaths))
      try {
        const integrity = source.checkIntegrity()
        if (!integrity.ok) throw new StoreToolError('E_STORE_CORRUPT', ['备份之前的 quick_check 没有通过，没有生成备份。请从更早的备份恢复。'])
        source.snapshotInto(snapshot)
      } finally { await source.close() }
      await syncFile(snapshot)
      const copy = openReadOnly(snapshot)
      let snapshotMeta, snapshotTables
      try {
        snapshotMeta = copy.meta()
        snapshotTables = copy.tableCounts()
      } finally { await copy.close() }
      unmark = await markMediaCopy(privatePaths, backupId, now)
      return { meta: snapshotMeta, tables: snapshotTables }
    })
    // 2.–3. The lease is released (ordinary edits go on); deletions wait for the mark, so every file the snapshot
    // refers to stays. List the media (files added since the snapshot are harmless extras), copy and check every file.
    await onMediaCopy?.()
    const mediaPaths = await media(() => mediaFilePaths(privatePaths.root, { sourceIndex: false }))
    if (mediaPaths.length > MEDIA_FILE_LIMIT) throw new StoreToolError('E_BACKUP_LIMIT', [`媒体文件超过 ${MEDIA_FILE_LIMIT} 个。`])
    const payload = path.join(target, BACKUP_FILES.media)
    await mkdir(payload)
    const entries = []
    const made = new Set()
    for (const relative of mediaPaths) entries.push(await media(() => copyMediaFile(privatePaths.root, payload, relative, made)))
    const { files, registry } = await projectedFiles(path.join(target, BACKUP_FILES.store))
    const warnings = [
      ...await media(() => checkMediaReferences(payload, new Set(mediaPaths), files, { outsideUserMedia: 'warn', sourceIndex: false })),
      ...checkRegistryFiles(registry, entries),
    ]
    await unmark()
    unmark = undefined
    // 4. The manifest, then the completion mark.
    const snapshotFile = path.join(target, BACKUP_FILES.store)
    const mediaBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    const manifest = {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, backupId, createdAt: now,
      store: { format: meta.format, formatVersion: meta.formatVersion, libraryId: meta.libraryId, revision: meta.revision },
      tables,
      files: { [BACKUP_FILES.store]: { bytes: (await stat(snapshotFile)).size, sha256: await sha256File(snapshotFile) } },
      media: { directory: BACKUP_FILES.media, count: entries.length, bytes: mediaBytes, warnings, entries },
      excludes: BACKUP_EXCLUDES,
    }
    await writeJsonExclusive(path.join(target, BACKUP_FILES.manifest), manifest)
    // The completion mark comes last: a backup without it is unfinished and restore refuses it.
    const manifestSha256 = await sha256File(path.join(target, BACKUP_FILES.manifest))
    await writeJsonExclusive(path.join(target, BACKUP_FILES.complete), { format: `${BACKUP_FORMAT}.complete`, backupId, manifestSha256 })
    return {
      out: target, manifest,
      lines: [
        `已备份到 ${target}`,
        `库 id ${meta.libraryId}，修订号 ${meta.revision}，${manifest.files[BACKUP_FILES.store].bytes} 字节，SHA-256 ${manifest.files[BACKUP_FILES.store].sha256}`,
        `媒体：${entries.length} 个文件，${mediaBytes} 字节（MediaInbox/ 与 media/user/），每个文件的 SHA-256 记在清单里；新库的媒体登记与生成文件一致。`,
        ...(warnings.length ? [`提醒：${warnings.join('；')}`] : []),
        `不包含：${BACKUP_EXCLUDES.join('、')}。`,
      ],
    }
  } catch (error) {
    if (unmark) await unmark().catch(() => {})
    if (created) await rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Every file under `directory` as sorted portable paths; a link or special file is refused. */
async function payloadFiles(directory) {
  const found = []
  async function walk(relative) {
    for (const item of await readdir(path.join(directory, ...relative.split('/').filter(Boolean)), { withFileTypes: true })) {
      const next = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) await walk(next)
      else if (item.isFile()) found.push(next)
      else throw new StoreToolError('E_BACKUP_MEDIA_FILES', ['备份的 payload/ 里有符号链接或特殊文件。'])
    }
  }
  const info = await lstat(directory).catch((error) => (missing(error) ? undefined : Promise.reject(error)))
  if (info === undefined) return undefined
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreToolError('E_BACKUP_MEDIA_FILES', ['备份的 payload 不是目录。'])
  await walk('')
  return found.sort()
}

/** The media section of a version 2 manifest, checked: entries with portable media paths, sizes and SHA-256, unique. */
function mediaEntriesOf(manifest) {
  const section = manifest.media
  const entries = section?.entries
  if (!plain(section) || section.directory !== BACKUP_FILES.media || !Array.isArray(entries) || entries.length > MEDIA_FILE_LIMIT
    || entries.some((entry) => !plain(entry) || !isMediaBackupPath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256))) {
    throw new StoreToolError('E_BACKUP_MANIFEST', ['清单的媒体列表无效：路径不在媒体目录的白名单之内，或者大小、SHA-256 的格式不对。'])
  }
  try { uniquePaths(entries.map((entry) => entry.path)) } catch {
    throw new StoreToolError('E_BACKUP_MANIFEST', ['清单的媒体列表有重复的路径（只差大小写也算）。'])
  }
  return entries
}

/**
 * The completion mark, the manifest, the snapshot hash and (version 2) the media list of a backup directory: no file
 * in `payload/` outside the list, none missing. Returns the manifest. The media bytes are checked while they are
 * copied (restoreStore).
 */
export async function verifyBackup(from) {
  const directory = path.resolve(from)
  const read = async (name) => {
    try { return await readFile(path.join(directory, name)) } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }
  const completeBytes = await read(BACKUP_FILES.complete)
  if (completeBytes === undefined) throw new StoreToolError('E_BACKUP_INCOMPLETE', [`${directory} 没有完成标记 ${BACKUP_FILES.complete}：备份没有完成，或者不是新库的备份。`])
  let complete, manifest
  try { complete = JSON.parse(completeBytes.toString('utf8')) } catch { complete = undefined }
  const manifestBytes = await read(BACKUP_FILES.manifest)
  if (!plain(complete) || complete.format !== `${BACKUP_FORMAT}.complete` || manifestBytes === undefined || sha256(manifestBytes) !== complete.manifestSha256) {
    throw new StoreToolError('E_BACKUP_MANIFEST', ['完成标记与清单不一致：清单缺失、被改动，或者完成标记无效。'])
  }
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { manifest = undefined }
  const entry = manifest?.files?.[BACKUP_FILES.store]
  if (!plain(manifest) || manifest.format !== BACKUP_FORMAT || !READABLE_VERSIONS.includes(manifest.formatVersion) || manifest.backupId !== complete.backupId
    || !plain(manifest.store) || !plain(entry) || typeof entry.sha256 !== 'string') {
    throw new StoreToolError('E_BACKUP_MANIFEST', ['清单的格式不是这个版本认识的新库备份。'])
  }
  const snapshot = await read(BACKUP_FILES.store)
  if (snapshot === undefined || snapshot.length !== entry.bytes || sha256(snapshot) !== entry.sha256) {
    throw new StoreToolError('E_BACKUP_HASH', [`${BACKUP_FILES.store} 缺失，或者大小、SHA-256 与清单不一致。`])
  }
  if (manifest.formatVersion >= 2) {
    const listed = mediaEntriesOf(manifest).map((item) => item.path).sort()
    const present = await payloadFiles(path.join(directory, BACKUP_FILES.media)) ?? []
    if (present.length !== listed.length || present.some((file, index) => file !== listed[index])) {
      throw new StoreToolError('E_BACKUP_MEDIA_FILES', [`payload/ 的文件与清单的媒体列表不一致（清单 ${listed.length} 个，实际 ${present.length} 个）。`])
    }
  }
  return manifest
}

/**
 * `store:restore`: returns { to, restoredFrom, lines }. The new root gets `data/store/world.sqlite` and the media of the
 * backup (MediaInbox/, media/user/ and the media source index), nothing else. `now` is injectable (tests).
 */
export async function restoreStore({ from, to, now = new Date().toISOString() } = {}) {
  if (typeof from !== 'string' || !from.trim()) throw new StoreToolError('E_ARGUMENT', ['缺少 --from <备份目录>。'])
  const root = newOutput(to, '--to <新私人根>')
  const manifest = await verifyBackup(from)
  const entries = manifest.formatVersion >= 2 ? manifest.media.entries : undefined
  await createExclusive(root)
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  const file = storeFileOf(paths)
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await copyFile(path.join(path.resolve(from), BACKUP_FILES.store), file, constants.COPYFILE_EXCL)
    await syncFile(file)
    if (await sha256File(file) !== manifest.files[BACKUP_FILES.store].sha256) throw new StoreToolError('E_BACKUP_HASH', ['复制后的文件与清单的 SHA-256 不一致。'])
    // Every media file, each copy checked against its SHA-256 in the manifest: one mismatch fails the whole restore.
    if (entries) {
      const made = new Set()
      try {
        for (const entry of entries) await copyMediaFile(path.join(path.resolve(from), BACKUP_FILES.media), root, entry.path, made, entry)
      } catch (error) {
        if (['E_BACKUP_CHANGED', 'E_BACKUP_MISSING'].includes(error?.message)) {
          throw new StoreToolError('E_BACKUP_HASH', ['有媒体文件的大小或 SHA-256 与清单不一致（或者缺失）。恢复没有完成。'])
        }
        throw mediaFailure(error)
      }
    }
    const restoredFrom = {
      backupId: manifest.backupId, backupCreatedAt: manifest.createdAt, libraryId: manifest.store.libraryId,
      revision: manifest.store.revision, sha256: manifest.files[BACKUP_FILES.store].sha256, restoredAt: now,
    }
    // 3C-4c: a backup of a format-1 store (before the media registry) is upgraded in the new root, its registry seeded
    // from the restored media (store:upgrade), before the checks below.
    const probe = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
    const upgradeRequired = probe.diagnostic?.code === 'E_STORE_UPGRADE_REQUIRED'
    await probe.close()
    if (upgradeRequired) await upgradeStore(paths, { now: () => now })
    const handle = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY, now: () => now })
    let problems = []
    let files, registry
    try {
      if (handle.diagnostic) throw new StoreToolError(handle.diagnostic.code, [`恢复出来的库没有通过打开检查（${handle.diagnostic.code}）。`])
      if (handle.meta().libraryId !== manifest.store.libraryId || handle.meta().revision !== manifest.store.revision) {
        throw new StoreToolError('E_BACKUP_MANIFEST', ['库 id 或修订号与清单不一致。'])
      }
      await handle.setRestoredFrom(restoredFrom)
      const integrity = handle.checkIntegrity({ full: true })
      problems = integrity.ok ? [...handle.check().problems] : [...integrity.problems]
      if (!problems.length && entries) {
        files = mediaReferencesOf(handle.readRowsUnchecked())
        registry = handle.mediaRegistry()
      }
    } finally { await handle.close() }
    if (problems.length) throw new StoreToolError('E_RESTORE_CHECK', problems)
    // A backup of 3C-4b still carries the V2 media source index: its sources are checked as before.
    const sourceIndex = entries?.some((entry) => entry.path === MEDIA_SOURCE_INDEX) ?? false
    if (entries) await media(() => checkMediaReferences(root, new Set(entries.map((entry) => entry.path)), files, { outsideUserMedia: 'warn', sourceIndex }))
    if (entries) checkRegistryFiles(registry, entries)
    const mediaBytes = entries?.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0
    return {
      to: root, restoredFrom,
      lines: [
        `已恢复到新私人根 ${root}`,
        `data/store/world.sqlite：库 id ${restoredFrom.libraryId}，修订号 ${restoredFrom.revision}；integrity_check 与全量校验通过。`,
        entries
          ? `媒体：${entries.length} 个文件，${mediaBytes} 字节，逐个核对了 SHA-256；新库引用的媒体都在，媒体登记与生成文件一致。`
          : '这是只含数据库的旧格式备份（3C-3），没有媒体：需要时自己复制 MediaInbox/ 与 media/user/。',
        '新私人根里没有 config/ 与 data/v2/ 的 V2 文件，需要时自己复制。用 STARMAP_PRIVATE_ROOT 指向它即可启用。',
      ],
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = Object.freeze({
  backup: 'npm run store:backup -- --out <新目录>',
  restore: 'npm run store:restore -- --from <备份目录> --to <新私人根>',
})
const OPTIONS = Object.freeze({ backup: ['--out'], restore: ['--from', '--to'] })

/** `--name value` pairs for `command`; anything else is a usage error. */
function parseOptions(command, argv) {
  const allowed = OPTIONS[command], values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1]
    if (!allowed.includes(name) || Object.hasOwn(values, name) || typeof value !== 'string' || value.startsWith('--')) return undefined
    values[name] = value
  }
  return allowed.every((name) => Object.hasOwn(values, name)) ? values : undefined
}

/** One of the two commands (`backup`, `restore`); returns the exit code. */
export async function runStoreBackupCli(command, argv, { privatePaths = getPrivatePaths(), log = console.log, logError = console.error } = {}) {
  const label = `store:${command}`
  if (!Object.hasOwn(USAGE, command)) {
    logError(`[store] 未知命令：${command}`)
    return 1
  }
  const options = parseOptions(command, argv)
  if (!options) {
    logError(`[${label}] 参数不对。用法：${USAGE[command]}`)
    return 1
  }
  try {
    let result
    if (command === 'backup') {
      log(`StarMap ${label}\n私人根：${privatePaths.root}`)
      result = await backupStore(privatePaths, { out: options['--out'] })
    } else {
      log(`StarMap ${label}`)
      result = await restoreStore({ from: options['--from'], to: options['--to'] })
    }
    for (const line of result.lines) log(line)
    return 0
  } catch (error) {
    if (error instanceof StoreToolError) {
      logError(`[${label}] ${error.code}，没有完成：`)
      for (const problem of error.problems) logError(`  - ${problem}`)
    } else {
      logError(`[${label}] 失败：${error?.code ?? error?.name ?? '未知错误'}${error?.path ? ` ${error.path}` : ''}。没有留下新的输出。`)
    }
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runStoreBackupCli(process.argv[2], process.argv.slice(3))
}
