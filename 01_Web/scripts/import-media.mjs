/**
 * `npm run media:check`（预检）与 `npm run media:import`（加 --apply）的入口（RFC-LOC-1 PR5a 规格 §4.3）：运行 V2 导入器
 * （./v2-media-import.mjs）；本地编辑器（local-editor-plugin.mjs 的 runImporter）以子进程运行本文件。私人目录有没迁移的
 * 旧数据时（./legacy-data.mjs）拒绝运行，退出码 2，不读、不写任何数据文件。私人根是新库时（3C-4c）交给
 * ./store-media-cli.mjs（只读的 media:check、--reread、--reimport）。退出码：0 完成；1 有问题或读写失败；2 旧数据没有迁移，或待确认的
 * 文件夹绑定没加 --accept-folder-bindings（2A）。
 */
import { isLegacyUnmigrated, LEGACY_UNMIGRATED_IMPORT_MESSAGE, legacyDataStateOf } from './legacy-data.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { runV2MediaImport } from './v2-media-import.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { privateDataSource } from './private-data-source.mjs'

const privatePaths = getPrivatePaths()
const apply = process.argv.includes('--apply')
// 第 1 批 D7：`npm run media:check -- --verify` 对已生成的原图核对内容哈希，只报告不一致。
// 第 2 批 D6：--verify 时还核对已完成媒体任务的凭据所记录的文件（读取任务列表不再算哈希），只提醒，不影响退出码。
const verify = process.argv.includes('--verify')

try {
  if (isLegacyUnmigrated(legacyDataStateOf(privatePaths))) {
    console.error(`[import-media] ${LEGACY_UNMIGRATED_IMPORT_MESSAGE}`)
    process.exitCode = 2
  } else if (privateDataSource(privatePaths) === 'store') {
    const { runStoreMediaCli } = await import('./store-media-cli.mjs')
    process.exitCode = await runStoreMediaCli({ privatePaths, argv: process.argv.slice(2), leaseToken: process.env.STARMAP_LIBRARY_LEASE })
  } else {
    process.exitCode = await withLibraryOperation(privatePaths, async () => {
      if (apply) await assertMediaJobsClear(privatePaths)
      if (verify) await (await import('./media-job-service.mjs')).reportMediaJobReceipts(privatePaths)
      return runV2MediaImport({ privatePaths, apply, verify, acceptFolderBindings: process.argv.includes('--accept-folder-bindings') })
    }, { leaseToken: process.env.STARMAP_LIBRARY_LEASE })
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
