/**
 * `npm run media:check`（预检）与 `npm run media:import`（加 --apply）的入口（RFC-LOC-1 PR5a 规格 §4.3）：
 * 运行 V2 导入器（./v2-media-import.mjs）。旧格式的导入器已删除；本地编辑器（local-editor-plugin.mjs 的 runImporter）
 * 以子进程运行本文件，所以文件名不变。
 *
 * 私人目录有没迁移的旧数据时（判定见 ./legacy-data.mjs）拒绝运行，退出码 2，不读、不写任何数据文件——否则 data/v2/
 * 被写出后，迁移工具的 --apply 会因为输出目录非空而拒绝运行。
 *
 * 退出码：0 完成（可能有提醒）；1 有需要处理的问题或读写失败；2 旧数据还没有迁移。
 */

import { isLegacyUnmigrated, LEGACY_UNMIGRATED_IMPORT_MESSAGE, legacyDataStateOf } from './legacy-data.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { runV2MediaImport } from './v2-media-import.mjs'

const privatePaths = getPrivatePaths()
const apply = process.argv.includes('--apply')

try {
  if (isLegacyUnmigrated(legacyDataStateOf(privatePaths))) {
    console.error(`[import-media] ${LEGACY_UNMIGRATED_IMPORT_MESSAGE}`)
    process.exitCode = 2
  } else {
    process.exitCode = await runV2MediaImport({ privatePaths, apply })
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
