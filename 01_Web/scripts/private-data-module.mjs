/**
 * 本地编辑器插件里与私人数据有关的两件事，抽成纯函数以便单测（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3；PR5a 规格 §4.1）：
 *
 * 1. 虚拟模块 `virtual:starmap-private-data` 的内容（PR5a 起只有两个导出）：
 *    - `privateV2Files`：个人模式下是 `data/v2/` 的五个 V2 文件（缺的为 undefined）；公开模式为 undefined。
 *      App 只读这五个文件，从不读旧格式的文件。
 *    - `privateLegacyUnmigrated`：个人模式下私人目录有没迁移的旧数据（判定见 ./legacy-data.mjs）；公开模式恒为 false。
 *      为 true 时 App 显示迁移提示（src/data/privateDataNotice.ts）。
 * 2. 私人数据目录的文件变化要不要处理（让虚拟模块失效、按原有条件整页刷新）：`data/v2/` 之内的新建、修改、删除，
 *    以及四个旧数据文件的新建与删除（它们的有无决定「未迁移」）。这样迁移工具写出 V2 文件、导入器更新媒体目录、
 *    用户把旧文件移走，不重启服务也能生效。
 *
 * 这里只有纯函数；读文件、判定「未迁移」在插件里做。
 * 本文件不 import 插件（插件在模块顶层解析私有资料层路径，并 import 了 sharp / undici / world-countries）。
 * 取代了 PR3b-1 起的 local-editor-data-mode.mjs（数据模式已删除）。
 */

import path from 'node:path'

import { legacyDataPaths } from './legacy-data.mjs'
import { V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'

/** 虚拟模块的导出名（顺序即源码里的顺序）。 */
export const PRIVATE_DATA_MODULE_EXPORTS = Object.freeze(['privateV2Files', 'privateLegacyUnmigrated'])

/**
 * 虚拟模块的全部导出。`v2Values` 是 `data/v2/` 五个文件读到的值（键同 V2_PRIVATE_FILE_KEYS；文件不存在为 undefined），
 * `legacyUnmigrated` 是 ./legacy-data.mjs 的判定。公开模式忽略两者。
 */
export function privateDataModuleExports({ profile, v2Values = {}, legacyUnmigrated = false }) {
  const personal = profile === 'personal'
  return {
    privateV2Files: personal
      ? Object.fromEntries(V2_PRIVATE_FILE_KEYS.map((key) => [key, v2Values[key]]))
      : undefined,
    privateLegacyUnmigrated: personal && legacyUnmigrated === true,
  }
}

/** 导出 → 模块源码。值为 undefined 的导出写成 `undefined`，对象里值为 undefined 的键省略（JSON）。 */
export function renderPrivateDataModule(exports) {
  return Object.entries(exports)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join('\n')
}

/** 插件监听的文件事件：新建、修改、删除（chokidar 的事件名）。目录事件不单独处理，目录里的文件各自有事件。 */
export const PRIVATE_DATA_WATCH_EVENTS = Object.freeze(['add', 'change', 'unlink'])

/** `target` 是否在 `directory` 之内（含 directory 本身）。按路径层级判断：只是前缀相同的兄弟目录不算。 */
const isWithin = (directory, target) => {
  const relative = path.relative(path.resolve(directory), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * 私人数据目录里这个文件事件要不要处理（`privatePaths` 是 `getPrivatePaths()` 的结果）：
 * - `data/v2/` 之内（含它本身）的新建、修改、删除：V2 数据变了；
 * - 四个旧数据文件的新建与删除：「未迁移」的判定可能变了。旧文件的内容 App 不读，修改不用处理。
 * 其余（迁移清单、PR4 的数据模式标记、旧格式的 `.bak`、`data/` 之外）都不处理。
 */
export function shouldHandlePrivateDataChange(event, changedPath, privatePaths) {
  if (!PRIVATE_DATA_WATCH_EVENTS.includes(event)) return false
  if (isWithin(privatePaths.v2DataRoot, changedPath)) return true
  if (event === 'change') return false
  return legacyDataPaths(privatePaths).some((legacyPath) => path.relative(path.resolve(legacyPath), path.resolve(changedPath)) === '')
}
