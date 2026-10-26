/**
 * `npm run store:export-read-model -- --out <new file> [--public]` (3C-5A, design 3C-5 §1): the new library's read
 * model `starmap.read-model` (Core src/worldgraph/readModel/) written as one JSON file.
 *
 * - The store is opened read-only (another process may be writing it); the read model is the host's `readModel()`:
 *   every definition, fact and view row, without tombstones, review receipts or anything only the host keeps (receipts,
 *   op_log, id_map, pending file operations, the media registry with its Inbox paths).
 * - `--public`: only what may be published (src/data/store/publicReadModel.ts): entities whose visibility is public,
 *   what they and their entries refer to, and the official view's verbatim values only; media assets without their
 *   original file names. The map's display settings are published, so the coordinate of its default camera (the
 *   overview target) is public. The header (revision, origin) stays.
 * - Before anything is written, the result goes through the full check (`validateReadModel`, Core's own row rules).
 * - The output is checked like `store:export-v2`'s (./store-backup.mjs `newOutput`): inside the private root or outside
 *   this repository, and it must not exist. It is written exclusively, then synced.
 *
 * Messages carry counts, codes and the output path, never values. Exit codes: 0 done, 1 refused or failed.
 */
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPrivatePaths } from './private-profile.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { newOutput, openReadOnly, requireStoreMode } from './store-backup.mjs'
import { StoreToolError } from './store-tool-error.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { publicReadModelOf } from '../src/data/store/publicReadModel.ts'
import { validateReadModel } from '../src/worldgraph/readModel/check.ts'
import { READ_MODEL_TABLES } from '../src/worldgraph/readModel/types.ts'

const USAGE = 'npm run store:export-read-model -- --out <新文件> [--public]'

/** `{ out, publicOnly }` from the arguments, or undefined for a usage error. */
export function parseExportArguments(argv) {
  let out, publicOnly = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--public' && !publicOnly) publicOnly = true
    else if (arg === '--out' && out === undefined && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')) out = argv[++index]
    else return undefined
  }
  return out === undefined ? undefined : { out, publicOnly }
}

const counts = (model) => READ_MODEL_TABLES.map((table) => `${table} ${model[table].length}`).join('，')

/** Write the store's read model (public part with `publicOnly`) to the new file `out`. Returns { out, model, lines }. */
export async function exportStoreReadModel(privatePaths, { out, publicOnly = false } = {}) {
  const target = newOutput(out, '--out <新文件>')
  requireStoreMode(privatePaths)
  const handle = openReadOnly(storeFileOf(privatePaths))
  let full
  try { full = handle.readModel() } finally { await handle.close() }
  const model = publicOnly ? publicReadModelOf(full) : full
  try { validateReadModel(model, OFFICIAL_POLICY) } catch (error) {
    throw new StoreToolError('E_EXPORT_INVALID', [`导出的读模型没有通过完整校验（${error?.code ?? 'E_UNKNOWN'} ${error?.path ?? ''}）。`])
  }
  await mkdir(path.dirname(target), { recursive: true })
  const file = await open(target, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(model)}\n`, 'utf8')
    await file.sync()
  } catch (error) {
    await file.close().catch(() => {})
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
  await file.close()
  const lines = [`已导出修订号 ${model.revision} 的${publicOnly ? '公开' : '完整'}读模型到 ${target}`, `行数：${counts(model)}`]
  if (publicOnly) {
    const removed = READ_MODEL_TABLES.map((table) => [table, full[table].length - model[table].length]).filter(([, count]) => count > 0)
    lines.push(removed.length ? `没有公开、未导出：${removed.map(([table, count]) => `${table} ${count}`).join('，')}。` : '库里的全部内容都是公开的。')
    lines.push('公开导出包含地图默认镜头的坐标（overviewTarget）；媒体资产不带原始文件名。')
  }
  return { out: target, model, lines }
}

/** The command line; returns the exit code. */
export async function runExportReadModelCli(argv, { privatePaths = getPrivatePaths(), log = console.log, logError = console.error } = {}) {
  const label = 'store:export-read-model'
  const options = parseExportArguments(argv)
  if (!options) {
    logError(`[${label}] 参数不对。用法：${USAGE}`)
    return 1
  }
  try {
    log(`StarMap ${label}\n私人根：${privatePaths.root}`)
    const result = await exportStoreReadModel(privatePaths, options)
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
  process.exitCode = await runExportReadModelCli(process.argv.slice(2))
}
