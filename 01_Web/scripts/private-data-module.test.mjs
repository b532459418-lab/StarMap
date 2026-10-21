/**
 * scripts/private-data-module.mjs 的测试与本地编辑器插件接线的源码断言（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3；PR3b-2 / PR3b-3 的
 * 写入路由表；PR5a 规格 §4.1、§4.2：数据模式删除，App 与编辑器只读写 V2，未迁移时拒绝写入）。
 * 取代 local-editor-data-mode.test.mjs：与数据模式无关的用例搬到这里，与旧模式有关的随代码删除。
 * 端到端（dev server + curl）在规格的浏览器验证里手工做；Node 端到端见 v2-editor-store.test.mjs 与 v2-media-store.test.mjs。
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
import { V2_EDITOR_ROUTES, v2EditorRoute } from './v2-editor-store.mjs'
import { V2_MEDIA_ROUTES, v2MediaRoute } from './v2-media-store.mjs'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(tmpdir(), 'starmap-virtual-module-test')
const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })

const V2_VALUES = {
  places: { schema_version: 1, generated_at: '2026-09-27', places: [] },
  travel: undefined,
  wantToGo: { schema_version: 2, items: [] },
  editorState: undefined,
  media: { schemaVersion: 3, items: [] },
}
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

test('虚拟模块有六个导出：privateV2Files、privateLegacyUnmigrated、privateStoreRevision（3C-3）、privateStoreReadOnly（3C-4b）、privateStoreMigrationRequired 与 privateStoreRecoveryRequired（3C-4d）；旧格式的四个导出与 privateDataMode 已删除', () => {
  assert.deepEqual(PRIVATE_DATA_MODULE_EXPORTS, ['privateV2Files', 'privateLegacyUnmigrated', 'privateStoreRevision', 'privateStoreReadOnly', 'privateStoreMigrationRequired', 'privateStoreRecoveryRequired'])
  for (const profile of ['public', 'personal']) {
    const exports = privateDataModuleExports({ profile, v2Values: V2_VALUES, legacyUnmigrated: true })
    assert.deepEqual(Object.keys(exports), PRIVATE_DATA_MODULE_EXPORTS, profile)
    for (const name of LEGACY_EXPORT_NAMES) assert.equal(Object.hasOwn(exports, name), false, `${profile} ${name}`)
  }
})

test('虚拟模块 · 公开模式：privateV2Files 与 privateStoreRevision 为 undefined，其余四个恒为 false；忽略传入的值', async () => {
  const expected = { privateV2Files: undefined, privateLegacyUnmigrated: false, privateStoreRevision: undefined, privateStoreReadOnly: false, privateStoreMigrationRequired: false, privateStoreRecoveryRequired: false }
  assert.deepEqual(privateDataModuleExports({ profile: 'public' }), expected)
  assert.deepEqual(privateDataModuleExports({ profile: 'public', v2Values: V2_VALUES, legacyUnmigrated: true, storeRevision: 7, storeReadOnly: true, storeMigrationRequired: true, storeRecoveryRequired: true }), expected)
  const source = renderPrivateDataModule(expected)
  assert.equal(source, 'export const privateV2Files = undefined;\nexport const privateLegacyUnmigrated = false;\nexport const privateStoreRevision = undefined;\nexport const privateStoreReadOnly = false;\nexport const privateStoreMigrationRequired = false;\nexport const privateStoreRecoveryRequired = false;')
  assert.deepEqual({ ...(await evaluateModule(source)) }, expected)
})

test('虚拟模块 · 个人模式：privateV2Files 是五个 V2 文件（缺的为 undefined，浏览器里不出现）；privateLegacyUnmigrated 如实传出', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', v2Values: V2_VALUES, legacyUnmigrated: false })
  assert.deepEqual(Object.keys(exports.privateV2Files), V2_FILE_KEYS)
  assert.deepEqual(exports.privateV2Files, V2_VALUES)
  assert.equal(exports.privateLegacyUnmigrated, false)

  const module = await evaluateModule(renderPrivateDataModule(exports))
  assert.deepEqual(Object.keys(module.privateV2Files), ['places', 'wantToGo', 'media'])
  assert.equal(module.privateV2Files.travel, undefined)
  assert.equal(module.privateLegacyUnmigrated, false)

  // 未迁移：data/v2/ 里没有文件（五个都缺），另报 privateLegacyUnmigrated。
  const unmigrated = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', legacyUnmigrated: true })))
  assert.deepEqual(unmigrated.privateV2Files, {})
  assert.equal(unmigrated.privateLegacyUnmigrated, true)
  // 只接受 true：别的真值不算。
  assert.equal(privateDataModuleExports({ profile: 'personal', legacyUnmigrated: 'yes' }).privateLegacyUnmigrated, false)
  // V2 模式没有修订号。
  assert.equal(exports.privateStoreRevision, undefined)
  assert.equal(module.privateStoreRevision, undefined)
})

test('虚拟模块 · 新库模式（3C-3）：privateStoreRevision 是全库修订号；只接受非负的安全整数', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', v2Values: V2_VALUES, storeRevision: 42 })
  assert.deepEqual(exports.privateV2Files, V2_VALUES)
  assert.equal((await evaluateModule(renderPrivateDataModule(exports))).privateStoreRevision, 42)
  assert.equal(privateDataModuleExports({ profile: 'personal', storeRevision: 0 }).privateStoreRevision, 0)
  for (const invalid of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(privateDataModuleExports({ profile: 'personal', storeRevision: invalid }).privateStoreRevision, undefined, String(invalid))
  }
})

test('虚拟模块 · 新库模式（3C-4b）：privateStoreReadOnly 只在库损坏、只读时为 true，数据照常导出；只接受 true', async () => {
  const exports = privateDataModuleExports({ profile: 'personal', v2Values: V2_VALUES, storeRevision: 3, storeReadOnly: true })
  const module = await evaluateModule(renderPrivateDataModule(exports))
  assert.equal(module.privateStoreReadOnly, true)
  assert.equal(module.privateStoreRevision, 3)
  assert.deepEqual(Object.keys(module.privateV2Files), ['places', 'wantToGo', 'media'])
  assert.equal(privateDataModuleExports({ profile: 'personal', storeRevision: 3 }).privateStoreReadOnly, false)
  for (const value of [false, 'yes', 1, undefined]) {
    assert.equal(privateDataModuleExports({ profile: 'personal', storeReadOnly: value }).privateStoreReadOnly, false, String(value))
  }
})

test('虚拟模块 · 不是新库（3C-4d）：privateStoreMigrationRequired 与 privateStoreRecoveryRequired 如实传出，只接受 true；数据照常导出', async () => {
  const migration = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', v2Values: V2_VALUES, storeMigrationRequired: true })))
  assert.equal(migration.privateStoreMigrationRequired, true)
  assert.equal(migration.privateStoreRecoveryRequired, false)
  assert.equal(migration.privateStoreRevision, undefined)
  assert.deepEqual(Object.keys(migration.privateV2Files), ['places', 'wantToGo', 'media'])
  const recovery = await evaluateModule(renderPrivateDataModule(privateDataModuleExports({ profile: 'personal', storeRecoveryRequired: true })))
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
const MEDIA_ENDPOINTS = [
  'POST /__travelatlas/editor/upload',
  'POST /__travelatlas/editor/import',
  'POST /__travelatlas/editor/media/delete',
]
const NON_MEDIA_WRITE_ENDPOINTS = WRITE_ENDPOINTS.filter((endpoint) => !MEDIA_ENDPOINTS.includes(endpoint))
const READ_ONLY_ENDPOINTS = [
  'GET /__travelatlas/editor/state',
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

test('插件的编辑接口：只读端点（GET /editor/state、两个目录搜索）是插件里仅有的按方法与路径写死的分支；11 个写入端点全在两张路由表里', () => {
  const branches = [...pluginSource().matchAll(/request\.method === '([A-Z]+)' && url\.pathname === '([^']+)'/g)].map(([, method, pathname]) => `${method} ${pathname}`)
  assert.deepEqual([...branches].sort(), [...READ_ONLY_ENDPOINTS].sort())
  assert.equal(WRITE_ENDPOINTS.length, 11)
  assert.deepEqual(
    [...Object.keys(V2_EDITOR_ROUTES), ...Object.keys(V2_MEDIA_ROUTES)].sort(),
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

test('非媒体路由表正好是 8 个写入端点；没列进去的接口（包括将来新加的、媒体端点、换了方法的）没有路由；成功状态码不变', () => {
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
