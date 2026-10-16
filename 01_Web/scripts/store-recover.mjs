/**
 * `npm run library:recover`（3C-2，设计 3B §5.2）：清理崩溃后残留的库操作锁。V2 模式与新库模式都能用。
 *
 * - 不带参数：只打印锁的持有者、创建时间与私人根的绑定，不改任何文件。
 * - `--confirm`：提示「请确认持有这个锁的进程已经不在了」，然后检查数据——
 *   新库模式（`data/store/world.sqlite` 存在）：quick_check 加 Core 的全量校验（store-host.mjs 的 checkStoreFile）；
 *   V2 模式：五个 V2 文件过 `validateV2Files`，再查悬空的地点引用（`integrityProblems`，缺的文件按空处理）。
 *   通过后推进一次 generation，再删除锁；不通过就保留锁，并列出问题。
 * - `--confirm --rebind`（3C-2b，设计 3B v1.1 §16.3）：私人根被移动过、同时又留着残留锁时，锁或库操作记录绑定的是旧路径，
 *   单用 `--confirm` 会拒绝，而 `library:rebind` 遇到锁也拒绝。加上 `--rebind`，先做与 `--confirm` 相同的数据检查，
 *   通过后把库操作记录与媒体待办身份重新绑定到当前私人根（同 library:rebind），再删除锁。
 * - 绝不按锁存在的时长或 PID 自动清理。退出码同 library:rebind：0 完成、不需要处理或只是预览；1 拒绝。
 * - 3C-4c，新库模式：锁处理完（或者本来就没有锁）之后，再只读列出媒体的残留——备份留下的「正在复制媒体」标记
 *   （operations/store-backup/*.json；有它时待删文件一直暂停）、pending_file_ops 里等待删除的文件、没有登记的按内容寻址
 *   生成目录（中断的导入留下的，只列出，不删）。加 --confirm 时（你已确认没有备份正在运行），在库租约下删除这些标记，
 *   再执行等待删除的文件（./media-file-ops.mjs）。
 *
 * 模式的判定与插件、store:* 工具共用 ./private-data-source.mjs（3C-3）。新库的全量校验用 App 的官方策略
 * （OFFICIAL_POLICY：两个官方图层的 systemKey），否则迁移来的库会因 E_SYSTEM_KEY 而检查不通过。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readdir, rm } from 'node:fs/promises'
import { readJson } from './json-file.mjs'
import { recoverLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import { MEDIA_COPY_MARK_SEGMENTS } from './store-backup.mjs'
import { V2_PRIVATE_FILE_KEYS, getPrivatePaths } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { checkStoreFile, openStore } from './store-host.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { completeForWrite, integrityProblems } from '../src/data/v2write/transaction.ts'

/** 'store' when `data/store/world.sqlite` exists, otherwise 'v2' (./private-data-source.mjs, shared with the plugin and the store tools). */
export const libraryMode = privateDataSource

/** V2 mode: the five files (missing ones count as empty) pass validateV2Files and have no dangling place reference. */
async function checkV2Files(privatePaths) {
  const files = {}
  const problems = []
  for (const key of V2_PRIVATE_FILE_KEYS) {
    try { files[key] = await readJson(privatePaths.v2FilePaths[key], undefined) } catch {
      problems.push(`${path.basename(privatePaths.v2FilePaths[key])}：无法读取或不是合法的 JSON`)
    }
  }
  if (problems.length > 0) return { problems }
  return { problems: integrityProblems(completeForWrite(files, new Date(0))) }
}

/**
 * The data check of `npm run library:recover --confirm` for the library's mode: { mode, problems, upgradeRequired? }. A
 * store of an older format is checked as that format (3C-4c), so a lock left on it can be cleared before store:upgrade.
 */
export async function checkLibraryData(privatePaths, { policy } = {}) {
  const mode = libraryMode(privatePaths)
  if (mode === 'store') {
    const { problems, upgradeRequired } = await checkStoreFile(storeFileOf(privatePaths), { policy })
    return { mode, problems, ...(upgradeRequired ? { upgradeRequired } : {}) }
  }
  return { mode, ...(await checkV2Files(privatePaths)) }
}

const MODE_LABELS = Object.freeze({ store: '新库（data/store/world.sqlite）', v2: 'V2（data/v2/）' })

const CONTENT_DIRECTORY = /^[0-9a-f]{16}$/

/**
 * 3C-4c: what media left behind in a new library, read-only: { marks (backup mark files), pendingFileOps, unregistered
 * (content-addressed directories under media/user/ that no registry row names) }, or { skipped } when the store cannot
 * be read as the current format.
 */
export async function mediaLeftovers(privatePaths, { policy } = {}) {
  const markDirectory = path.join(privatePaths.root, ...MEDIA_COPY_MARK_SEGMENTS)
  const names = async (directory) => { try { return await readdir(directory) } catch (error) { if (error?.code === 'ENOENT') return []; throw error } }
  const marks = (await names(markDirectory)).filter((name) => name.endsWith('.json')).sort()
  const handle = openStore(storeFileOf(privatePaths), { readOnly: true, policy })
  let registry
  try {
    if (handle.diagnostic) return { skipped: handle.diagnostic.code, marks }
    registry = handle.mediaRegistry()
  } finally { await handle.close() }
  const registered = new Set(registry.files.map((file) => file.directory))
  const unregistered = (await names(privatePaths.userMediaRoot)).filter((name) => CONTENT_DIRECTORY.test(name) && !registered.has(`media/user/${name}`)).sort()
  return { marks, pendingFileOps: registry.pendingFileOps, unregistered }
}

/** 3C-4c: list the media leftovers; with `confirm`, remove the backup marks and run the queued deletions. Exit code. */
async function recoverStoreMedia(privatePaths, { confirm, policy, log, logError }) {
  const found = await mediaLeftovers(privatePaths, { policy })
  if (found.skipped) {
    log(`\n媒体：新库没有通过打开检查（${found.skipped}），没有检查媒体的残留。`)
    return 0
  }
  const { marks, pendingFileOps, unregistered } = found
  log(`\n媒体：备份标记 ${marks.length} 个，等待删除的文件 ${pendingFileOps.length} 个，没有登记的生成目录 ${unregistered.length} 个。`)
  for (const mark of marks) log(`  备份标记：operations/store-backup/${mark}`)
  for (const directory of unregistered.slice(0, 20)) log(`  没有登记的生成目录：media/user/${directory}（中断的导入留下的；不会自动删除）`)
  if (unregistered.length > 20) log(`  ……另有 ${unregistered.length - 20} 个`)
  if (marks.length === 0 && pendingFileOps.length === 0) return 0
  if (!confirm) {
    log(marks.length
      ? '未加 --confirm，没有修改任何文件。确认没有备份正在运行（store:backup 已经结束或崩溃）之后运行 npm run library:recover -- --confirm：删除这些标记，再执行等待删除的文件。'
      : '未加 --confirm，没有修改任何文件。下一次媒体写入会执行等待删除的文件；也可以运行 npm run library:recover -- --confirm。')
    return 0
  }
  return withLibraryOperation(privatePaths, async (leaseToken) => {
    const markDirectory = path.join(privatePaths.root, ...MEDIA_COPY_MARK_SEGMENTS)
    for (const mark of marks) await rm(path.join(markDirectory, mark), { force: true })
    if (marks.length) log(`已删除 ${marks.length} 个备份标记。`)
    const { handleMediaStore } = await import('./media-service.mjs')
    const { runPendingFileOps } = await import('./media-file-ops.mjs')
    const handle = openStore(storeFileOf(privatePaths), { privatePaths, policy, writerSession: false })
    try {
      if (handle.diagnostic) {
        logError(`[library:recover] 新库没有通过打开检查（${handle.diagnostic.code}），没有执行等待删除的文件。`)
        return 1
      }
      const result = await runPendingFileOps({ privatePaths, store: handleMediaStore(handle), leaseToken })
      log(`等待删除的文件：删除了 ${result.deletedSources} 个源文件、${result.deletedDirectories} 个生成目录，取消 ${result.cancelled} 个（文件已被重新引用），${result.kept} 个暂时删不掉（被占用），下次再试。`)
      return 0
    } finally { await handle.close() }
  })
}

/**
 * `npm run library:recover`: see recoverLibraryOperation (library-operation-lock.mjs); then, for a new library, its media
 * leftovers (3C-4c, see recoverStoreMedia), also when there is no lock. Returns the exit code.
 */
export async function recoverLibrary(privatePaths, { confirm = false, rebind = false, policy, log = console.log, logError = console.error } = {}) {
  const code = await recoverLibraryOperation(privatePaths, {
    confirm, rebind, log, logError,
    modeLabel: MODE_LABELS[libraryMode(privatePaths)],
    checkData: async () => {
      const result = await checkLibraryData(privatePaths, { policy })
      if (result.upgradeRequired) log('新库是旧的存储格式：清除锁之后，请运行 npm run store:upgrade 升级。')
      return result
    },
  })
  if (code !== 0 || libraryMode(privatePaths) !== 'store') return code
  return recoverStoreMedia(privatePaths, { confirm, policy, log, logError })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await recoverLibrary(getPrivatePaths(), {
      confirm: process.argv.includes('--confirm'), rebind: process.argv.includes('--rebind'), policy: OFFICIAL_POLICY,
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
