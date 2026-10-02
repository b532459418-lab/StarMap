/**
 * V2 写入的端到端测试（RFC-LOC-1 PR3b-2 规格 §3「端到端（Node）」）：在临时私人根上
 *
 *   1. 迁移之后的私人根：中性旧数据迁移后的五个 V2 文件（冻结的 ./fixtures/editor-store-v2.json；RFC-LOC-1 PR5b 之前由
 *      migrate-identity 的 dry-run 与 --apply 现场生成），旧文件作为残留还在；
 *   2. 经 scripts/v2-editor-store.mjs（插件用的同一个 IO 层：读 data/v2/ → 纯函数 → 按顺序原子写盘）执行一组编辑；
 *   3. 每一步之后，磁盘上的五个 V2 文件都通过 validateV2Files、没有悬空引用；四个旧文件逐字节不变；
 *   4. 最后 scripts/baseline.mjs（个人模式） 能正常产出。
 *
 * 另测：全新私人目录从空白开始写，不复制样例；写盘中途失败时的错误码与说明。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict + node:fs + node:child_process + node:crypto。
 * 每次都把 STARMAP_PRIVATE_ROOT 指向本测试用 fs.mkdtemp 建的临时目录，绝不读作者的真实私有层；用例结束时删除临时目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicJsonWrite } from './json-file.mjs'
import { isLegacyUnmigrated, legacyDataStateOf } from './legacy-data.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { V2_EDITOR_ROUTES, createV2WriteContext, readV2EditorState, runV2Write } from './v2-editor-store.mjs'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'
import { completeForWrite, integrityProblems } from '../src/data/v2write/transaction.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY_FILES = ['travel-map.local.json', 'want-to-go.local.json', 'editor-state.local.json', 'user-media.local.json']


/** 中性的国家目录（形状同插件的 world-countries 目录）。 */
const CATALOG = new Map([
  ['IS', { countryCode: 'IS', nameZh: '冰岛', nameEn: 'Iceland', centerLat: 65, centerLng: -18, region: 'Europe' }],
  ['FO', { countryCode: 'FO', nameZh: '法罗群岛', nameEn: 'Faroe Islands', centerLat: 62, centerLng: -7, region: 'Europe' }],
  ['NO', { countryCode: 'NO', nameZh: '挪威', nameEn: 'Norway', centerLat: 62, centerLng: 10, region: 'Europe' }],
  ['GL', { countryCode: 'GL', nameZh: '格陵兰', nameEn: 'Greenland', centerLat: 72, centerLng: -40, region: 'Americas' }],
  ['JP', { countryCode: 'JP', nameZh: '日本', nameEn: 'Japan', centerLat: 36, centerLng: 138, region: 'Asia' }],
  ['DK', { countryCode: 'DK', nameZh: '丹麦', nameEn: 'Denmark', centerLat: 56, centerLng: 10, region: 'Europe' }],
])

const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-v2-writes-test-'))
  const root = path.join(directory, 'private')
  const out = path.join(directory, 'out')
  await mkdir(path.join(root, 'data'), { recursive: true })
  await mkdir(out, { recursive: true })
  try {
    await run({ root, out, paths: getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }) })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const runScript = (script, args, privateRoot) => spawnSync(process.execPath, [path.join(webRoot, 'scripts', script), ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

const writePrivate = (root, name, value) => writeFile(path.join(root, 'data', name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')

/**
 * 迁移之后的私人根：data/v2/ 是中性旧数据（公开样例的足迹另加一条挪威卑尔根的 planned，想去里特罗姆瑟隐藏，editor-state 与
 * 媒体各几条）迁移后的五个文件（冻结的 ./fixtures/editor-store-v2.json）；四个旧文件作为残留还在（内容无所谓，最小的 JSON）。
 */
const writeMigratedRoot = async (root, paths) => {
  const files = JSON.parse(readFileSync(path.join(webRoot, 'scripts', 'fixtures', 'editor-store-v2.json'), 'utf8'))
  for (const key of V2_FILE_KEYS) await atomicJsonWrite(paths.v2FilePaths[key], files[key])
  await writePrivate(root, 'travel-map.local.json', { schema_version: 1, records: [] })
  await writePrivate(root, 'want-to-go.local.json', { schema_version: 1, items: [] })
  await writePrivate(root, 'editor-state.local.json', { schemaVersion: 1 })
  await writePrivate(root, 'user-media.local.json', { schemaVersion: 2, items: [] })
}

const sha256OfFile = async (filePath) => (existsSync(filePath) ? createHash('sha256').update(await readFile(filePath)).digest('hex') : null)

const legacySnapshot = async (root) => Object.fromEntries(await Promise.all(
  LEGACY_FILES.map(async (name) => [name, await sha256OfFile(path.join(root, 'data', name))]),
))

const readDiskV2 = async (paths) => Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => {
  const filePath = paths.v2FilePaths[key]
  return [key, existsSync(filePath) ? JSON.parse(await readFile(filePath, 'utf8')) : undefined]
})))

/** 磁盘上的 V2 文件（缺的按空处理）通过完整性检查：validateV2Files + 没有悬空引用。 */
const assertDiskIntact = async (paths, label) => {
  const files = await readDiskV2(paths)
  const problems = integrityProblems(completeForWrite(files, new Date()))
  assert.deepEqual(problems, [], `${label}：完整性检查`)
  return files
}

const placeByEn = (files, en) => files.places.places.find((place) => place.names.en === en)

/** 按插件的方式执行一个 V2 写入端点，之后检查完整性与旧文件哈希。 */
const editor = (paths, legacyBefore) => async (endpoint, input, label = endpoint) => {
  const result = await runV2Write({
    privatePaths: paths,
    route: V2_EDITOR_ROUTES[endpoint],
    input,
    ctx: createV2WriteContext({ countryCatalog: CATALOG }),
  })
  const files = await assertDiskIntact(paths, label)
  assert.deepEqual(await legacySnapshot(paths.root), legacyBefore, `${label}：旧文件的 sha256 不变`)
  return { ...result, files }
}

const getState = async (paths) => {
  const result = await readV2EditorState({ privatePaths: paths })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.state
}

const putState = (run, paths) => async (update, label) => run('PUT /__travelatlas/editor/state', update(await getState(paths)), label)

test('端到端：迁移之后的私人根 → 一组编辑；每一步五个 V2 文件都合法、无悬空引用，旧文件不变；最后 scripts/baseline.mjs（个人模式） 正常产出', () => withTemp(async ({ root, out, paths }) => {
  await writeMigratedRoot(root, paths)
  // 迁移之后是残留（旧文件与 V2 文件都在）：不算未迁移，写入照常。
  assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), false)
  const legacyBefore = await legacySnapshot(root)
  const run = editor(paths, legacyBefore)
  const put = putState(run, paths)
  const migrated = await assertDiskIntact(paths, '迁移后')
  const iceland = placeByEn(migrated, 'Iceland').id
  const faroe = placeByEn(migrated, 'Faroe Islands').id
  const gjogv = placeByEn(migrated, 'Gjogv').id

  // 1. 调换国家顺序；隐藏一个城市再恢复。
  assert.deepEqual((await getState(paths)).countryOrder, [faroe, iceland])
  let step = await put((state) => ({ ...state, countryOrder: [iceland, faroe] }), '调换国家顺序')
  assert.equal(step.status, 200, JSON.stringify(step.body))
  assert.deepEqual(step.files.editorState.countryOrder, [iceland, faroe])
  step = await put((state) => ({ ...state, hiddenCityIds: [...state.hiddenCityIds, gjogv] }), '隐藏杰格夫')
  assert.ok(step.files.editorState.hiddenCityIds.includes(gjogv))
  step = await put((state) => ({ ...state, hiddenCityIds: state.hiddenCityIds.filter((id) => id !== gjogv) }), '恢复杰格夫')
  assert.equal(step.files.editorState.hiddenCityIds.includes(gjogv), false)

  // 2. 新增国家；在该国家新增一个城市。
  step = await run('POST /__travelatlas/editor/countries', { countryCode: 'JP', visitedDate: '2026-05-01' }, '新增日本')
  assert.equal(step.status, 201, JSON.stringify(step.body))
  const japan = step.body.countryId
  assert.equal(placeByEn(step.files, 'Japan').id, japan)
  step = await run('POST /__travelatlas/editor/records', {
    country: '日本', country_en: 'Japan', country_code: 'jp', city: '东京', city_en: 'Tokyo', start_date: '2026-05-02', lat: 35.6762, lng: 139.6503,
  }, '新增东京')
  assert.equal(step.status, 201, JSON.stringify(step.body))
  assert.equal(step.body.countryId, japan)
  const tokyoRecord = step.files.travel.records.find((record) => record.id === step.body.id)
  assert.equal(tokyoRecord.placeId, step.body.cityId)
  assert.match(tokyoRecord.journeyId, /^journey-/)

  // 3. 新增一个想去城市，隐藏它，再彻底删除（只被它引用的地点一并删除）。
  step = await run('POST /__travelatlas/editor/wanttogo', { place: { kind: 'city', nameZh: '京都', nameEn: 'Kyoto', countryCode: 'JP', lat: 35.0116, lng: 135.7681 } }, '新增想去京都')
  assert.equal(step.status, 201, JSON.stringify(step.body))
  const kyotoItem = step.body.id
  assert.equal(step.body.item.place.nameEn, 'Kyoto')
  const kyoto = placeByEn(step.files, 'Kyoto').id
  step = await run('POST /__travelatlas/editor/wanttogo/update', { id: kyotoItem, hidden: true }, '隐藏京都')
  assert.equal(step.body.item.hidden, true)
  step = await run('POST /__travelatlas/editor/wanttogo/delete', { ids: [kyotoItem] }, '删除京都')
  assert.deepEqual(step.body, { ok: true, deletedIds: [kyotoItem] })
  assert.equal(step.files.places.places.some((place) => place.id === kyoto), false)
  assert.ok(step.files.places.places.some((place) => place.id === japan), '日本仍在足迹里')

  // 4. 再新增想去城市并转为足迹：勾选「保留在想去」一次（奥斯陆）、不勾一次（斯塔万格）。
  step = await run('POST /__travelatlas/editor/wanttogo', { place: { kind: 'city', nameZh: '奥斯陆', nameEn: 'Oslo', countryCode: 'NO', lat: 59.9139, lng: 10.7522 } }, '新增想去奥斯陆')
  const osloItem = step.body.id
  step = await run('POST /__travelatlas/editor/wanttogo/convert', { source: 'want-to-go', id: osloItem, startDate: '2026-06-01', keepWantToGo: true }, '奥斯陆转足迹（保留）')
  assert.equal(step.status, 200, JSON.stringify(step.body))
  assert.equal(step.body.wantToGoRemoved, false)
  const norway = step.body.countryId
  const norwayCountry = { placeId: norway, region: 'Europe', visitedDate: '2026-06-01' }
  assert.deepEqual(step.files.editorState.addedCountries.find((country) => country.placeId === norway), norwayCountry)
  assert.ok(step.files.wantToGo.items.some((item) => item.id === osloItem))
  assert.ok(step.files.editorState.countryOrder.includes(norway), '挪威首次进入足迹，进入国家顺序')
  step = await run('POST /__travelatlas/editor/wanttogo', { place: { kind: 'city', nameZh: '斯塔万格', nameEn: 'Stavanger', countryCode: 'NO', lat: 58.97, lng: 5.7331 } }, '新增想去斯塔万格')
  const stavangerItem = step.body.id
  step = await run('POST /__travelatlas/editor/wanttogo/convert', { source: 'want-to-go', id: stavangerItem, startDate: '2026-06-03' }, '斯塔万格转足迹（不保留）')
  assert.equal(step.body.wantToGoRemoved, true)
  assert.equal(step.files.wantToGo.items.some((item) => item.id === stavangerItem), false)
  assert.deepEqual(step.files.editorState.addedCountries.find((country) => country.placeId === norway), norwayCountry, '再次转足迹不覆盖国家首次到访信息')

  // 5. planned 转足迹：补 journeyId。
  step = await run('POST /__travelatlas/editor/wanttogo/convert', { source: 'planned', recordId: 'planned_bergen', startDate: '2026-06-05' }, '卑尔根 planned 转足迹')
  assert.equal(step.status, 200, JSON.stringify(step.body))
  const bergen = step.files.travel.records.find((record) => record.id === 'planned_bergen')
  assert.equal(bergen.status, 'visited')
  assert.match(bergen.journeyId, /^journey-/)

  // 6. 隐藏一个没有媒体的国家并彻底删除。
  step = await put((state) => ({ ...state, hiddenCountryIds: [japan] }), '隐藏日本')
  step = await run('POST /__travelatlas/editor/countries/delete', { ids: [japan] }, '删除日本')
  assert.deepEqual(step.body, { ok: true, deletedCountryIds: [japan], deletedRecordCount: 1 })
  assert.equal(step.files.places.places.some((place) => place.id === japan), false)
  assert.equal(step.files.editorState.addedCountries.some((country) => country.placeId === japan), false, '日本的国家元信息已删除')
  assert.deepEqual(step.files.editorState.addedCountries, [norwayCountry], '挪威的洲与首次到访日期仍保留')

  // 拒绝：返回 { ok: false, error, code }，不写。
  const before = await readDiskV2(paths)
  step = await run('POST /__travelatlas/editor/records', {
    country: '冰岛', country_en: 'Iceland', country_code: 'IS', city: '雷克雅未克', city_en: 'Reykjavik', start_date: '2026-01-01', lat: 64.1466, lng: -21.9426,
  }, '重复城市')
  assert.equal(step.status, 400)
  assert.deepEqual(step.body, { ok: false, error: '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。', code: 'E_CITY_EXISTS', params: { cityId: placeByEn(migrated, 'Reykjavik').id } })
  assert.deepEqual(await readDiskV2(paths), before)
  step = await put((state) => ({ ...state, hiddenCityIds: ['iceland__vik'] }), '旧键')
  assert.equal(step.status, 400)
  assert.equal(step.body.code, 'E_UNKNOWN_PLACE_REF')
  assert.deepEqual(await readDiskV2(paths), before)

  // 最后：scripts/baseline.mjs（个人模式） 能正常产出，城市与国家 id 都是 UUID。
  const target = path.join(out, 'v2-baseline.json')
  const baseline = runScript('baseline.mjs', ['--out', target], root)
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  const { modules } = JSON.parse(await readFile(target, 'utf8'))
  const cityNames = modules.travelAtlas.cities.map((city) => city.nameEn).sort()
  assert.deepEqual(cityNames, ['Akureyri', 'Bergen', 'Gjogv', 'Oslo', 'Reykjavik', 'Stavanger', 'Torshavn'])
  assert.deepEqual(await legacySnapshot(root), legacyBefore)
}))

test('端到端 · 全新私人目录：从空白开始写；生成合法的 data/v2/ 文件；没有任何样例数据', () => withTemp(async ({ root, out, paths }) => {
  const run = editor(paths, await legacySnapshot(root))
  const { updatedAt, ...emptyState } = await getState(paths)
  assert.equal(typeof updatedAt, 'string')
  assert.deepEqual(emptyState, {
    schemaVersion: 1, addedCountries: [], countryOrder: [], hiddenCountryIds: [], cityOrderByCountry: {}, hiddenCityIds: [],
    mediaOrderByCity: {}, hiddenMediaIds: [], coverMediaByCity: {}, droneOrderByCity: {}, hiddenDroneMediaIds: [],
  })
  assert.equal(existsSync(paths.v2DataRoot), false, 'GET 不写文件')

  let step = await run('POST /__travelatlas/editor/countries', { countryCode: 'IS', visitedDate: '2026-01-01' }, '新增冰岛')
  assert.equal(step.status, 201, JSON.stringify(step.body))
  assert.deepEqual((await readdir(paths.v2DataRoot)).sort(), [V2_FILE_NAMES.editorState, V2_FILE_NAMES.places].sort())
  step = await run('POST /__travelatlas/editor/records', {
    country: '冰岛', country_en: 'Iceland', country_code: 'IS', city: '雷克雅未克', city_en: 'Reykjavik', start_date: '2026-01-02', lat: 64.1466, lng: -21.9426,
  }, '新增雷克雅未克')
  assert.equal(step.status, 201, JSON.stringify(step.body))
  assert.equal(step.files.travel.privacy_level, 'private-local')
  assert.equal(step.files.travel.records.length, 1)
  assert.equal(step.files.places.places.length, 2)
  assert.equal(existsSync(paths.localTravelMapPath), false, '不写旧文件')
  const text = JSON.stringify(step.files)
  assert.ok(!text.includes('sample') && !text.includes('Faroe'), '没有复制样例')

  const target = path.join(out, 'fresh.json')
  const baseline = runScript('baseline.mjs', ['--out', target], root)
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).modules.travelAtlas.cities.map((city) => city.nameEn), ['Reykjavik'])
}))

test('写盘中途失败：第一步失败 → E_WRITE_FAILED，什么都没写；之后的步骤失败 → 旧模式式的说明（E_PARTIAL_WRITE），已写的文件仍无悬空引用', () => withTemp(async ({ paths }) => {
  const input = { country: '丹麦', country_en: 'Denmark', country_code: 'DK', city: '哥本哈根', city_en: 'Copenhagen', start_date: '2026-03-01', lat: 55.6761, lng: 12.5683 }
  const failOn = (file) => async (target, value) => {
    if (target === paths.v2FilePaths[file]) throw new Error('磁盘已满。')
    return atomicJsonWrite(target, value)
  }
  const route = V2_EDITOR_ROUTES['POST /__travelatlas/editor/records']
  const ctx = () => createV2WriteContext({ countryCatalog: CATALOG })

  const first = await runV2Write({ privatePaths: paths, route, input, ctx: ctx(), write: failOn('places') })
  assert.equal(first.status, 400)
  assert.deepEqual(first.body, { ok: false, error: '磁盘已满。', code: 'E_WRITE_FAILED', params: { written: [], failed: 'places', reason: '磁盘已满。' } })
  assert.equal(existsSync(paths.v2DataRoot), false)

  const partial = await runV2Write({ privatePaths: paths, route, input, ctx: ctx(), write: failOn('editorState') })
  assert.equal(partial.status, 400)
  assert.equal(partial.body.code, 'E_PARTIAL_WRITE')
  assert.equal(partial.body.error, '足迹已创建，但国家列表的排序没有更新（磁盘已满）。')
  assert.deepEqual(partial.body.params.written, ['places', 'travel'])
  const files = await assertDiskIntact(paths, '部分写入之后')
  assert.equal(files.travel.records.length, 1)
  assert.equal(files.editorState, undefined)

  // 没有说明模板的后续步骤：原样报原因并列出已写的文件（地点注册表写了、足迹没写：只留下没人引用的地点）。
  await rm(paths.v2DataRoot, { recursive: true, force: true })
  const orphan = await runV2Write({ privatePaths: paths, route, input, ctx: ctx(), write: failOn('travel') })
  assert.deepEqual({ code: orphan.body.code, error: orphan.body.error, written: orphan.body.params.written }, { code: 'E_WRITE_FAILED', error: '磁盘已满。', written: ['places'] })
  await assertDiskIntact(paths, '只写了地点之后')
}))
