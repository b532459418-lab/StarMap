/**
 * scripts/private-data-module.mjs 的测试与本地编辑器插件接线的源码断言（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3；PR3b-2 / PR3b-3 的
 * 写入路由表；PR5a 规格 §4.1、§4.2：数据模式删除，App 与编辑器只读写 V2，未迁移时拒绝写入）。
 * 取代 local-editor-data-mode.test.mjs：与数据模式无关的用例搬到这里，与旧模式有关的随代码删除。
 * 端到端（dev server + curl）在规格的浏览器验证里手工做；Node 端到端见 store-session-editor.test.mjs 与 v2-media-store.test.mjs。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict + node:fs。不 import 插件本身。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { legacyDataPaths } from './legacy-data.mjs'
import {
  PRIVATE_DATA_MODULE_EXPORTS,
  PRIVATE_DATA_WATCH_EVENTS,
  privateDataModuleExports,
  renderPrivateDataModule,
  shouldHandlePrivateDataChange,
} from './private-data-module.mjs'
import { getPrivatePaths, V2_DATA_FILE_NAMES, V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
import { STORE_WRITE_ROUTES } from './store-session.mjs'
import { NATIVE_WRITES } from '../src/data/editor/native/routes.ts'
import { V2_MEDIA_ROUTES, v2MediaRoute } from './v2-media-store.mjs'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(tmpdir(), 'starmap-virtual-module-test')
const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })

/** 3C-5B：虚拟模块给出的读模型地址：开发服务器的只读端点（新库带修订号，还不是新库带 V2 文件的摘要），个人构建的数据文件。 */
const DEV_URL = '__travelatlas/editor/read-model?revision=42'
const V2_URL = '__travelatlas/editor/read-model?v2=0123456789abcdef'
const BUILD_URL = 'data/read-model.0123456789abcdef.json'
const LEGACY_EXPORT_NAMES = ['privateEditorState', 'privateMediaCatalog', 'privateTravelMap', 'privateWantToGo', 'privateDataMode']

/** 在 Node 里执行渲染出的模块源码，拿到导出（等价于浏览器 import 虚拟模块）。 */
const evaluateModule = async (source) => import(`data:text/javascript,${encodeURIComponent(source)}`)

// ---------------------------------------------------------------------------
// 私人目录的路径与 V2 文件名
// ---------------------------------------------------------------------------

test('getPrivatePaths：V2 文件在 data/v2/ 下，文件名与 v2Schema.ts 的 V2_FILE_NAMES 相同；键与 V2_FILE_KEYS 相同；没有数据模式标记与旧格式媒体源文件索引的路径', () => {
  assert.deepEqual(V2_DATA_FILE_NAMES, V2_FILE_NAMES)
  assert.deepEqual(V2_PRIVATE_FILE_KEYS, V2_FILE_KEYS)
  assert.equal(paths.v2DataRoot, path.join(root, 'data', 'v2'))
  assert.deepEqual(
    paths.v2FilePaths,
    Object.fromEntries(Object.entries(V2_FILE_NAMES).map(([key, name]) => [key, path.join(root, 'data', 'v2', name)])),
  )
  assert.equal(Object.hasOwn(paths, 'dataModePath'), false)
  assert.equal(Object.hasOwn(paths, 'mediaSourceIndexPath'), false, 'PR5b 删除')
})

// ---------------------------------------------------------------------------
// 虚拟模块
// ---------------------------------------------------------------------------

test('虚拟模块有六个导出：privateReadModelUrl（3C-5B：读模型的地址，读模型从不内联）、privateLegacyUnmigrated、privateStoreRevision（3C-3）、privateStoreReadOnly（3C-4b）、privateStoreMigrationRequired 与 privateStoreRecoveryRequired（3C-4d）；没有 privateV2Files、privateReadModel、旧格式的四个导出与 privateDataMode', () => {
  assert.deepEqual(PRIVATE_DATA_MODULE_EXPORTS, ['privateReadModelUrl', 'privateLegacyUnmigrated', 'privateStoreRevision', 'privateStoreReadOnly', 'privateStoreMigrationRequired', 'privateStoreRecoveryRequired'])
  for (const profile of ['public', 'personal']) {
    const exports = privateDataModuleExports({ profile, readModelUrl: DEV_URL, legacyUnmigrated: true })
    assert.deepEqual(Object.keys(exports), PRIVATE_DATA_MODULE_EXPORTS, profile)
    for (const name of [...LEGACY_EXPORT_NAMES, 'privateV2Files', 'privateReadModel']) assert.equal(Object.hasOwn(exports, name), false, `${profile} ${name}`)
  }
})

test('虚拟模块 · 公开模式：privateReadModelUrl 与 privateStoreRevision 为 undefined，其余四个恒为 false；忽略传入的值', async () => {
  const expected = { privateReadModelUrl: undefined, privateLegacyUnmigrated: false, privateStoreRevision: undefined, privateStoreReadOnly: false, privateStoreMigrationRequired: false, privateStoreRecoveryRequired: false }
  assert.deepEqual(privateDataModuleExports({ profile: 'public' }), expected)
  assert.deepEqual(privateDataModuleExports({ profile: 'public', readModelUrl: BUILD_URL, legacyUnmigrated: true, storeRevision: 7, storeReadOnly: true, storeMigrationRequired: true, storeRecoveryRequired: true }), expected)
  const source = renderPrivateDataModule(expected)
  assert.equal(source, 'export const privateReadModelUrl = undefined;\nexport const privateLegacyUnmigrated = false;\nexport const privateStoreRevision = undefined;\nexport const privateStoreReadOnly = false;\nexport const privateStoreMigrationRequired = false;\nexport const privateStoreRecoveryRequired = false;')
  assert.deepEqual({ ...(await evaluateModule(source)) }, expected)
})

test('虚拟模块 · 个人模式（3C-5B）：只给出读模型的地址，数据不进模块；privateLegacyUnmigrated 如实传出', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', readModelUrl: DEV_URL, legacyUnmigrated: false })
  assert.equal(exports.privateReadModelUrl, DEV_URL)
  assert.equal(exports.privateLegacyUnmigrated, false)
  const source = renderPrivateDataModule(exports)
  assert.ok(source.length < 400, 'six short exports, no data')
  const module = await evaluateModule(source)
  assert.equal(module.privateReadModelUrl, DEV_URL)
  assert.equal(module.privateLegacyUnmigrated, false)

  // 未迁移的旧格式数据：还不是新库，地址带 V2 文件的摘要（没有文件时是空文件迁移出的读模型）；另报 privateLegacyUnmigrated。
  const unmigrated = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', readModelUrl: V2_URL, legacyUnmigrated: true })))
  assert.equal(unmigrated.privateReadModelUrl, V2_URL)
  assert.equal(unmigrated.privateLegacyUnmigrated, true)
  // 只接受 true：别的真值不算。
  assert.equal(privateDataModuleExports({ profile: 'personal', legacyUnmigrated: 'yes' }).privateLegacyUnmigrated, false)
  // 只接受非空字符串的地址。
  for (const invalid of ['', 42, null, undefined]) assert.equal(privateDataModuleExports({ profile: 'personal', readModelUrl: invalid }).privateReadModelUrl, undefined, String(invalid))
})

test('虚拟模块 · 个人构建（3C-5B）：地址是过滤后的数据文件', async () => {
  const module = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', readModelUrl: BUILD_URL, storeRevision: 4 })))
  assert.equal(module.privateReadModelUrl, BUILD_URL)
  assert.equal(module.privateStoreRevision, 4)
})

test('虚拟模块 · 新库模式（3C-3）：privateStoreRevision 是全库修订号；只接受非负的安全整数', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', readModelUrl: DEV_URL, storeRevision: 42 })
  assert.equal(exports.privateReadModelUrl, DEV_URL)
  assert.equal((await evaluateModule(renderPrivateDataModule(exports))).privateStoreRevision, 42)
  assert.equal(privateDataModuleExports({ profile: 'personal', storeRevision: 0 }).privateStoreRevision, 0)
  for (const invalid of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(privateDataModuleExports({ profile: 'personal', storeRevision: invalid }).privateStoreRevision, undefined, String(invalid))
  }
})

test('虚拟模块 · 新库模式（3C-4b）：privateStoreReadOnly 只在库损坏、只读时为 true，数据照常给出；只接受 true', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', readModelUrl: DEV_URL, storeRevision: 3, storeReadOnly: true })
  const module = await evaluateModule(renderPrivateDataModule(exports))
  assert.equal(module.privateStoreReadOnly, true)
  assert.equal(module.privateStoreRevision, 3)
  assert.equal(module.privateReadModelUrl, DEV_URL)
  assert.equal(privateDataModuleExports({ profile: 'personal', storeRevision: 3 }).privateStoreReadOnly, false)
  for (const value of [false, 'yes', 1, undefined]) {
    assert.equal(privateDataModuleExports({ profile: 'personal', storeReadOnly: value }).privateStoreReadOnly, false, String(value))
  }
})

test('虚拟模块 · 不是新库（3C-4d）：privateStoreMigrationRequired 与 privateStoreRecoveryRequired 如实传出，只接受 true；数据照常给出', async () => {
  const migration = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', readModelUrl: V2_URL, storeMigrationRequired: true })))
  assert.equal(migration.privateStoreMigrationRequired, true)
  assert.equal(migration.privateStoreRecoveryRequired, false)
  assert.equal(migration.privateStoreRevision, undefined)
  assert.equal(migration.privateReadModelUrl, V2_URL)
  const recovery = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', readModelUrl: V2_URL, storeRecoveryRequired: true })))
  assert.equal(recovery.privateStoreRecoveryRequired, true)
  assert.equal(recovery.privateStoreMigrationRequired, false)
  for (const value of [false, 'yes', 1, undefined]) {
    const exports = privateDataModuleExports({ profile: 'personal', storeMigrationRequired: value, storeRecoveryRequired: value })
    assert.equal(exports.privateStoreMigrationRequired, false, String(value))
    assert.equal(exports.privateStoreRecoveryRequired, false, String(value))
  }
})

// ---------------------------------------------------------------------------
// 私人数据目录的文件事件
// ---------------------------------------------------------------------------

test('文件事件：data/v2/ 之内的新建、修改、删除都要处理（V2 文件、源文件索引、临时文件，含 data/v2/ 本身）', () => {
  assert.deepEqual(PRIVATE_DATA_WATCH_EVENTS, ['add', 'change', 'unlink'])
  const inside = [
    paths.v2FilePaths.places,
    paths.v2FilePaths.media,
    paths.v2MediaSourceIndexPath,
    path.join(paths.v2DataRoot, 'places.local.json.1234.tmp'),
    paths.v2DataRoot,
  ]
  for (const event of ['add', 'change', 'unlink']) {
    for (const filePath of inside) assert.equal(shouldHandlePrivateDataChange(event, filePath, paths), true, `${event} ${filePath}`)
  }
  // 路径末尾带分隔符也一样。
  assert.equal(shouldHandlePrivateDataChange('add', `${paths.v2DataRoot}${path.sep}`, paths), true)
})

test('文件事件：四个旧数据文件只处理新建与删除（它们的有无决定「未迁移」）；内容修改不处理（App 不读它们）', () => {
  for (const filePath of legacyDataPaths(paths)) {
    assert.equal(shouldHandlePrivateDataChange('add', filePath, paths), true, `add ${filePath}`)
    assert.equal(shouldHandlePrivateDataChange('unlink', filePath, paths), true, `unlink ${filePath}`)
    assert.equal(shouldHandlePrivateDataChange('change', filePath, paths), false, `change ${filePath}`)
  }
})

test('文件事件：新库文件 data/store/world.sqlite 只处理新建与删除（它的有无决定数据模式）；它的修改与日志文件不处理（3C-3）', () => {
  const storeFile = path.join(paths.dataRoot, 'store', 'world.sqlite')
  assert.equal(shouldHandlePrivateDataChange('add', storeFile, paths), true)
  assert.equal(shouldHandlePrivateDataChange('unlink', storeFile, paths), true)
  assert.equal(shouldHandlePrivateDataChange('change', storeFile, paths), false)
  for (const other of [`${storeFile}-journal`, path.join(paths.dataRoot, 'store'), path.join(paths.dataRoot, 'store', 'world.sqlite.bak')]) {
    for (const event of ['add', 'change', 'unlink']) assert.equal(shouldHandlePrivateDataChange(event, other, paths), false, `${event} ${other}`)
  }
})

test('文件事件：PR4 的数据模式标记、迁移清单、旧格式的 .bak 与源文件索引、data/ 之外、只是前缀相同的兄弟目录、目录事件与其他事件都不处理', () => {
  for (const filePath of [
    path.join(paths.dataRoot, 'data-mode.local.json'),
    path.join(paths.dataRoot, 'migration', 'identity-manifest.local.json'),
    path.join(paths.dataRoot, 'travel-map.local.bak'),
    path.join(paths.dataRoot, 'travel-map.local.json.1234.tmp'),
    path.join(paths.dataRoot, 'media-source-index.local.json'),
    paths.dataRoot,
    path.join(paths.root, 'config', '.env.local'),
    path.join(paths.root, 'MediaInbox', 'Iceland', 'Reykjavik', 'photos', 'a.jpg'),
    path.join(paths.dataRoot, 'v2-backup', 'places.local.json'),
    `${paths.v2DataRoot}2${path.sep}places.local.json`,
    path.join(paths.root, 'data-backup', 'v2', 'places.local.json'),
    paths.root,
    path.join(webRoot, 'src', 'App.tsx'),
  ]) {
    for (const event of ['add', 'change', 'unlink']) {
      assert.equal(shouldHandlePrivateDataChange(event, filePath, paths), false, `${event} ${filePath}`)
    }
  }
  for (const event of ['addDir', 'unlinkDir', 'ready', 'error', 'all', 'raw']) {
    assert.equal(shouldHandlePrivateDataChange(event, paths.v2FilePaths.places, paths), false, event)
    assert.equal(shouldHandlePrivateDataChange(event, paths.localTravelMapPath, paths), false, event)
  }
})

// ---------------------------------------------------------------------------
// 编辑接口：两张写入路由表
// ---------------------------------------------------------------------------

const WRITE_ENDPOINTS = [
  'POST /__travelatlas/editor/view',
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
const MEDIA_ENDPOINTS = [
  'POST /__travelatlas/editor/upload',
  'POST /__travelatlas/editor/import',
  'POST /__travelatlas/editor/media/delete',
]
const NON_MEDIA_WRITE_ENDPOINTS = WRITE_ENDPOINTS.filter((endpoint) => !MEDIA_ENDPOINTS.includes(endpoint))
const READ_ONLY_ENDPOINTS = [
  'GET /__travelatlas/editor/catalog/countries',
  'GET /__travelatlas/editor/catalog/cities',
]

const pluginSource = () => readFileSync(path.join(webRoot, 'scripts', 'local-editor-plugin.mjs'), 'utf8').replace(/\r\n/g, '\n')

/** 从 `start` 到 `end`（`includeEnd` 时含 end）的原文。 */
const sourceBetween = (source, start, end, includeEnd) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to >= 0, `找不到源码区段：${start}`)
  return source.slice(from, includeEnd ? to + end.length : to)
}

test('插件的编辑接口：只读端点（两个目录搜索；读模型按常量路径）是插件里仅有的按方法与路径写死的分支；11 个写入端点全在两张路由表里', () => {
  const branches = [...pluginSource().matchAll(/request\.method === '([A-Z]+)' && url\.pathname === '([^']+)'/g)].map(([, method, pathname]) => `${method} ${pathname}`)
  assert.deepEqual([...branches].sort(), [...READ_ONLY_ENDPOINTS].sort())
  assert.equal(WRITE_ENDPOINTS.length, 11)
  assert.deepEqual(
    [...Object.keys(STORE_WRITE_ROUTES), ...Object.keys(V2_MEDIA_ROUTES)].sort(),
    [...WRITE_ENDPOINTS].sort(),
  )
})

test('媒体路由表：三个媒体端点经 V2_MEDIA_ROUTES；别的端点（含换了方法的）没有媒体路由', () => {
  assert.deepEqual(Object.keys(V2_MEDIA_ROUTES).sort(), [...MEDIA_ENDPOINTS].sort())
  assert.deepEqual(Object.fromEntries(MEDIA_ENDPOINTS.map((endpoint) => [endpoint, v2MediaRoute(...endpoint.split(' '))])), {
    'POST /__travelatlas/editor/upload': 'upload',
    'POST /__travelatlas/editor/import': 'import',
    'POST /__travelatlas/editor/media/delete': 'delete',
  })
  for (const endpoint of [...NON_MEDIA_WRITE_ENDPOINTS, ...READ_ONLY_ENDPOINTS, 'GET /__travelatlas/editor/upload', 'POST /__travelatlas/editor/media']) {
    assert.equal(v2MediaRoute(...endpoint.split(' ')), undefined, endpoint)
  }
})

test('非媒体路由表正好是 8 个写入端点（3C-5 E：都是存储原生的规划器；PUT /state 已删除）；没列进去的接口（包括将来新加的、媒体端点、换了方法的）没有路由；成功状态码不变', () => {
  assert.deepEqual(Object.keys(STORE_WRITE_ROUTES).sort(), [...NON_MEDIA_WRITE_ENDPOINTS].sort())
  assert.deepEqual(Object.keys(NATIVE_WRITES).sort(), [...NON_MEDIA_WRITE_ENDPOINTS].sort())
  for (const endpoint of NON_MEDIA_WRITE_ENDPOINTS) assert.equal(typeof NATIVE_WRITES[endpoint].plan, 'function', endpoint)
  for (const [method, pathname] of [
    ['POST', '/__travelatlas/editor/something-new'],
    ['PUT', '/__travelatlas/editor/state'],
    ['GET', '/__travelatlas/editor/state'],
    ['POST', '/__travelatlas/editor/catalog/cities'],
    ...MEDIA_ENDPOINTS.map((endpoint) => endpoint.split(' ')),
  ]) {
    assert.equal(STORE_WRITE_ROUTES[`${method} ${pathname}`], undefined, `${method} ${pathname}`)
  }
  assert.deepEqual(Object.fromEntries(Object.entries(NATIVE_WRITES).map(([endpoint, route]) => [endpoint, route.status])), {
    'POST /__travelatlas/editor/view': 200,
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
// 插件源码：只走 V2，未迁移时拒绝写入
// 第 7 批：只读端点、虚拟模块的加载与文件事件这三条原来比对源码文本，已改成 local-editor-plugin.test.mjs 里的行为测试。
// ---------------------------------------------------------------------------

test('插件只走 V2：不再 import 数据模式与旧格式的写入模块，没有旧格式的写入逻辑，也不读旧格式的文件', () => {
  const source = pluginSource()
  for (const removed of ['./data-mode.mjs', './local-editor-data-mode.mjs', './want-to-go-store.mjs', './convert-to-travel.mjs', 'travel-map.sample.json']) {
    assert.ok(!source.includes(removed), removed)
  }
  for (const pattern of [
    /resolveDataMode|dataMode/,
    /\bnormalizeState\b|\bemptyState\b|\baddTravelRecord\b|\baddCountry\b|\bdeleteHiddenCountries\b|\bdeleteHiddenMedia\b|\bconvertToTravel\b|\bwantToGoStore\b/,
    /editorStatePath|localTravelMapPath|mediaCatalogPath|wantToGoPath|mediaSourceIndexPath/,
  ]) {
    assert.doesNotMatch(source, pattern)
  }
})

test('写入（3C-4d）：先过本机会话检查，再判「未迁移」（legacyWriteRefusal 回 409），再判「不是新库」（notWritableResponse 回 409），都在读请求体之前；之后只交给新库', () => {
  const source = pluginSource()
  const writeSection = sourceBetween(source, "if (!authorizeWrite(request)) return sendJson(response, 403", '} catch (error) {', false)
  const legacy = writeSection.indexOf('const legacyRefusal = legacyWriteRefusal(legacyDataStateOf(privatePaths))\n          if (legacyRefusal) return sendJson(response, legacyRefusal.status, legacyRefusal.body)')
  const notStore = writeSection.indexOf('if (!storeMode()) {\n            const refused = notWritableResponse(dataState())\n            return sendJson(response, refused.status, refused.body)\n          }')
  const session = writeSection.indexOf('const session = await storeSession()')
  assert.ok(legacy > 0, '有未迁移的拒绝')
  assert.ok(notStore > legacy, '不是新库的拒绝在其后')
  assert.ok(session > notStore, '之后只有新库的写入')
  assert.doesNotMatch(writeSection.slice(0, session), /readJsonBody|editorMutationDepth|withLibraryOperation/, '拒绝之前不读请求体、不取租约、不算编辑器写入')
  assert.doesNotMatch(source, /handleV2Write|handleV2Media|runV2Write|runImporter|handleV2Import|handleV2MediaDelete|handleV2Upload|createLocalEditorImporter/)
})
