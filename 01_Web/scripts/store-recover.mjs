/**
 * `npm run library:recover`（3C-2，设计 3B §5.2）：清理崩溃后残留的库操作锁。V2 模式与新库模式都能用。
 *
 * - 不带参数：只打印锁的持有者、创建时间与私人根的绑定，不改任何文件。
 * - `--confirm`：提示「请确认持有这个锁的进程已经不在了」，然后检查数据——
 *   新库模式（`data/store/world.sqlite` 存在）：quick_check 加 Core 的全量校验（store-host.mjs 的 checkStoreFile）；
 *   V2 模式：五个 V2 文件过 `validateV2Files`，再查悬空的地点引用（`integrityProblems`，缺的文件按空处理）。
 *   通过后推进一次 generation，再删除锁；不通过就保留锁，并列出问题。
 * - 绝不按锁存在的时长或 PID 自动清理。退出码同 library:rebind：0 完成、不需要处理或只是预览；1 拒绝。
 *
 * 新库模式只在 3C-3 之后出现；本批只按正式路径判断模式，不接入私人根的读写。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from './json-file.mjs'
import { recoverLibraryOperation } from './library-operation-lock.mjs'
import { V2_PRIVATE_FILE_KEYS, getPrivatePaths } from './private-profile.mjs'
import { checkStoreFile, storePathFor } from './store-host.mjs'
import { completeForWrite, integrityProblems } from '../src/data/v2write/transaction.ts'

/** 'store' when the formal store file exists at its planned path, otherwise 'v2'. */
export const libraryMode = (privatePaths) => (existsSync(storePathFor(privatePaths.root)) ? 'store' : 'v2')

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
  if (mode === 'store') return { mode, problems: (await checkStoreFile(storePathFor(privatePaths.root), { policy })).problems }
  return { mode, ...(await checkV2Files(privatePaths)) }
}

const MODE_LABELS = Object.freeze({ store: '新库（data/store/world.sqlite）', v2: 'V2（data/v2/）' })

/** `npm run library:recover`: see recoverLibraryOperation (library-operation-lock.mjs). Returns the exit code. */
export function recoverLibrary(privatePaths, { confirm = false, policy, log, logError } = {}) {
  return recoverLibraryOperation(privatePaths, {
    confirm, log, logError,
    modeLabel: MODE_LABELS[libraryMode(privatePaths)],
    checkData: () => checkLibraryData(privatePaths, { policy }),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await recoverLibrary(getPrivatePaths(), { confirm: process.argv.includes('--confirm') })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
