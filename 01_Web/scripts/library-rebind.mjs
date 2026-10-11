/**
 * `npm run library:rebind`（第 1 批 D3）：私人根被移动、改名或换了盘符之后，库操作记录与媒体待办身份里绑定的还是旧路径，
 * 所有写入都会报 E_LIBRARY_ROOT_MOVED。这个脚本打印旧 binding 与新 binding；只有加 `--confirm` 才把它们改成当前私人根。
 * 有库操作锁时拒绝执行；写入走原子写（临时文件 → fsync → rename）。退出码：0 完成 / 不需要 / 只预览，1 拒绝。
 */

import { rebindLibraryRoot } from './library-operation-lock.mjs'
import { getPrivatePaths } from './private-profile.mjs'

try {
  process.exitCode = await rebindLibraryRoot(getPrivatePaths(), { confirm: process.argv.includes('--confirm') })
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
