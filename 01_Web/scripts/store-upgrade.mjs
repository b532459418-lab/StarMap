/**
 * `npm run store:upgrade` (3C-4c, design v2 §2): upgrade the new library of a private root to the current store format,
 * in place. A store of an older format (format 1: before the media registry; format 2: before every added country had
 * its visit entry, 3C-5 E) opens with E_STORE_UPGRADE_REQUIRED, and the App shows that error with this command; nothing
 * upgrades a store by itself.
 *
 * - Under the library lease (store-host.mjs upgradeStoreFile): the old format is checked exactly (schema, store_meta,
 *   quick_check), the rows are read, and one transaction goes to the current format: from format 1 the media registry
 *   is seeded from the rows (./compat/media-seed.mjs, the same seeding as store:migrate) and its tables are added; from
 *   format 1 or 2 each added country that has only its evidence gets its visit entry
 *   (../src/data/store/storeFormatUpgrades.ts; the revision then moves on by one). Any failure leaves the file at its
 *   old format.
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
import { mediaRecordsOf, readMediaSourceIndex, seedMediaRegistry, seedReportLines } from './compat/media-seed.mjs'
import { STORE_FORMAT_VERSION, checkStoreFile, upgradeStoreFile } from './store-host.mjs'
import { StoreToolError } from './store-tool-error.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { storeFormatUpgradeCommands } from '../src/data/store/storeFormatUpgrades.ts'

/**
 * The seed of a format-1 store (3C-4c, design v2 §5): the media registry from the store's own rows and projection, the
 * Inbox, the media files and the V2 media source index (unchanged since the migration: format 1 never wrote media).
 * A problem refuses the upgrade before its transaction (E_MEDIA_SEED). A store of format 2 or later has its registry:
 * nothing to seed.
 */
export function seedFromStore(privatePaths, report = () => {}) {
  return async ({ state, fromVersion }) => {
    if (fromVersion >= 2) return undefined
    const { files } = projectToV2Files(state)
    const seeded = await seedMediaRegistry({
      privatePaths, places: files.places, media: files.media, records: mediaRecordsOf(state), index: await readMediaSourceIndex(privatePaths),
    })
    if (seeded.problems.length) throw new StoreToolError('E_MEDIA_SEED', seeded.problems)
    report(seeded.report)
    return seeded.media
  }
}

/**
 * Upgrade the store of `privatePaths`. `prepare({ state, revision, fromVersion })` returns the media block to seed
 * (default: seedFromStore); the commands are storeFormatUpgradeCommands' (new ids: UUIDv7, `newId` injectable); `now`
 * (a function returning an ISO time) and `requestId` are injectable (tests). Resolves { result, check, lines, seed };
 * a refusal throws StoreToolError, and a failed check after the upgrade does too (the upgrade itself is then committed).
 */
export async function upgradeStore(privatePaths, { prepare, now, newId = uuidv7, requestId = uuidv7() } = {}) {
  if (privateDataSource(privatePaths) !== 'store') {
    throw new StoreToolError('E_NOT_STORE_MODE', ['这个私人根没有 data/store/world.sqlite（不是新库模式），没有可以升级的新库。'])
  }
  const file = storeFileOf(privatePaths)
  let seed, created = []
  const result = await upgradeStoreFile(file, {
    privatePaths, policy: OFFICIAL_POLICY, requestId, prepare: prepare ?? seedFromStore(privatePaths, (report) => { seed = report }), ...(now ? { now } : {}),
    commands: ({ state, fromVersion }) => {
      created = storeFormatUpgradeCommands(state, fromVersion, { now: now ? now() : new Date().toISOString(), newId })
      return created
    },
  })
  if (!result.upgraded) {
    return { result, check: undefined, lines: [`新库已经是当前的存储格式（${STORE_FORMAT_VERSION}），没有改动。`] }
  }
  const check = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
  if (!check.ok) {
    throw new StoreToolError('E_UPGRADE_CHECK', [`升级已经提交（格式 ${result.fromVersion} → ${result.toVersion}），但之后的全量检查没有通过：`, ...check.problems])
  }
  const media = result.receipt.media ?? {}
  return {
    result, check, seed,
    lines: [
      result.revision === result.fromRevision
        ? `已把新库从存储格式 ${result.fromVersion} 升级到 ${result.toVersion}（修订号 ${result.revision} 不变）。`
        : `已把新库从存储格式 ${result.fromVersion} 升级到 ${result.toVersion}（修订号 ${result.fromRevision} → ${result.revision}）。`,
      ...(result.fromVersion < 2 ? (seed ? seedReportLines(seed) : [`媒体登记：文件 ${media.files ?? 0} 条，资产关联 ${media.assetFiles ?? 0} 条，来源 ${media.sources ?? 0} 条。`]) : []),
      ...(result.fromVersion < 3 ? [`手动添加的国家：${created.length} 个没有访问日期的国家补上了访问条目（官方视图从此按条目识别它们，3C-5 E）。`] : []),
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
