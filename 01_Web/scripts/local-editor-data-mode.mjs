/**
 * 本地编辑器插件里与数据模式有关的两件事（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3），抽成纯函数以便单测：
 *
 * 1. 虚拟模块 `virtual:starmap-private-data` 的内容：
 *    - 公开模式：四个旧导出为 undefined，`privateDataMode` 为 'legacy'，`privateV2Files` 为 undefined；
 *    - 个人模式 · legacy：四个旧文件照旧（读取顺序不变），`privateV2Files` 为 undefined；
 *    - 个人模式 · v2：【只】读 data/v2/ 的五个 V2 文件（缺的为 undefined），四个旧导出为 undefined——
 *      App 在 V2 模式下绝不会读到旧文件。
 * 2. （PR3b-1 / PR3b-2 的「V2 下拒绝写入」已随 PR3b-3 删除：V2 下全部 11 个写入端点都有 V2 实现——8 个非媒体端点在
 *    scripts/v2-editor-store.mjs，3 个媒体端点在 scripts/v2-media-store.mjs；插件在 V2 下只经这两张路由表分派，
 *    没列进去的接口回 404，绝不进入旧模式的写入分支。）
 *
 * 3. 私人数据目录的文件变化要不要处理（让虚拟模块失效、按原有条件整页刷新）：新建、修改、删除都算，
 *    这样新建 / 删除数据模式标记、生成 data/v2/ 的文件，不重启服务也能生效。
 *
 * 这里只有纯函数；读文件、判定数据模式（`./data-mode.mjs`）在插件里做。
 * 本文件不 import 插件（插件在模块顶层解析私有资料层路径，并 import 了 sharp / undici / world-countries）。
 */

import path from 'node:path'

/** 旧文件：虚拟模块的导出名 → getPrivatePaths() 的路径键。顺序就是读取顺序（与 PR3b-1 之前相同）。 */
export const LEGACY_PRIVATE_EXPORTS = Object.freeze([
  ['privateEditorState', 'editorStatePath'],
  ['privateMediaCatalog', 'mediaCatalogPath'],
  ['privateTravelMap', 'localTravelMapPath'],
  ['privateWantToGo', 'wantToGoPath'],
])

/** 五个 V2 文件的键（与 getPrivatePaths().v2FilePaths、src/data/canonical/v2Schema.ts 的 V2_FILE_KEYS 相同）。 */
export const V2_PRIVATE_FILE_KEYS = Object.freeze(['places', 'travel', 'wantToGo', 'editorState', 'media'])

/**
 * 个人模式下虚拟模块要读哪些文件：legacy 为四个旧文件，v2 为 data/v2/ 的五个 V2 文件。两者不相交。
 * @returns {{ key: string, path: string }[]}  key 是旧导出名（legacy）或 V2 文件键（v2）
 */
export function privateDataSources(dataMode, privatePaths) {
  if (dataMode === 'v2') return V2_PRIVATE_FILE_KEYS.map((key) => ({ key, path: privatePaths.v2FilePaths[key] }))
  return LEGACY_PRIVATE_EXPORTS.map(([key, pathKey]) => ({ key, path: privatePaths[pathKey] }))
}

/**
 * 虚拟模块的全部导出。`values` 是按 `privateDataSources` 读到的值（键同 source.key；文件不存在为 undefined）。
 * 公开模式忽略 `dataMode` 与 `values`。
 */
export function privateDataModuleExports({ profile, dataMode = 'legacy', values = {} }) {
  const personal = profile === 'personal'
  const mode = personal && dataMode === 'v2' ? 'v2' : 'legacy'
  const legacyValues = personal && mode === 'legacy'
  const exports = {}
  for (const [name] of LEGACY_PRIVATE_EXPORTS) exports[name] = legacyValues ? values[name] : undefined
  exports.privateDataMode = mode
  exports.privateV2Files = personal && mode === 'v2'
    ? Object.fromEntries(V2_PRIVATE_FILE_KEYS.map((key) => [key, values[key]]))
    : undefined
  return exports
}

/** 导出 → 模块源码。值为 undefined 的导出写成 `undefined`，对象里值为 undefined 的键省略（JSON）。 */
export function renderPrivateDataModule(exports) {
  return Object.entries(exports)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join('\n')
}

/** 插件监听的文件事件：新建、修改、删除（chokidar 的事件名）。目录事件不单独处理，目录里的文件各自有事件。 */
export const PRIVATE_DATA_WATCH_EVENTS = Object.freeze(['add', 'change', 'unlink'])

/**
 * 私人数据目录里这个文件事件要不要处理：事件是新建 / 修改 / 删除，且路径在 `dataRoot` 之内（含 dataRoot 本身）。
 * 「之内」按路径层级判断：`data-backup/…` 这类只是前缀相同的兄弟目录不算。
 */
export function shouldHandlePrivateDataChange(event, changedPath, dataRoot) {
  if (!PRIVATE_DATA_WATCH_EVENTS.includes(event)) return false
  const relative = path.relative(path.resolve(dataRoot), path.resolve(changedPath))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
