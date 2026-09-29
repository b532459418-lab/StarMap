/**
 * scripts/local-editor-data-mode.mjs 的测试（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3、§3「插件」；PR3b-2 规格 §2.7、§3；PR3b-3 规格 §2.4）：
 * 虚拟模块的内容，V2 数据模式下的两张写入路由表（非媒体端点与媒体端点；PR3b-3 起不再拒绝任何端点），
 * 以及读插件源码的断言：V2 分派在旧分支之前，旧模式的写入逻辑与路由分支逐字未变。
 * 端到端（dev server + curl）在规格的浏览器验证里手工做；Node 端到端见 v2-editor-store.test.mjs 与 v2-media-store.test.mjs。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict + node:fs + node:crypto。不 import 插件本身。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as dataModeModule from './local-editor-data-mode.mjs'
import {
  LEGACY_PRIVATE_EXPORTS,
  PRIVATE_DATA_WATCH_EVENTS,
  privateDataModuleExports,
  privateDataSources,
  renderPrivateDataModule,
  shouldHandlePrivateDataChange,
  V2_PRIVATE_FILE_KEYS,
} from './local-editor-data-mode.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { V2_EDITOR_ROUTES, v2EditorRoute } from './v2-editor-store.mjs'
import { V2_MEDIA_ROUTES, v2MediaRoute } from './v2-media-store.mjs'
import { V2_FILE_KEYS } from '../src/data/canonical/v2Schema.ts'
import { V2_WRITE_ERROR_CODES } from '../src/data/v2write/errors.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(tmpdir(), 'starmap-virtual-module-test') })

const LEGACY_VALUES = {
  privateEditorState: { schemaVersion: 1, hiddenCityIds: ['iceland__vik'] },
  privateMediaCatalog: { schemaVersion: 2, items: [] },
  privateTravelMap: { schema_version: 1, records: [{ id: 'r1' }] },
  privateWantToGo: { schema_version: 1, items: [] },
}
const V2_VALUES = {
  places: { schema_version: 1, generated_at: '2026-09-27', places: [] },
  travel: undefined,
  wantToGo: { schema_version: 2, items: [] },
  editorState: undefined,
  media: { schemaVersion: 3, items: [] },
}

/** 在 Node 里执行渲染出的模块源码，拿到导出（等价于浏览器 import 虚拟模块）。 */
const evaluateModule = async (source) => import(`data:text/javascript,${encodeURIComponent(source)}`)

// ---------------------------------------------------------------------------
// 虚拟模块
// ---------------------------------------------------------------------------

test('privateDataSources：legacy 读四个旧文件（顺序不变），v2 只读 data/v2/ 的五个 V2 文件，两者不相交', () => {
  const legacy = privateDataSources('legacy', paths)
  assert.deepEqual(legacy, [
    { key: 'privateEditorState', path: paths.editorStatePath },
    { key: 'privateMediaCatalog', path: paths.mediaCatalogPath },
    { key: 'privateTravelMap', path: paths.localTravelMapPath },
    { key: 'privateWantToGo', path: paths.wantToGoPath },
  ])
  const v2 = privateDataSources('v2', paths)
  assert.deepEqual(V2_PRIVATE_FILE_KEYS, V2_FILE_KEYS)
  assert.deepEqual(v2.map(({ key }) => key), V2_FILE_KEYS)
  for (const { key, path: filePath } of v2) {
    assert.equal(filePath, paths.v2FilePaths[key])
    assert.equal(path.dirname(filePath), paths.v2DataRoot)
  }
  const legacyPaths = new Set(legacy.map(({ path: filePath }) => filePath))
  assert.ok(v2.every(({ path: filePath }) => !legacyPaths.has(filePath)), 'V2 模式绝不读旧文件')
})

test('虚拟模块 · 公开模式：四个旧导出为 undefined，privateDataMode 恒为 legacy，privateV2Files 为 undefined；忽略传入的模式与值', async () => {
  const expected = {
    privateEditorState: undefined,
    privateMediaCatalog: undefined,
    privateTravelMap: undefined,
    privateWantToGo: undefined,
    privateDataMode: 'legacy',
    privateV2Files: undefined,
  }
  assert.deepEqual(privateDataModuleExports({ profile: 'public' }), expected)
  assert.deepEqual(privateDataModuleExports({ profile: 'public', dataMode: 'v2', values: { ...LEGACY_VALUES, ...V2_VALUES } }), expected)
  const module = await evaluateModule(renderPrivateDataModule(expected))
  assert.deepEqual({ ...module }, expected)
})

test('虚拟模块 · 个人模式 legacy：四个旧导出照旧，源码的前四行与 PR3b-1 之前逐字相同，另加两个导出', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', dataMode: 'legacy', values: { ...LEGACY_VALUES, ...V2_VALUES } })
  assert.deepEqual(exports, { ...LEGACY_VALUES, privateDataMode: 'legacy', privateV2Files: undefined })
  const source = renderPrivateDataModule(exports)
  // PR3b-1 之前 load() 的写法（原样）。
  const before = Object.entries(LEGACY_VALUES)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join('\n')
  assert.ok(source.startsWith(`${before}\n`))
  assert.deepEqual(source.slice(before.length + 1).split('\n'), [
    'export const privateDataMode = "legacy";',
    'export const privateV2Files = undefined;',
  ])
  assert.deepEqual({ ...(await evaluateModule(source)) }, exports)
  assert.deepEqual(LEGACY_PRIVATE_EXPORTS.map(([name]) => name), Object.keys(LEGACY_VALUES))
})

test('虚拟模块 · 个人模式 v2：四个旧导出为 undefined（即使传了值）；privateV2Files 是五个文件，缺的为 undefined', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', dataMode: 'v2', values: { ...LEGACY_VALUES, ...V2_VALUES } })
  assert.equal(exports.privateDataMode, 'v2')
  for (const [name] of LEGACY_PRIVATE_EXPORTS) assert.equal(exports[name], undefined, name)
  assert.deepEqual(Object.keys(exports.privateV2Files), V2_FILE_KEYS)
  assert.deepEqual(exports.privateV2Files, V2_VALUES)

  // 浏览器里：缺的文件不出现（JSON 省略 undefined），读作 undefined。
  const module = await evaluateModule(renderPrivateDataModule(exports))
  assert.equal(module.privateDataMode, 'v2')
  assert.equal(module.privateTravelMap, undefined)
  assert.deepEqual(Object.keys(module.privateV2Files), ['places', 'wantToGo', 'media'])
  assert.equal(module.privateV2Files.travel, undefined)

  // 全新空目录（只有标记）：五个都缺。
  const empty = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', dataMode: 'v2' })))
  assert.deepEqual(module.privateDataMode, empty.privateDataMode)
  assert.deepEqual(empty.privateV2Files, {})
})

// ---------------------------------------------------------------------------
// 编辑接口的 V2 分派
// ---------------------------------------------------------------------------

/** 插件源码里全部 `request.method === 'X' && url.pathname === 'Y'` 分支。 */
const pluginEndpoints = () => {
  const source = readFileSync(path.join(webRoot, 'scripts', 'local-editor-plugin.mjs'), 'utf8')
  return [...source.matchAll(/request\.method === '([A-Z]+)' && url\.pathname === '([^']+)'/g)].map(([, method, pathname]) => ({ method, pathname }))
}

const WRITE_ENDPOINTS = [
  'PUT /__travelatlas/editor/state',
  'POST /__travelatlas/editor/records',
  'POST /__travelatlas/editor/countries',
  'POST /__travelatlas/editor/countries/delete',
  'POST /__travelatlas/editor/wanttogo',
  'POST /__travelatlas/editor/wanttogo/update',
  'POST /__travelatlas/editor/wanttogo/delete',
  'POST /__travelatlas/editor/wanttogo/convert',
  'POST /__travelatlas/editor/upload',
  'POST /__travelatlas/editor/import',
  'POST /__travelatlas/editor/media/delete',
]
const READ_ONLY_CATALOGS = ['GET /__travelatlas/editor/catalog/countries', 'GET /__travelatlas/editor/catalog/cities']

test('插件的编辑接口正好是：11 个写入端点、GET /editor/state、两个目录搜索', () => {
  const endpoints = pluginEndpoints().map(({ method, pathname }) => `${method} ${pathname}`)
  assert.equal(WRITE_ENDPOINTS.length, 11)
  assert.deepEqual(
    [...endpoints].sort(),
    [...WRITE_ENDPOINTS, 'GET /__travelatlas/editor/state', ...READ_ONLY_CATALOGS].sort(),
  )
})

const MEDIA_ENDPOINTS = [
  'POST /__travelatlas/editor/upload',
  'POST /__travelatlas/editor/import',
  'POST /__travelatlas/editor/media/delete',
]
const NON_MEDIA_WRITE_ENDPOINTS = WRITE_ENDPOINTS.filter((endpoint) => !MEDIA_ENDPOINTS.includes(endpoint))

test('V2 模式（RFC-LOC-1 PR3b-3）：不再拒绝任何端点——三个媒体端点经 V2_MEDIA_ROUTES，其余 8 个写入端点经 V2_EDITOR_ROUTES；两张表不相交，合起来正好是 11 个写入端点', () => {
  assert.equal(NON_MEDIA_WRITE_ENDPOINTS.length, 8)
  assert.deepEqual(Object.keys(V2_MEDIA_ROUTES).sort(), [...MEDIA_ENDPOINTS].sort())
  assert.deepEqual(
    [...Object.keys(V2_EDITOR_ROUTES), ...Object.keys(V2_MEDIA_ROUTES)].sort(),
    [...WRITE_ENDPOINTS].sort(),
  )
  assert.deepEqual(Object.fromEntries(MEDIA_ENDPOINTS.map((endpoint) => [endpoint, v2MediaRoute(...endpoint.split(' '))])), {
    'POST /__travelatlas/editor/upload': 'upload',
    'POST /__travelatlas/editor/import': 'import',
    'POST /__travelatlas/editor/media/delete': 'delete',
  })
  for (const endpoint of [...NON_MEDIA_WRITE_ENDPOINTS, 'GET /__travelatlas/editor/state', ...READ_ONLY_CATALOGS, 'GET /__travelatlas/editor/upload', 'POST /__travelatlas/editor/media']) {
    assert.equal(v2MediaRoute(...endpoint.split(' ')), undefined, endpoint)
  }
  // PR3b-2 的拒绝（409 与 E_V2_MEDIA_UNAVAILABLE）已删除。
  for (const name of ['editorDataModeRejection', 'V2_MEDIA_ENDPOINTS', 'V2_MEDIA_READ_ONLY_CODE', 'V2_MEDIA_READ_ONLY_ERROR']) {
    assert.equal(Object.hasOwn(dataModeModule, name), false, name)
  }
  assert.equal(V2_WRITE_ERROR_CODES.includes('E_V2_MEDIA_UNAVAILABLE'), false)
})

test('V2 模式的写入路由表正好是 8 个非媒体写入端点；没列进去的接口（包括将来新加的、媒体端点、换了方法的）没有路由', () => {
  assert.deepEqual(Object.keys(V2_EDITOR_ROUTES).sort(), [...NON_MEDIA_WRITE_ENDPOINTS].sort())
  for (const endpoint of NON_MEDIA_WRITE_ENDPOINTS) {
    const [method, pathname] = endpoint.split(' ')
    assert.equal(typeof v2EditorRoute(method, pathname)?.run, 'function', endpoint)
  }
  for (const [method, pathname] of [
    ['POST', '/__travelatlas/editor/something-new'],
    ['DELETE', '/__travelatlas/editor/state'],
    ['GET', '/__travelatlas/editor/state'],
    ['POST', '/__travelatlas/editor/catalog/cities'],
    ...MEDIA_ENDPOINTS.map((endpoint) => endpoint.split(' ')),
  ]) {
    assert.equal(v2EditorRoute(method, pathname), undefined, `${method} ${pathname}`)
  }
  // 成功时的状态码与旧模式相同。
  assert.deepEqual(Object.fromEntries(Object.entries(V2_EDITOR_ROUTES).map(([endpoint, route]) => [endpoint, route.status])), {
    'PUT /__travelatlas/editor/state': 200,
    'POST /__travelatlas/editor/records': 201,
    'POST /__travelatlas/editor/countries': 201,
    'POST /__travelatlas/editor/countries/delete': 200,
    'POST /__travelatlas/editor/wanttogo': 201,
    'POST /__travelatlas/editor/wanttogo/update': 200,
    'POST /__travelatlas/editor/wanttogo/delete': 200,
    'POST /__travelatlas/editor/wanttogo/convert': 200,
  })
})

// ---------------------------------------------------------------------------
// 插件源码：V2 分派在旧分支之前，旧模式的路由与写入逻辑逐字未变
// ---------------------------------------------------------------------------

const pluginSource = () => readFileSync(path.join(webRoot, 'scripts', 'local-editor-plugin.mjs'), 'utf8').replace(/\r\n/g, '\n')

/** 从 `start` 到 `end`（`includeEnd` 时含 end）的原文。 */
const sourceBetween = (source, start, end, includeEnd) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to >= 0, `找不到源码区段：${start}`)
  return source.slice(from, includeEnd ? to + end.length : to)
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

test('旧模式回归：插件里旧模式的写入逻辑、路由分支与 GET /editor/state 的读取与 main @ adf40c9 逐字相同（sha256）', () => {
  const source = pluginSource()
  // 从 emptyState 到 authorizeWrite 之前：normalizeState、国家目录、addCountry、addTravelRecord、媒体、删除国家、转足迹……
  const legacyLogic = sourceBetween(source, 'const emptyState = {', 'const authorizeWrite = (request) => (', false)
  assert.equal(sha256(legacyLogic), 'd38c9eef756435b9dc1275b8ff855b9e3a130372de88cfccc87509374ecea251')
  // 11 个写入端点的旧分支，到末尾的 404。
  const legacyRoutes = sourceBetween(
    source,
    "            if (request.method === 'PUT' && url.pathname === '/__travelatlas/editor/state') {",
    "            return sendJson(response, 404, { ok: false, error: '未知的本地编辑接口。' })",
    true,
  )
  assert.equal(sha256(legacyRoutes), '6ab54e04e929879ef7970359d9ce8b7914dc9d1904ec994a32b8540db5f6f1c7')
  const legacyGetState = sourceBetween(
    source,
    '            const state = normalizeState(await readJson(editorStatePath, emptyState))',
    '            return sendJson(response, 200, { ok: true, state })',
    true,
  )
  assert.equal(sha256(legacyGetState), 'e6fbfd01b537c9cd05b7f23da8e51f58080ce426e032731b6af2e5b5075b7dce')
})

test('V2 分派：写入时先判定数据模式，V2 下在任何旧分支之前 return；GET /editor/state 在 V2 下读 V2 文件', () => {
  const source = pluginSource()
  const writeSection = source.slice(source.indexOf("if (!authorizeWrite(request)) return sendJson(response, 403"))
  const dispatch = writeSection.indexOf("if (dataMode === 'v2') {\n              const result = await handleV2Write(request, url)\n              return sendJson(response, result.status, result.body)\n            }")
  const firstLegacyBranch = writeSection.indexOf("if (request.method === 'PUT' && url.pathname === '/__travelatlas/editor/state')")
  assert.ok(dispatch > 0 && firstLegacyBranch > dispatch, 'V2 分派必须在第一个旧分支之前')
  assert.ok(writeSection.indexOf('const dataMode = resolveDataMode(privatePaths).mode') < writeSection.indexOf('editorMutationDepth += 1'))
  assert.match(source, /const route = v2EditorRoute\(request\.method, url\.pathname\)\n {2}if \(!route\) return \{ status: 404, body: v2ErrorBody\('E_UNKNOWN_ENDPOINT'\) \}/)
  const getState = sourceBetween(source, "if (request.method === 'GET' && url.pathname === '/__travelatlas/editor/state') {", 'return sendJson(response, 200, { ok: true, state })', true)
  assert.ok(getState.indexOf("if (resolveDataMode(privatePaths).mode === 'v2') {") < getState.indexOf('normalizeState('))
  assert.match(getState, /const result = await readV2EditorState\(\{ privatePaths \}\)/)
})

// ---------------------------------------------------------------------------
// 私人数据目录的文件事件
// ---------------------------------------------------------------------------

test('文件事件：私人数据目录之内的新建、修改、删除都要处理（含数据模式标记、data/v2/ 与迁移清单）', () => {
  assert.deepEqual(PRIVATE_DATA_WATCH_EVENTS, ['add', 'change', 'unlink'])
  const inside = [
    paths.dataModePath,
    paths.localTravelMapPath,
    paths.editorStatePath,
    paths.v2FilePaths.places,
    paths.v2FilePaths.media,
    path.join(paths.dataRoot, 'migration', 'identity-manifest.local.json'),
    path.join(paths.dataRoot, 'editor-state.local.json.1234.tmp'),
    path.join(paths.dataRoot, '..data-mode-like-name.json'),
    paths.dataRoot,
  ]
  for (const event of ['add', 'change', 'unlink']) {
    for (const filePath of inside) assert.equal(shouldHandlePrivateDataChange(event, filePath, paths.dataRoot), true, `${event} ${filePath}`)
  }
  // dataRoot 末尾带分隔符也一样。
  assert.equal(shouldHandlePrivateDataChange('add', paths.dataModePath, `${paths.dataRoot}${path.sep}`), true)
})

test('文件事件：私人数据目录之外、只是前缀相同的兄弟目录、目录事件与其他事件都不处理', () => {
  for (const filePath of [
    path.join(paths.root, 'config', '.env.local'),
    path.join(paths.root, 'MediaInbox', 'Iceland', 'Reykjavik', 'photos', 'a.jpg'),
    path.join(paths.root, 'data-backup', 'travel-map.local.json'),
    `${paths.dataRoot}2${path.sep}travel-map.local.json`,
    paths.root,
    path.join(webRoot, 'src', 'App.tsx'),
  ]) {
    for (const event of ['add', 'change', 'unlink']) {
      assert.equal(shouldHandlePrivateDataChange(event, filePath, paths.dataRoot), false, `${event} ${filePath}`)
    }
  }
  for (const event of ['addDir', 'unlinkDir', 'ready', 'error', 'all', 'raw']) {
    assert.equal(shouldHandlePrivateDataChange(event, paths.dataModePath, paths.dataRoot), false, event)
  }
})

test('插件对 add、change、unlink 三种事件注册同一个处理，且经 shouldHandlePrivateDataChange 过滤；不再只监听 change', () => {
  const source = readFileSync(path.join(webRoot, 'scripts', 'local-editor-plugin.mjs'), 'utf8')
  assert.match(source, /for \(const event of PRIVATE_DATA_WATCH_EVENTS\) \{\s*server\.watcher\.on\(event, /)
  assert.match(source, /if \(!shouldHandlePrivateDataChange\(event, changedPath, dataRoot\)\) return/)
  assert.doesNotMatch(source, /server\.watcher\.on\('change'/)
  // 原有的刷新条件保留：编辑器写入期间与之后的静默期不刷新。
  assert.match(source, /if \(editorMutationDepth > 0 \|\| Date\.now\(\) < ignoreWatcherUntil\) return/)
})

test('插件不再按数据模式拒绝写入：没有 409、没有 editorDataModeRejection；V2 分派先看媒体路由（上传的请求体不按 JSON 读），再看非媒体路由', () => {
  const source = pluginSource()
  assert.doesNotMatch(source, /editorDataModeRejection|E_V2_MEDIA_UNAVAILABLE|\b409\b/)
  const handleV2Write = sourceBetween(source, 'const handleV2Write = async (request, url) => {', 'export function travelAtlasLocalEditor', false)
  assert.match(handleV2Write, /^const handleV2Write = async \(request, url\) => \{\n {2}const mediaRoute = v2MediaRoute\(request\.method, url\.pathname\)\n {2}if \(mediaRoute\) return handleV2Media\(mediaRoute, request, url\)\n {2}const route = v2EditorRoute/)
  const handleV2Media = sourceBetween(source, 'const handleV2Media = async (routeName, request, url) => {', 'const handleV2Write = async', false)
  assert.ok(
    handleV2Media.indexOf("if (routeName === 'upload') return handleV2Upload(") < handleV2Media.indexOf('await readJsonBody(request)'),
    '上传在读 JSON 请求体之前分出去',
  )
  // 旧模式的辅助函数原样传给 V2 媒体端点复用。
  for (const name of ['safeSegment', 'reserveDestination', 'writeUpload', 'updateDroneSidecar', 'runImporter', 'normalizeInboxRelativePath', 'removeSidecarEntries', 'isPathInside']) {
    assert.match(handleV2Media, new RegExp(`\\n {4}${name},\\n`), name)
  }
})
