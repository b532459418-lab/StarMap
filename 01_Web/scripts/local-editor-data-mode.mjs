/**
 * 本地编辑器插件里与数据模式有关的两件事（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3），抽成纯函数以便单测：
 *
 * 1. 虚拟模块 `virtual:starmap-private-data` 的内容：
 *    - 公开模式：四个旧导出为 undefined，`privateDataMode` 为 'legacy'，`privateV2Files` 为 undefined；
 *    - 个人模式 · legacy：四个旧文件照旧（读取顺序不变），`privateV2Files` 为 undefined；
 *    - 个人模式 · v2：【只】读 data/v2/ 的五个 V2 文件（缺的为 undefined），四个旧导出为 undefined——
 *      App 在 V2 模式下绝不会读到旧文件。
 * 2. V2 模式下的写入拒绝：服务端是真正的防线。本地编辑接口里除两个只读的目录搜索外，全部返回 409，
 *    包括 11 个写入端点与 `GET /__travelatlas/editor/state`，不读写任何文件。
 *
 * 这里只有纯函数；读文件、判定数据模式（`./data-mode.mjs`）在插件里做。
 * 本文件不 import 插件（插件在模块顶层解析私有资料层路径，并 import 了 sharp / undici / world-countries）。
 */

/** V2 模式下编辑接口的错误信息（`{ ok: false, error }`，UI 直接展示）。 */
export const V2_READ_ONLY_ERROR = 'V2 数据模式下暂不能编辑（RFC-LOC-1 PR3b-2 / PR3b-3 开放）。'

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

/** 只读、不碰私人数据的编辑接口：V2 模式下照常可用。 */
const READ_ONLY_EDITOR_ENDPOINTS = new Set([
  'GET /__travelatlas/editor/catalog/countries',
  'GET /__travelatlas/editor/catalog/cities',
])

/**
 * 编辑接口在当前数据模式下是否要拒绝。返回 `{ status, body }` 表示拒绝，undefined 表示放行。
 * v2 模式下默认拒绝（写入端点、`GET /editor/state`、以及任何没列在只读名单里的新接口），只放行两个目录搜索。
 * 调用方在本机 / 请求头 / Origin 检查之后、进入任何分支之前调用。
 */
export function editorDataModeRejection({ dataMode, method, pathname }) {
  if (dataMode !== 'v2') return undefined
  if (READ_ONLY_EDITOR_ENDPOINTS.has(`${method} ${pathname}`)) return undefined
  return { status: 409, body: { ok: false, error: V2_READ_ONLY_ERROR } }
}
