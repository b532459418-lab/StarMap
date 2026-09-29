/**
 * `.bak` 文件的锁定测试（RFC-LOC-1 PR4 规格 §2.4；PR5a 规格 §5 按新判定调整）。
 *
 * `atomicJsonWrite`（scripts/json-file.mjs）写入前把旧文件复制成 `<名字>.bak`：这是有意的安全网，保留。
 * 这里锁定它们无害——只测，不改代码：
 *   1. 私人目录 `data/` 与 `data/v2/` 里的 `.bak` 不影响「未迁移」的判定（scripts/legacy-data.mjs：不算旧数据，也不算 V2 文件），
 *      因而也不影响写入拒绝与导入器（PR5b 删除了迁移工具）；
 *   2. `data/v2/` 里的 `.bak` 不影响 V2 读取与校验（虚拟模块、基线工具、编辑状态接口只读五个确切的文件名）；
 *   3. 收件箱里的 `.bak` 不影响导入（导入器跳过它们）。
 * `.bak` 一律写成非法 JSON 或指向别处的内容：它们若被读到，结果一定会变。
 *
 * 运行方式：npm test。私人根一律是 fs.mkdtemp 建的临时目录（STARMAP_PRIVATE_ROOT），绝不读作者的真实私有层；
 * 用例结束时删除。测试图片由 sharp 现场生成。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { hasLegacyData, hasV2Data, isLegacyUnmigrated, legacyDataStateOf, legacyWriteRefusal } from './legacy-data.mjs'
import { privateDataModuleExports } from './private-data-module.mjs'
import { getPrivatePaths, V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
import { V2_EDITOR_ROUTES, createV2WriteContext, readV2EditorState, runV2Write } from './v2-editor-store.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'
import { buildBaseline, stableStringify } from '../src/data/derive/baseline.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_NOW = '2000-01-01T00:00:00.000Z'
const BROKEN = '{ this is not json'

const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-bak-test-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const runScript = (script, args, privateRoot) => spawnSync(process.execPath, [path.join(webRoot, 'scripts', script), ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

const writeJson = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 冻结的五个 V2 文件（./fixtures/，RFC-LOC-1 PR5b：删除迁移工具之前由 migrate-identity 现场生成）。 */
const readFixture = (name) => JSON.parse(readFileSync(path.join(webRoot, 'scripts', 'fixtures', name), 'utf8'))

/** `<目录>/<名字>.json` → `<目录>/<名字>.bak`，与 atomicJsonWrite 的命名相同。 */
const bakOf = (filePath) => filePath.replace(/\.json$/i, '.bak')

// ---------------------------------------------------------------------------
// 1. 「未迁移」的判定
// ---------------------------------------------------------------------------

test('.bak 与「未迁移」：data/ 里只有四个旧文件（与 PR4 数据模式标记）的 .bak → 等于全新目录；不拒绝写入', () => withTemp(async (directory) => {
  const root = path.join(directory, 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await mkdir(paths.dataRoot, { recursive: true })
  for (const filePath of [paths.localTravelMapPath, paths.wantToGoPath, paths.editorStatePath, paths.mediaCatalogPath]) {
    await writeFile(bakOf(filePath), '{"schema_version":1,"records":[]}', 'utf8')
  }
  await writeFile(path.join(paths.dataRoot, 'data-mode.local.bak'), '{ "mode": "legacy" }', 'utf8')
  assert.equal(hasLegacyData(paths), false)
  assert.deepEqual(legacyDataStateOf(paths), { legacyFiles: [], v2Files: [] })
  assert.equal(legacyWriteRefusal(legacyDataStateOf(paths)), undefined)
}))

test('.bak 与「未迁移」：有旧数据、data/v2/ 里只有 .bak → 不算 V2 文件，仍是未迁移：写入拒绝（409），导入器拒绝（退出码 2），都不写', () => withTemp(async (directory) => {
  const root = path.join(directory, 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await writeJson(paths.localTravelMapPath, { schema_version: 1, records: [] })
  await mkdir(paths.v2DataRoot, { recursive: true })
  for (const filePath of Object.values(paths.v2FilePaths)) await writeFile(bakOf(filePath), '{}', 'utf8')
  assert.equal(hasV2Data(paths), false)
  assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), true)
  assert.equal(legacyWriteRefusal(legacyDataStateOf(paths))?.status, 409)
  const before = (await readdir(paths.v2DataRoot)).sort()
  const refused = runScript('import-media.mjs', ['--apply'], root)
  assert.equal(refused.status, 2, refused.stderr)
  assert.deepEqual((await readdir(paths.v2DataRoot)).sort(), before)
  assert.equal(existsSync(paths.userMediaRoot), false)
}))

// ---------------------------------------------------------------------------
// 2. data/v2/ 里的 .bak
// ---------------------------------------------------------------------------

const CATALOG = new Map([
  ['IS', { countryCode: 'IS', nameZh: '冰岛', nameEn: 'Iceland', centerLat: 65, centerLng: -18, region: 'Europe' }],
  ['NO', { countryCode: 'NO', nameZh: '挪威', nameEn: 'Norway', centerLat: 62, centerLng: 10, region: 'Europe' }],
])

const readFiveV2Files = async (paths) => Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [
  key, JSON.parse(await readFile(paths.v2FilePaths[key], 'utf8')),
])))

const v2BaselineOf = (files) => `${stableStringify(buildBaseline(
  deriveAppDataFromCanonical(canonicalForInputs({ v2Files: files }), { now: BASELINE_NOW }),
  { now: BASELINE_NOW },
))}\n`

test('.bak 在 data/v2/：真实编辑留下的 .bak（甚至改坏）不影响「未迁移」的判定、虚拟模块读的文件、V2 校验、编辑状态接口与 legacy-baseline --path v2', () => withTemp(async (directory) => {
  const root = path.join(directory, 'private')
  const out = path.join(directory, 'out')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  // 迁移之后的私人根：data/v2/ 是公开旧样例的足迹与想去迁移后的五个文件（冻结），旧文件还在（内容无所谓，最小的 JSON）。
  for (const [key, value] of Object.entries(readFixture('bak-files-v2.json'))) await writeJson(paths.v2FilePaths[key], value)
  await writeJson(paths.localTravelMapPath, { schema_version: 1, records: [] })
  await writeJson(paths.wantToGoPath, { schema_version: 1, items: [] })

  // 经插件用的同一个 IO 层做两次编辑：atomicJsonWrite 给被改写的文件留下 .bak（上一版）。
  const ctx = createV2WriteContext({ countryCatalog: CATALOG, newId: sequentialUuids(Date.UTC(2026, 8, 29)) })
  const state = (await readV2EditorState({ privatePaths: paths })).body.state
  const reorder = await runV2Write({ privatePaths: paths, route: V2_EDITOR_ROUTES['PUT /__travelatlas/editor/state'], input: { ...state, countryOrder: [...state.countryOrder].reverse() }, ctx })
  assert.equal(reorder.status, 200, JSON.stringify(reorder.body))
  const add = await runV2Write({
    privatePaths: paths,
    route: V2_EDITOR_ROUTES['POST /__travelatlas/editor/wanttogo'],
    input: { place: { kind: 'city', nameZh: '卑尔根', nameEn: 'Bergen', countryCode: 'NO', lat: 60.3913, lng: 5.3221 } },
    ctx,
  })
  assert.equal(add.status, 201, JSON.stringify(add.body))
  const baks = (await readdir(paths.v2DataRoot)).filter((name) => name.endsWith('.bak')).sort()
  assert.ok(baks.includes('editor-state.local.bak') && baks.includes('want-to-go.local.bak') && baks.includes('places.local.bak'), baks.join(', '))

  const files = await readFiveV2Files(paths)
  assert.deepEqual(validateV2Files(files), [])
  const expected = v2BaselineOf(files)
  assert.ok(expected.includes('Bergen'), '基线反映的是最新一次编辑，不是 .bak 里的上一版')
  const expectedState = await readV2EditorState({ privatePaths: paths })

  const check = async (label) => {
    // 旧文件还在（迁移不动它们）、V2 文件也在：残留，不算未迁移。
    assert.equal(legacyDataStateOf(paths).v2Files.length, 5, label)
    assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), false, label)
    // 虚拟模块（local-editor-plugin.mjs 的 load）只读这五个确切的路径。
    const v2Values = Object.fromEntries(await Promise.all(V2_PRIVATE_FILE_KEYS.map(async (key) => [key, JSON.parse(await readFile(paths.v2FilePaths[key], 'utf8'))])))
    assert.deepEqual(privateDataModuleExports({ profile: 'personal', v2Values }).privateV2Files, files, label)
    assert.deepEqual(await readV2EditorState({ privatePaths: paths }), expectedState, label)
    const target = path.join(out, `${label}.json`)
    const result = runScript('legacy-baseline.mjs', ['--path', 'v2', '--out', target], root)
    assert.equal(result.status, 0, `${label}\n${result.stderr}`)
    assert.equal(await readFile(target, 'utf8'), expected, label)
  }

  await check('with-real-bak')
  // 把每个 V2 文件的 .bak 都改成非法 JSON：若有任何读取方碰它们，上面的检查就会失败。
  for (const filePath of Object.values(paths.v2FilePaths)) await writeFile(bakOf(filePath), BROKEN, 'utf8')
  await check('with-broken-bak')
  // 没有 .bak 时结果相同。
  for (const filePath of Object.values(paths.v2FilePaths)) await rm(bakOf(filePath), { force: true })
  await check('without-bak')
}))

// ---------------------------------------------------------------------------
// 3. 收件箱里的 .bak
// ---------------------------------------------------------------------------

const newId = sequentialUuids(Date.UTC(2026, 8, 29, 1))
const ID = { iceland: newId(), reykjavik: newId() }

const placesFile = () => ({
  schema_version: 1,
  generated_at: '2026-09-29T00:00:00.000Z',
  places: [
    { id: ID.iceland, subtype: 'country', names: { 'zh-Hans': '冰岛', en: 'Iceland' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 }, legacyKeys: ['country:iceland'] },
    { id: ID.reykjavik, subtype: 'city', names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }, partOf: ID.iceland, location: { lat: 64.1466, lng: -21.9426 }, legacyKeys: ['city:iceland__reykjavik'] },
  ],
})

/** 一张纯色小图与一个 2:1 的「航拍」图，生成一次，两个私人根共用同一份字节。 */
const makeImages = async (directory) => {
  const photo = path.join(directory, 'harbour.jpg')
  const drone = path.join(directory, 'bay.jpg')
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg({ quality: 90 }).toFile(photo)
  await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 30, g: 60, b: 200 } } }).jpeg({ quality: 90 }).toFile(drone)
  return { photo, drone }
}

/** 收件箱：Iceland/Reykjavik/photos/harbour.jpg + drone/bay.jpg + media.json + 城市文件夹的 place.json。 */
const writeInbox = async (paths, images) => {
  const city = path.join(paths.inboxRoot, 'Iceland', 'Reykjavik')
  await mkdir(path.join(city, 'photos'), { recursive: true })
  await mkdir(path.join(city, 'drone'), { recursive: true })
  await copyFile(images.photo, path.join(city, 'photos', 'harbour.jpg'))
  await copyFile(images.drone, path.join(city, 'drone', 'bay.jpg'))
  await writeJson(path.join(city, 'media.json'), { 'drone/bay.jpg': { kind: 'aerialPhoto', titleEn: 'Bay', date: '2025-06-02', resolution: '200 × 100', captureType: 'Aerial Photo' } })
  await writeJson(path.join(city, 'place.json'), { placeId: ID.reykjavik })
}

/** 各种 .bak：控制文件的上一版（指向别处或改坏）、媒体文件夹里的 .bak。 */
const addInboxBaks = async (paths) => {
  const country = path.join(paths.inboxRoot, 'Iceland')
  const city = path.join(country, 'Reykjavik')
  await writeFile(path.join(country, 'place.bak'), JSON.stringify({ placeId: '01a0ed02-0000-7000-8000-000000000000' }), 'utf8')
  await writeFile(path.join(country, 'country.bak'), JSON.stringify({ countryId: 'faroe-islands' }), 'utf8')
  await writeFile(path.join(city, 'place.bak'), BROKEN, 'utf8')
  await writeFile(path.join(city, 'media.bak'), JSON.stringify({ 'drone/bay.jpg': { kind: 'panorama360', date: '1999-01-01' } }), 'utf8')
  await writeFile(path.join(city, 'photos', 'harbour.bak'), BROKEN, 'utf8')
  await writeFile(path.join(city, 'drone', 'media.bak'), BROKEN, 'utf8')
}

/** 目录与源文件索引里 generatedAt 以外的内容。 */
const withoutGeneratedAt = (text) => text.replace(/^ {2}"generatedAt": "[^"]*",\n/m, '')

const importInto = async (root, { withBak, images }) => {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await writeJson(paths.v2FilePaths.places, placesFile())
  await writeInbox(paths, images)
  if (withBak) await addInboxBaks(paths)
  const preflight = runScript('import-media.mjs', [], root)
  const applied = runScript('import-media.mjs', ['--apply'], root)
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
  return {
    preflight: preflight.stdout + preflight.stderr,
    output: applied.stdout.replaceAll(root, '<root>') + applied.stderr.replaceAll(root, '<root>'),
    catalog: withoutGeneratedAt(await readFile(paths.v2FilePaths.media, 'utf8')),
    index: withoutGeneratedAt(await readFile(paths.v2MediaSourceIndexPath, 'utf8')),
    generated: (await readdir(paths.userMediaRoot, { recursive: true })).sort(),
  }
}

test('.bak 在收件箱：控制文件与媒体文件夹里的 .bak 不改变导入结果、不出现在输出里', () => withTemp(async (directory) => {
  const images = await makeImages(directory)
  const clean = await importInto(path.join(directory, 'clean'), { withBak: false, images })
  const withBak = await importInto(path.join(directory, 'with-bak'), { withBak: true, images })
  assert.equal(withBak.catalog, clean.catalog)
  assert.equal(withBak.index.replaceAll(path.join(directory, 'with-bak'), '<root>'), clean.index.replaceAll(path.join(directory, 'clean'), '<root>'))
  assert.deepEqual(withBak.generated, clean.generated)
  assert.equal(withBak.output, clean.output)
  assert.doesNotMatch(withBak.preflight, /\.bak/)
  assert.doesNotMatch(withBak.output, /\.bak/)
  const catalog = JSON.parse(clean.catalog)
  assert.equal(catalog.items.length, 2)
  // 收件箱里的 .bak 原样保留（导入器不删、不改）。
  const city = path.join(directory, 'with-bak', 'MediaInbox', 'Iceland', 'Reykjavik')
  assert.equal(await readFile(path.join(city, 'place.bak'), 'utf8'), BROKEN)
}))
