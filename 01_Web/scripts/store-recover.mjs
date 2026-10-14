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
 *
 * 模式的判定与插件、store:* 工具共用 ./private-data-source.mjs（3C-3）。新库的全量校验用 App 的官方策略
 * （OFFICIAL_POLICY：两个官方图层的 systemKey），否则迁移来的库会因 E_SYSTEM_KEY 而检查不通过。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from './json-file.mjs'
import { recoverLibraryOperation } from './library-operation-lock.mjs'
import { V2_PRIVATE_FILE_KEYS, getPrivatePaths } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { checkStoreFile } from './store-host.mjs'
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

/** The data check of `npm run library:recover --confirm` for the library's mode: { mode, problems }. */
export async function checkLibraryData(privatePaths, { policy } = {}) {
  const mode = libraryMode(privatePaths)
  if (mode === 'store') return { mode, problems: (await checkStoreFile(storeFileOf(privatePaths), { policy })).problems }
  return { mode, ...(await checkV2Files(privatePaths)) }
}

const MODE_LABELS = Object.freeze({ store: '新库（data/store/world.sqlite）', v2: 'V2（data/v2/）' })

/** `npm run library:recover`: see recoverLibraryOperation (library-operation-lock.mjs). Returns the exit code. */
export function recoverLibrary(privatePaths, { confirm = false, rebind = false, policy, log, logError } = {}) {
  return recoverLibraryOperation(privatePaths, {
    confirm, rebind, log, logError,
    modeLabel: MODE_LABELS[libraryMode(privatePaths)],
    checkData: () => checkLibraryData(privatePaths, { policy }),
  })
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
