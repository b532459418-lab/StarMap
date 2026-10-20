/**
 * `npm run media:check`（预检）与 `npm run media:import`（加 --apply）的入口。3C-4d 起只有新库能导入：新库交给
 * ./store-media-cli.mjs；不是新库时（./private-data-source.mjs 的状态）media:check 只读运行 V2 的预检（不取库租约、不写任何
 * 文件），media:import 拒绝运行（退出码 2），说明先迁移或恢复。私人目录有没迁移的旧数据时（./legacy-data.mjs）同样拒绝。
 * 退出码：0 完成；1 有问题或读写失败；2 不能导入（旧数据、待迁移、需要恢复、还没有新库），或待确认项没有确认。
 */
import { isLegacyUnmigrated, LEGACY_UNMIGRATED_IMPORT_MESSAGE, legacyDataStateOf } from './legacy-data.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { privateDataState } from './private-data-source.mjs'
import { NOT_A_STORE_IMPORT_MESSAGES, runStoreMediaCli } from './store-media-cli.mjs'
import { runV2MediaImport } from './v2-media-import.mjs'

const privatePaths = getPrivatePaths()
const apply = process.argv.includes('--apply')
// 第 1 批 D7 / 第 2 批 D6：`npm run media:check -- --verify` 核对已生成的原图与任务凭据，只提醒，不影响退出码。
const verify = process.argv.includes('--verify')

try {
  const { state } = privateDataState(privatePaths)
  if (isLegacyUnmigrated(legacyDataStateOf(privatePaths))) {
    console.error(`[import-media] ${LEGACY_UNMIGRATED_IMPORT_MESSAGE}`)
    process.exitCode = 2
  } else if (state === 'store') {
    process.exitCode = await runStoreMediaCli({ privatePaths, argv: process.argv.slice(2), leaseToken: process.env.STARMAP_LIBRARY_LEASE })
  } else if (apply) {
    console.error(`[import-media] ${NOT_A_STORE_IMPORT_MESSAGES[state]}`)
    process.exitCode = 2
  } else {
    if (verify) await (await import('./media-job-service.mjs')).reportMediaJobReceipts(privatePaths)
    process.exitCode = await runV2MediaImport({ privatePaths, apply: false, verify, acceptFolderBindings: process.argv.includes('--accept-folder-bindings') })
    console.log(`\n${NOT_A_STORE_IMPORT_MESSAGES[state]}`)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
