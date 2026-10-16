/**
 * `npm run store:upgrade` (3C-4c, design v2 §2): upgrade the new library of a private root to the current store format,
 * in place. A store of an older format (format 1: before the media registry) opens with E_STORE_UPGRADE_REQUIRED, and
 * the App shows that error with this command; nothing upgrades a store by itself.
 *
 * - Under the library lease (store-host.mjs upgradeStoreFile): the old format is checked exactly (schema, store_meta,
 *   quick_check), the rows are read, `prepare` returns what to seed, and one transaction adds the new tables, writes the
 *   seed and raises the version. Any failure leaves the file at its old format.
 * - Afterwards the full check (checkStoreFile: quick_check, Core's validation, the media registry) runs on the result.
 * - A store already at the current format is left alone (exit 0).
 *
 * Messages carry codes, counts and the private root's path, never values. Exit codes: 0 done or nothing to do, 1 refused
 * or failed.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPrivatePaths } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { STORE_FORMAT_VERSION, checkStoreFile, upgradeStoreFile } from './store-host.mjs'
import { StoreToolError } from './store-migrate.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

/**
 * Upgrade the store of `privatePaths`. `prepare({ state, revision })` returns the media block to seed (or undefined);
 * `now` (a function returning an ISO time) and `requestId` are injectable (tests). Resolves { result, check, lines };
 * a refusal throws StoreToolError, and a failed check after the upgrade does too (the upgrade itself is then committed).
 */
export async function upgradeStore(privatePaths, { prepare, now, requestId = uuidv7() } = {}) {
  if (privateDataSource(privatePaths) !== 'store') {
    throw new StoreToolError('E_NOT_STORE_MODE', ['这个私人根没有 data/store/world.sqlite（不是新库模式），没有可以升级的新库。'])
  }
  const file = storeFileOf(privatePaths)
  const result = await upgradeStoreFile(file, { privatePaths, policy: OFFICIAL_POLICY, requestId, prepare, ...(now ? { now } : {}) })
  if (!result.upgraded) {
    return { result, check: undefined, lines: [`新库已经是当前的存储格式（${STORE_FORMAT_VERSION}），没有改动。`] }
  }
  const check = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
  if (!check.ok) {
    throw new StoreToolError('E_UPGRADE_CHECK', [`升级已经提交（格式 ${result.fromVersion} → ${result.toVersion}），但之后的全量检查没有通过：`, ...check.problems])
  }
  const media = result.receipt.media ?? {}
  return {
    result, check,
    lines: [
      `已把新库从存储格式 ${result.fromVersion} 升级到 ${result.toVersion}（修订号 ${result.revision} 不变）。`,
      `媒体登记：文件 ${media.files ?? 0} 条，资产关联 ${media.assetFiles ?? 0} 条，来源 ${media.sources ?? 0} 条。`,
      '全量检查通过。',
    ],
  }
}

/** The command line: no arguments. Returns the exit code. */
export async function runStoreUpgradeCli(argv, { privatePaths = getPrivatePaths(), log = console.log, logError = console.error, prepare } = {}) {
  if (argv.length > 0) {
    logError('[store:upgrade] 不接受参数。用法：npm run store:upgrade')
    return 1
  }
  log(`StarMap store:upgrade\n私人根：${privatePaths.root}`)
  try {
    const { lines } = await upgradeStore(privatePaths, { prepare })
    for (const line of lines) log(line)
    return 0
  } catch (error) {
    if (error instanceof StoreToolError) {
      logError(`[store:upgrade] ${error.code}，没有完成：`)
      for (const problem of error.problems) logError(`  - ${problem}`)
    } else {
      logError(`[store:upgrade] 失败：${error?.code ?? error?.name ?? '未知错误'}${error?.path ? ` ${error.path}` : ''}。新库保持原来的格式。`)
    }
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runStoreUpgradeCli(process.argv.slice(2))
}
