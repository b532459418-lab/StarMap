/**
 * Backup, restore and "export as V2" of the new library (3C-3, design 3B §5.2, §7 and §8). This batch covers the
 * database only; backups with media come in 3C-4.
 *
 * - `npm run store:backup -- --out <new directory>`: under the library lease, quick_check (checkIntegrity), a
 *   `VACUUM INTO` snapshot `world.sqlite`, then `manifest.json` (format, library id, revision, row counts, the file's
 *   size and SHA-256) and finally `COMPLETE.json` (the manifest's SHA-256). The directory is created exclusively: an
 *   existing one is refused.
 * - `npm run store:restore -- --from <backup> --to <new private root>`: checks the completion mark and both hashes,
 *   creates `<new root>/data/store/world.sqlite`, records in store_meta which backup it came from (one layer, replacing
 *   any earlier one), then runs `PRAGMA integrity_check` and the full check (readFormalState and the host's own tables).
 *   The new root must not exist: a restore never overwrites anything. Any failure removes the new root again.
 * - `npm run store:export-v2 -- --out <new directory>`: the store's projection written as the five V2 files (the way
 *   back to V2 mode after edits). Rows V2 cannot express are listed. The directory must not exist.
 *
 * Every output is private data: it may only go inside the private root or outside this repository
 * (./private-output.mjs, the gate of the baseline tool). Messages carry codes, counts, ids and paths, never values.
 * Exit codes: 0 done, 1 refused or failed.
 */
import { createHash } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { isAllowedPrivateOutput } from './private-output.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { STORE_FILE_SEGMENTS, privateDataSource, storeFileOf } from './private-data-source.mjs'
import { StoreToolError } from './store-migrate.mjs'
import { projectToV2Files, skippedCounts } from './store-projection.mjs'
import { openStore } from './store-host.mjs'
import { EMPTY_PLACES_GENERATED_AT } from '../src/data/canonical/canonicalForInputs.ts'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES, validateV2Files } from '../src/data/canonical/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

export const BACKUP_FORMAT = 'starmap.store-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_FILES = Object.freeze({ store: 'world.sqlite', manifest: 'manifest.json', complete: 'COMPLETE.json' })
/** What a backup of this batch leaves out (written into the manifest and the documentation). */
export const BACKUP_EXCLUDES = Object.freeze(['media', 'MediaInbox', 'config', 'data/v2', 'operations'])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashFile = async (file) => sha256(await readFile(file))
const missing = (error) => error?.code === 'ENOENT'

/** The privacy gate and "must not exist" for an output path; returns the absolute path. */
function newOutput(target, label) {
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
async function createExclusive(directory) {
  await mkdir(path.dirname(directory), { recursive: true })
  try { await mkdir(directory) } catch (error) {
    if (error?.code === 'EEXIST') throw new StoreToolError('E_TARGET_EXISTS', [`${directory} 已经存在。`])
    throw error
  }
}

/** Write a JSON file exclusively and fsync it. */
async function writeJsonExclusive(file, value) {
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

function requireStoreMode(privatePaths) {
  if (privateDataSource(privatePaths) !== 'store') {
    throw new StoreToolError('E_NOT_STORE_MODE', ['这个私人根没有 data/store/world.sqlite（不是新库模式），没有可以处理的新库。'])
  }
}

/** Open the store read-only; an open diagnostic is a refusal. */
function openReadOnly(file) {
  const handle = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
  if (handle.diagnostic) {
    const { code } = handle.diagnostic
    void handle.close()
    throw new StoreToolError(code, [`新库没有通过打开检查（${code}）。`])
  }
  return handle
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * `store:backup`: returns { out, manifest, lines }. `now` (ISO time) and `backupId` are injectable (tests).
 * A failure removes the backup directory this call created.
 */
export async function backupStore(privatePaths, { out, now = new Date().toISOString(), backupId = uuidv7() } = {}) {
  const target = newOutput(out, '--out <新目录>')
  requireStoreMode(privatePaths)
  return withLibraryOperation(privatePaths, async () => {
    await createExclusive(target)
    try {
      const snapshot = path.join(target, BACKUP_FILES.store)
      const source = openReadOnly(storeFileOf(privatePaths))
      try {
        const integrity = source.checkIntegrity()
        if (!integrity.ok) throw new StoreToolError('E_STORE_CORRUPT', ['备份之前的 quick_check 没有通过，没有生成备份。请从更早的备份恢复。'])
        source.snapshotInto(snapshot)
      } finally { await source.close() }
      await syncFile(snapshot)
      const copy = openReadOnly(snapshot)
      let meta, tables
      try {
        meta = copy.meta()
        tables = copy.tableCounts()
      } finally { await copy.close() }
      const manifest = {
        format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, backupId, createdAt: now,
        store: { format: meta.format, formatVersion: meta.formatVersion, libraryId: meta.libraryId, revision: meta.revision },
        tables,
        files: { [BACKUP_FILES.store]: { bytes: (await stat(snapshot)).size, sha256: await hashFile(snapshot) } },
        excludes: BACKUP_EXCLUDES,
      }
      await writeJsonExclusive(path.join(target, BACKUP_FILES.manifest), manifest)
      // The completion mark comes last: a backup without it is unfinished and restore refuses it.
      const manifestSha256 = await hashFile(path.join(target, BACKUP_FILES.manifest))
      await writeJsonExclusive(path.join(target, BACKUP_FILES.complete), { format: `${BACKUP_FORMAT}.complete`, backupId, manifestSha256 })
      return {
        out: target, manifest,
        lines: [
          `已备份到 ${target}`,
          `库 id ${meta.libraryId}，修订号 ${meta.revision}，${manifest.files[BACKUP_FILES.store].bytes} 字节，SHA-256 ${manifest.files[BACKUP_FILES.store].sha256}`,
          `不包含：${BACKUP_EXCLUDES.join('、')}（媒体备份在后续批次接入）。`,
        ],
      }
    } catch (error) {
      await rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      throw error
    }
  })
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The completion mark, the manifest and the snapshot hash of a backup directory; returns the manifest. */
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
  if (!plain(manifest) || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.backupId !== complete.backupId
    || !plain(manifest.store) || !plain(entry) || typeof entry.sha256 !== 'string') {
    throw new StoreToolError('E_BACKUP_MANIFEST', ['清单的格式不是这个版本认识的新库备份。'])
  }
  const snapshot = await read(BACKUP_FILES.store)
  if (snapshot === undefined || snapshot.length !== entry.bytes || sha256(snapshot) !== entry.sha256) {
    throw new StoreToolError('E_BACKUP_HASH', [`${BACKUP_FILES.store} 缺失，或者大小、SHA-256 与清单不一致。`])
  }
  return manifest
}

/**
 * `store:restore`: returns { to, restoredFrom, lines }. The new root gets `data/store/world.sqlite` only (no V2 files,
 * media or config). `now` is injectable (tests).
 */
export async function restoreStore({ from, to, now = new Date().toISOString() } = {}) {
  if (typeof from !== 'string' || !from.trim()) throw new StoreToolError('E_ARGUMENT', ['缺少 --from <备份目录>。'])
  const root = newOutput(to, '--to <新私人根>')
  const manifest = await verifyBackup(from)
  await createExclusive(root)
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  const file = storeFileOf(paths)
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await copyFile(path.join(path.resolve(from), BACKUP_FILES.store), file, constants.COPYFILE_EXCL)
    await syncFile(file)
    if (await hashFile(file) !== manifest.files[BACKUP_FILES.store].sha256) throw new StoreToolError('E_BACKUP_HASH', ['复制后的文件与清单的 SHA-256 不一致。'])
    const restoredFrom = {
      backupId: manifest.backupId, backupCreatedAt: manifest.createdAt, libraryId: manifest.store.libraryId,
      revision: manifest.store.revision, sha256: manifest.files[BACKUP_FILES.store].sha256, restoredAt: now,
    }
    const handle = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY, now: () => now })
    let problems = []
    try {
      if (handle.diagnostic) throw new StoreToolError(handle.diagnostic.code, [`恢复出来的库没有通过打开检查（${handle.diagnostic.code}）。`])
      if (handle.meta().libraryId !== manifest.store.libraryId || handle.meta().revision !== manifest.store.revision) {
        throw new StoreToolError('E_BACKUP_MANIFEST', ['库 id 或修订号与清单不一致。'])
      }
      await handle.setRestoredFrom(restoredFrom)
      const integrity = handle.checkIntegrity({ full: true })
      problems = integrity.ok ? [...handle.check().problems] : [...integrity.problems]
    } finally { await handle.close() }
    if (problems.length) throw new StoreToolError('E_RESTORE_CHECK', problems)
    return {
      to: root, restoredFrom,
      lines: [
        `已恢复到新私人根 ${root}`,
        `data/store/world.sqlite：库 id ${restoredFrom.libraryId}，修订号 ${restoredFrom.revision}；integrity_check 与全量校验通过。`,
        '新私人根里只有新库：config/、媒体与 data/v2/ 不在这个备份里，需要时自己复制。用 STARMAP_PRIVATE_ROOT 指向它即可启用。',
      ],
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Export as V2
// ---------------------------------------------------------------------------

/**
 * `store:export-v2`: the five V2 files of the store's projection in a new directory. Returns { out, files, skipped, lines }.
 * The rows come from readFormalState (the full check). A projection without file metadata of the places registry (no
 * `v2:import` source) gets the export time as its `generated_at` instead of the Unix epoch.
 */
export async function exportStoreV2(privatePaths, { out, now = new Date().toISOString() } = {}) {
  const target = newOutput(out, '--out <新目录>')
  requireStoreMode(privatePaths)
  const handle = openReadOnly(storeFileOf(privatePaths))
  let projected, revision
  try {
    const state = handle.readFormalState()
    revision = state.revision
    projected = projectToV2Files(state)
  } finally { await handle.close() }
  const { files, projection } = projected
  if (files.places.generated_at === EMPTY_PLACES_GENERATED_AT) files.places.generated_at = now
  const invalid = validateV2Files(files)
  if (invalid.length) throw new StoreToolError('E_EXPORT_INVALID', invalid.slice(0, 20).map((problem) => `${V2_FILE_NAMES[problem.file]} ${problem.path}：${problem.message}`))
  await createExclusive(target)
  try {
    for (const key of V2_FILE_KEYS) await writeJsonExclusive(path.join(target, V2_FILE_NAMES[key]), files[key])
  } catch (error) {
    await rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw error
  }
  const skipped = projection.skipped
  const lines = [`已导出修订号 ${revision} 的五个 V2 文件到 ${target}`]
  if (skipped.length) {
    lines.push(`V2 表达不了、没有导出的内容：${skipped.length} 行（${Object.entries(skippedCounts(skipped)).map(([table, count]) => `${table} ${count}`).join('，')}）。新库与它的备份里仍然保留：`)
    for (const row of skipped) lines.push(`  ${row.table} ${row.id}`)
  } else {
    lines.push('新库的全部内容都已导出，没有 V2 表达不了的内容。')
  }
  lines.push(`回到 V2 模式：停止开发服务器，把这五个文件放进 data/v2/，再把 ${STORE_FILE_SEGMENTS.join('/')} 移出私人根。`)
  return { out: target, files, skipped, lines }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = Object.freeze({
  backup: 'npm run store:backup -- --out <新目录>',
  restore: 'npm run store:restore -- --from <备份目录> --to <新私人根>',
  'export-v2': 'npm run store:export-v2 -- --out <新目录>',
})
const OPTIONS = Object.freeze({ backup: ['--out'], restore: ['--from', '--to'], 'export-v2': ['--out'] })

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

/** One of the three commands (`backup`, `restore`, `export-v2`); returns the exit code. */
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
    } else if (command === 'restore') {
      log(`StarMap ${label}`)
      result = await restoreStore({ from: options['--from'], to: options['--to'] })
    } else {
      log(`StarMap ${label}\n私人根：${privatePaths.root}`)
      result = await exportStoreV2(privatePaths, { out: options['--out'] })
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
