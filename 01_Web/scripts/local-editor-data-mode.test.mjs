/**
 * scripts/local-editor-data-mode.mjs 的测试（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3、§3「插件」）：
 * 虚拟模块的内容，以及 V2 数据模式下编辑接口的拒绝。端到端（dev server + curl）在规格 §6 手工验证。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict + node:fs。不 import 插件本身。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  editorDataModeRejection,
  LEGACY_PRIVATE_EXPORTS,
  PRIVATE_DATA_WATCH_EVENTS,
  privateDataModuleExports,
  privateDataSources,
  renderPrivateDataModule,
  shouldHandlePrivateDataChange,
  V2_PRIVATE_FILE_KEYS,
  V2_READ_ONLY_ERROR,
} from './local-editor-data-mode.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { V2_FILE_KEYS } from '../src/data/canonical/v2Schema.ts'

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
// 编辑接口的拒绝
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

test('V2 模式：11 个写入端点与 GET /editor/state 全部 409（固定的错误信息），两个目录搜索放行；插件里的每个分支都被覆盖', () => {
  for (const endpoint of [...WRITE_ENDPOINTS, 'GET /__travelatlas/editor/state']) {
    const [method, pathname] = endpoint.split(' ')
    assert.deepEqual(
      editorDataModeRejection({ dataMode: 'v2', method, pathname }),
      { status: 409, body: { ok: false, error: V2_READ_ONLY_ERROR } },
      endpoint,
    )
  }
  for (const endpoint of READ_ONLY_CATALOGS) {
    const [method, pathname] = endpoint.split(' ')
    assert.equal(editorDataModeRejection({ dataMode: 'v2', method, pathname }), undefined, endpoint)
  }
  for (const { method, pathname } of pluginEndpoints()) {
    const expected = READ_ONLY_CATALOGS.includes(`${method} ${pathname}`) ? undefined : 409
    assert.equal(editorDataModeRejection({ dataMode: 'v2', method, pathname })?.status, expected, `${method} ${pathname}`)
  }
  assert.equal(V2_READ_ONLY_ERROR, 'V2 数据模式下暂不能编辑（RFC-LOC-1 PR3b-2 / PR3b-3 开放）。')
})

test('V2 模式默认拒绝：没列进只读名单的接口（包括将来新加的）、目录搜索换了方法，都是 409', () => {
  for (const [method, pathname] of [
    ['POST', '/__travelatlas/editor/something-new'],
    ['DELETE', '/__travelatlas/editor/state'],
    ['POST', '/__travelatlas/editor/catalog/cities'],
  ]) {
    assert.equal(editorDataModeRejection({ dataMode: 'v2', method, pathname })?.status, 409, `${method} ${pathname}`)
  }
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

test('legacy 模式：任何接口都不拒绝（旧行为不变）', () => {
  for (const { method, pathname } of pluginEndpoints()) {
    assert.equal(editorDataModeRejection({ dataMode: 'legacy', method, pathname }), undefined, `${method} ${pathname}`)
  }
  assert.equal(editorDataModeRejection({ dataMode: 'legacy', method: 'POST', pathname: '/__travelatlas/editor/unknown' }), undefined)
})
