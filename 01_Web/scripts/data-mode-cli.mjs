/**
 * 数据模式的查看与切换（RFC-LOC-1 PR4 规格 §2.2）。判定与写标记都在 ./data-mode.mjs，这里只是命令行外壳。
 *
 *   npm run data-mode                 打印当前模式与判定原因（标记 / 有旧数据 / 全新目录）；也可写 `-- status`
 *   npm run data-mode -- legacy       原子写入标记 { "mode": "legacy" }（回滚到旧文件）
 *   npm run data-mode -- v2           原子写入标记 { "mode": "v2" }
 *
 * - 私人根目录与 App 相同（`STARMAP_PRIVATE_ROOT`，否则默认位置）；运行时先把它打印到 stderr。
 * - `v2` 的防呆：私人目录有旧数据、而 `data/v2/` 里没有任何 V2 文件时拒绝（退出码 2），提示先迁移——
 *   否则切过去会看到一个空世界，以为数据丢了。只看确切的文件名，`.bak` 不算。
 * - 写标记用 `atomicJsonWrite`（结尾换行，不带 BOM；已有标记时留 `.bak`）；隐私门：只写解析出的私人根目录之内的
 *   标记文件。标记已经是要写的值时不重写（不触发 dev server 刷新）。
 * - 现有标记损坏时，任何子命令都只报错（退出码 1），不写：与 dev server、各脚本一样不猜。修正或删除那个文件后重试。
 * - 只打印模式、原因与路径，不读、不打印任何数据文件的内容。
 *
 * 退出码：成功 0；参数错误、标记损坏、读取失败 1；被拒（v2 防呆、隐私门）2。
 */

import path from 'node:path'

import {
  DataModeMarkerError,
  DataModeMarkerWriteRefused,
  hasLegacyData,
  hasV2Data,
  resolveDataMode,
  writeDataModeMarker,
} from './data-mode.mjs'
import { getPrivatePaths } from './private-profile.mjs'

const usage = [
  '用法：',
  '  npm run data-mode                 打印当前数据模式与判定原因',
  '  npm run data-mode -- legacy       写入 { "mode": "legacy" }（回滚到旧文件）',
  '  npm run data-mode -- v2           写入 { "mode": "v2" }',
].join('\n')

class UsageError extends Error {}
class Refusal extends Error {}

const parseArgs = (argv) => {
  if (argv.length === 0) return { command: 'status' }
  if (argv.length > 1) throw new UsageError(`参数太多：${argv.join(' ')}`)
  const [command] = argv
  if (['status', 'legacy', 'v2'].includes(command)) return { command }
  throw new UsageError(`无法识别的参数：${command}`)
}

const markerText = (mode) => `{ "mode": "${mode}" }`

/** 判定原因的短名（PR4 规格 §2.2：标记 / 有旧数据 / 全新目录）。 */
const REASON_LABELS = { marker: '标记', 'legacy-data': '有旧数据', 'fresh-profile': '全新目录' }

/** 判定原因 → 人读的一句话。 */
const describeReason = ({ mode, reason }, paths) => {
  if (reason === 'marker') return `标记 → ${mode}（${paths.dataModePath}）`
  if (reason === 'legacy-data') return `有旧数据 → ${mode}（没有标记文件；私人目录 data/ 下有旧格式的数据文件）`
  return `全新目录 → ${mode}（没有标记文件，也没有旧格式的数据文件）`
}

const printStatus = (resolved, paths) => {
  console.log(`当前数据模式：${resolved.mode}`)
  console.log(`判定原因：${describeReason(resolved, paths)}`)
  console.log(`旧格式数据文件：${hasLegacyData(paths) ? '有' : '没有'}`)
  console.log(`V2 数据文件（${paths.v2DataRoot}）：${hasV2Data(paths) ? '有' : '没有'}`)
  if (resolved.mode === 'legacy' && hasLegacyData(paths) && !hasV2Data(paths)) {
    console.log('迁移到 V2：先 npm run identity:check（dry-run，看报告），再 npm run identity:check -- --apply --switch。')
  }
}

const switchTo = async (mode, resolved, paths) => {
  if (resolved.reason === 'marker' && resolved.mode === mode) {
    console.log(`标记已经是 ${markerText(mode)}，未改动（${paths.dataModePath}）。`)
    return 0
  }
  if (mode === 'v2' && hasLegacyData(paths) && !hasV2Data(paths)) {
    throw new Refusal([
      `拒绝切换到 v2：私人目录有旧数据，但 ${paths.v2DataRoot} 里没有任何 V2 文件。现在切过去会看到一个空世界。`,
      '请先迁移：npm run identity:check（dry-run，看报告）→ npm run identity:check -- --apply --switch。',
    ].join('\n'))
  }
  const target = await writeDataModeMarker(paths, mode)
  console.log(`已写入 ${target}：${markerText(mode)}（之前：${resolved.mode}，判定原因：${REASON_LABELS[resolved.reason]}）。`)
  console.log(mode === 'v2'
    ? '回滚：npm run data-mode -- legacy（旧文件未改动；在 V2 模式下做的编辑不会带回旧文件）。'
    : '切回 V2：npm run data-mode -- v2。')
  console.log('dev server 正在运行时，页面会自动刷新。')
  return 0
}

const run = async ({ command }) => {
  const paths = getPrivatePaths()
  console.error(`[data-mode] 私人根目录：${path.resolve(paths.root)}`)
  // 标记损坏时这里抛 DataModeMarkerError：任何子命令都不写。
  const resolved = resolveDataMode(paths)
  if (command === 'status') {
    printStatus(resolved, paths)
    return 0
  }
  return switchTo(command, resolved, paths)
}

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2)))
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`[data-mode] ${error.message}\n${usage}`)
    process.exitCode = 1
  } else if (error instanceof DataModeMarkerError) {
    console.error(`[data-mode] ${error.message}\n请修正或删除这个文件后重试（删除后按「有旧数据 → legacy / 全新目录 → v2」判定）。`)
    process.exitCode = 1
  } else if (error instanceof Refusal || error instanceof DataModeMarkerWriteRefused) {
    console.error(`[data-mode] ${error.message}`)
    process.exitCode = 2
  } else {
    console.error(`[data-mode] 失败：${error?.stack ?? error}`)
    process.exitCode = 1
  }
}
