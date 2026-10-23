/**
 * V2 媒体导入（scripts/v2-media-import.mjs，入口 scripts/import-media.mjs）的端到端测试
 * （RFC-LOC-1 PR3b-3 规格 §2.5、§3「导入器幂等」「改名与搬家」；PR5a 规格 §4.3、§5：旧导入器删除，未迁移时退出码 2）。
 * 3C-4d：media:import 只写新库，CLI 在 V2 私人根上只做只读预检。3C-5 E 删除了 V2 导入器的写入：这里测预检（CLI 与
 * 进程内的 runImportV2）、导入器的计划（内容寻址、归属、封面、源文件索引）与发布函数（D7）；「导入之后」的文件由测试夹具
 * 按导入器的计划写出（./v2-media-import.fixture.mjs，importDirect）。只测写入流程本身的断言（--apply 的退出码与提示）随写入删除。
 *
 * 每个用例在 fs.mkdtemp 建的临时私人根上运行：地点注册表是手写的中性数据
 * （冰岛：雷克雅未克、维克；法罗群岛：托尔斯港），投递箱里的图片由 sharp 现场生成（纯色小图，一张 2:1）。
 * STARMAP_PRIVATE_ROOT 总是指向临时目录，绝不读作者的真实私有层；用例结束时删除临时目录。
 *
 * 运行方式：npm test。零依赖以外只用 devDependency 里的 sharp（导入器本身也用它）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fsPromises, { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { getPrivatePaths } from './private-profile.mjs'
import { runV2MediaImport } from './v2-media-import.mjs'
import { writeV2MediaImport } from './v2-media-import.fixture.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { V2_MEDIA_SOURCE_INDEX_FILE_NAME } from '../src/data/v2media/importPlan.ts'
import { completeForWrite, integrityProblems } from '../src/data/canonical/v2Integrity.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOW = new Date(Date.UTC(2026, 8, 29, 8))

const newId = sequentialUuids(Date.UTC(2026, 8, 29))
const ID = { iceland: newId(), reykjavik: newId(), vik: newId(), faroe: newId(), torshavn: newId() }

const placesFile = () => ({
  schema_version: 1,
  generated_at: '2026-09-29T00:00:00.000Z',
  places: [
    { id: ID.iceland, subtype: 'country', names: { 'zh-Hans': '冰岛', en: 'Iceland' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 }, legacyKeys: ['country:iceland'] },
    { id: ID.reykjavik, subtype: 'city', names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }, partOf: ID.iceland, location: { lat: 64.1466, lng: -21.9426 }, legacyKeys: ['city:iceland__reykjavik'] },
    { id: ID.vik, subtype: 'city', names: { 'zh-Hans': '维克', en: 'Vík' }, partOf: ID.iceland, location: { lat: 63.4186, lng: -19.006 }, legacyKeys: ['city:iceland__vik'] },
    { id: ID.faroe, subtype: 'country', names: { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' }, externalIds: { iso3166Alpha2: 'FO' }, location: { lat: 62, lng: -7 }, legacyKeys: ['country:faroe-islands'] },
    { id: ID.torshavn, subtype: 'city', names: { 'zh-Hans': '托尔斯港', en: 'Tórshavn' }, partOf: ID.faroe, location: { lat: 62.0107, lng: -6.7741 }, legacyKeys: ['city:faroe-islands__torshavn'] },
  ],
})

const writeJson = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const readJsonFile = async (target) => JSON.parse(await readFile(target, 'utf8'))

/** 纯色小图（JPEG）。颜色不同内容就不同。 */
const makeImage = async (target, { width = 64, height = 48, color }) => {
  await mkdir(path.dirname(target), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toFile(target)
}

const RED = { r: 200, g: 30, b: 30 }
const GREEN = { r: 30, g: 160, b: 60 }
const BLUE = { r: 30, g: 60, b: 200 }
const YELLOW = { r: 230, g: 200, b: 40 }

/**
 * 中性投递箱：
 *   Iceland/Reykjavik/place.json → 雷克雅未克；photos/harbour.jpg（红）、cover-church.jpg（绿）、harbour-copy.jpg（与 harbour 内容相同）
 *   Iceland/Vik/photos/beach.jpg（蓝）——城市文件夹按名称解析（Vík 的重音不影响）
 *   Faroe Islands/country.json { countryId: 'faroe-islands' }（旧 country.json，经 legacyKeys）；
 *   Faroe Islands/Torshavn/drone/bay.jpg（黄，200 × 100）+ media.json
 */
const writeInbox = async (paths) => {
  const inbox = paths.inboxRoot
  await writeJson(path.join(inbox, 'Iceland', 'Reykjavik', 'place.json'), { placeId: ID.reykjavik })
  await makeImage(path.join(inbox, 'Iceland', 'Reykjavik', 'photos', 'harbour.jpg'), { color: RED })
  await makeImage(path.join(inbox, 'Iceland', 'Reykjavik', 'photos', 'cover-church.jpg'), { color: GREEN })
  await makeImage(path.join(inbox, 'Iceland', 'Reykjavik', 'photos', 'harbour-copy.jpg'), { color: RED })
  await makeImage(path.join(inbox, 'Iceland', 'Vik', 'photos', 'beach.jpg'), { color: BLUE })
  await writeJson(path.join(inbox, 'Faroe Islands', 'country.json'), { countryId: 'faroe-islands' })
  await makeImage(path.join(inbox, 'Faroe Islands', 'Torshavn', 'drone', 'bay.jpg'), { width: 200, height: 100, color: YELLOW })
  await writeJson(path.join(inbox, 'Faroe Islands', 'Torshavn', 'media.json'), {
    'drone/bay.jpg': { kind: 'aerialPhoto', titleZh: '海湾', titleEn: 'Bay', date: '2026-07-03', resolution: '200 × 100', captureType: 'Aerial Photo' },
  })
}

const withV2Root = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-v2-media-test-'))
  const root = path.join(directory, 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await writeJson(paths.v2FilePaths.places, placesFile())
  try {
    await run({ root, paths })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const runImportCli = (root, args = []) => spawnSync(process.execPath, [path.join(webRoot, 'scripts', 'import-media.mjs'), ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: root },
  encoding: 'utf8',
})

/** The preview in this process (as the CLI runs it, `--verify` included), its output split into stdout and stderr like the CLI's. */
const runImportV2 = async (root, args = []) => {
  const stdout = []
  const stderr = []
  const status = await runV2MediaImport({
    privatePaths: getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }), verify: args.includes('--verify'),
    log: (line) => stdout.push(line), logError: (line) => stderr.push(line),
  })
  return { status, stdout: `${stdout.join('\n')}\n`, stderr: `${stderr.join('\n')}\n` }
}

/**
 * What the import wrote, written by the test fixture from the importer's plan (3C-5 E): code 0; a plan with problems writes
 * nothing (code 1, the problems as output), and so do folder bindings to confirm without the confirmation (code 2). Batch
 * 2A: bindings found by folder name need confirming; the Inbox here has such folders (Iceland, Vik, Faroe Islands,
 * Torshavn) and these cases test other things, so the confirmation is on by default.
 */
const importDirect = async (paths, { acceptFolderBindings = true } = {}) => {
  try {
    await writeV2MediaImport({ privatePaths: paths, acceptFolderBindings, now: () => NOW })
    return { code: 0, output: '' }
  } catch (error) {
    if (error.problems) return { code: 1, output: error.message }
    if (error.unconfirmedBindings) return { code: 2, output: error.message }
    throw error
  }
}

const sha256File = (target) => createHash('sha256').update(readFileSync(target)).digest('hex')

/** generatedAt 以外的字节。 */
const withoutGeneratedAt = (text) => text.replace(/^ {2}"generatedAt": "[^"]*",\n/m, '')

const itemByFile = (catalog, originalFileName) => {
  const item = catalog.items.find((candidate) => candidate.originalFileName === originalFileName)
  assert.ok(item, `目录里没有 ${originalFileName}`)
  return item
}

const readV2Set = async (paths) => {
  const files = {}
  for (const [key, target] of Object.entries(paths.v2FilePaths)) if (existsSync(target)) files[key] = await readJsonFile(target)
  return files
}

// ---------------------------------------------------------------------------

test('V2 导入（CLI）：预检不写文件；按导入器的计划写出的 V3 目录与 V2 源文件索引：内容寻址；同一计划写两次除 generatedAt 外逐字节相同', async () => {
  await withV2Root(async ({ root, paths }) => {
    await writeInbox(paths)
    const inboxHashesBefore = ['Iceland/Reykjavik/photos/harbour.jpg', 'Faroe Islands/Torshavn/drone/bay.jpg', 'Faroe Islands/Torshavn/media.json']
      .map((file) => sha256File(path.join(paths.inboxRoot, file)))

    const preflight = runImportCli(root)
    assert.equal(preflight.status, 0, preflight.stderr)
    assert.match(preflight.stdout, /^StarMap 媒体预检：4 个文件$/m)
    assert.match(preflight.stdout, /普通照片 3 \| 360 全景 0 \| 航拍照片 1 \| 视频 0/)
    assert.match(preflight.stdout, /发现 1 个内容完全相同的重复文件/)
    assert.match(preflight.stdout, /预检通过/)
    assert.equal(existsSync(paths.v2FilePaths.media), false, '预检不写目录')
    assert.equal(existsSync(paths.v2MediaSourceIndexPath), false)
    assert.equal(existsSync(paths.userMediaRoot), false, '预检不生成网页文件')

    const first = await importDirect(paths)
    assert.equal(first.code, 0, first.output)
    const catalogBytes1 = await readFile(paths.v2FilePaths.media, 'utf8')
    const indexBytes1 = await readFile(paths.v2MediaSourceIndexPath, 'utf8')

    const second = await importDirect(paths)
    assert.equal(second.code, 0, second.output)
    const catalogBytes2 = await readFile(paths.v2FilePaths.media, 'utf8')
    const indexBytes2 = await readFile(paths.v2MediaSourceIndexPath, 'utf8')
    assert.equal(withoutGeneratedAt(catalogBytes2), withoutGeneratedAt(catalogBytes1), '媒体目录除 generatedAt 外逐字节相同')
    assert.equal(withoutGeneratedAt(indexBytes2), withoutGeneratedAt(indexBytes1), '源文件索引除 generatedAt 外逐字节相同')
    assert.notEqual(withoutGeneratedAt(catalogBytes1), catalogBytes1, 'generatedAt 那一行确实被去掉了')

    const catalog = JSON.parse(catalogBytes2)
    assert.equal(catalog.schemaVersion, 3)
    assert.equal(catalog.privacyLevel, 'local-only')
    // 扫描顺序（同旧导入器：文件夹与文件按 zh-CN 排序）；重复文件只留一条：位置取第一次（harbour-copy），值取最后一次（harbour）。
    assert.deepEqual(catalog.items.map((item) => item.originalFileName), ['bay.jpg', 'cover-church.jpg', 'harbour.jpg', 'beach.jpg'])
    for (const item of catalog.items) {
      const hash = /^media-([0-9a-f]{16})$/.exec(item.id)?.[1]
      assert.ok(hash, `id 形如 media-<16 位十六进制>：${item.id}`)
      assert.equal(item.src, `/media/user/${hash}/original.jpg`)
      assert.equal(item.variants.thumb.src, `/media/user/${hash}/thumb.webp`)
      assert.equal(item.variants.preview.src, `/media/user/${hash}/preview.webp`)
      for (const file of ['original.jpg', 'thumb.webp', 'preview.webp']) assert.ok(existsSync(path.join(paths.userMediaRoot, hash, file)), `${hash}/${file}`)
      for (const key of ['countryId', 'cityId', 'countryName', 'cityName', 'titleZh', 'titleEn']) assert.equal(Object.hasOwn(item, key), false, key)
      for (const name of ['iceland', 'reykjavik', 'vik', 'faroe', 'torshavn', 'photo', 'aerial']) {
        assert.ok(!`${item.id} ${item.src}`.toLowerCase().includes(name), `${item.id} 不含地名或类型`)
      }
    }
    assert.equal(itemByFile(catalog, 'harbour.jpg').placeId, ID.reykjavik, 'place.json')
    assert.equal(itemByFile(catalog, 'beach.jpg').placeId, ID.vik, '文件夹名 Vik ↔ Vík')
    assert.equal(itemByFile(catalog, 'bay.jpg').placeId, ID.torshavn, '旧 country.json + 文件夹名')
    assert.deepEqual(catalog.items.filter((item) => item.isCover).map((item) => item.originalFileName), ['cover-church.jpg', 'beach.jpg'])
    const bay = itemByFile(catalog, 'bay.jpg')
    assert.equal(bay.kind, 'aerialPhoto')
    assert.equal(bay.status, 'ready')
    assert.deepEqual(bay.title, { names: { 'zh-Hans': '海湾', en: 'Bay' } })

    // 源文件索引：同一内容的两个文件都记在同一个 id 下。
    const index = JSON.parse(indexBytes2)
    const harbourId = itemByFile(catalog, 'harbour.jpg').id
    assert.deepEqual(index.sourcesById[harbourId], ['Iceland/Reykjavik/photos/harbour-copy.jpg', 'Iceland/Reykjavik/photos/harbour.jpg'])
    assert.deepEqual(Object.keys(index.sourcesById).sort(), catalog.items.map((item) => item.id).sort())

    // 五个 V2 文件通过完整性检查；没有写任何旧文件；投递箱里的源文件与 sidecar 没被改动。
    assert.deepEqual(integrityProblems(completeForWrite(await readV2Set(paths), NOW)), [])
    for (const legacy of [paths.mediaCatalogPath, path.join(paths.dataRoot, 'media-source-index.local.json'), paths.localTravelMapPath, paths.editorStatePath]) {
      assert.equal(existsSync(legacy), false, legacy)
    }
    assert.deepEqual(
      ['Iceland/Reykjavik/photos/harbour.jpg', 'Faroe Islands/Torshavn/drone/bay.jpg', 'Faroe Islands/Torshavn/media.json'].map((file) => sha256File(path.join(paths.inboxRoot, file))),
      inboxHashesBefore,
    )
    assert.equal(path.basename(paths.v2MediaSourceIndexPath), V2_MEDIA_SOURCE_INDEX_FILE_NAME)
    assert.equal(path.dirname(paths.v2MediaSourceIndexPath), paths.v2DataRoot)
  })
})

test('改名：注册表里城市改名后再导入，文件夹有 place.json 的照片 id、路径、归属都不变', async () => {
  await withV2Root(async ({ paths }) => {
    await writeInbox(paths)
    assert.equal((await importDirect(paths)).code, 0)
    const before = await readFile(paths.v2FilePaths.media, 'utf8')

    const places = placesFile()
    const reykjavik = places.places.find((place) => place.id === ID.reykjavik)
    reykjavik.names = { 'zh-Hans': '雷克雅未克市', en: 'Reykjavik City' }
    await writeJson(paths.v2FilePaths.places, places)
    const result = await importDirect(paths)
    assert.equal(result.code, 0, result.output)
    assert.equal(await readFile(paths.v2FilePaths.media, 'utf8'), before, '改名不影响媒体目录（generatedAt 由注入的 now 固定）')
  })
})

test('搬家与改类型：照片从一个城市文件夹移到另一个、无人机影像改为全景，id 与路径都不变，placeId 与 kind 随之改变', async () => {
  await withV2Root(async ({ paths }) => {
    await writeInbox(paths)
    assert.equal((await importDirect(paths)).code, 0)
    const before = await readJsonFile(paths.v2FilePaths.media)
    const beachBefore = itemByFile(before, 'beach.jpg')
    const bayBefore = itemByFile(before, 'bay.jpg')

    await rename(path.join(paths.inboxRoot, 'Iceland', 'Vik', 'photos', 'beach.jpg'), path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'beach.jpg'))
    await writeJson(path.join(paths.inboxRoot, 'Faroe Islands', 'Torshavn', 'media.json'), {
      'drone/bay.jpg': { kind: 'panorama360', titleZh: '海湾', titleEn: 'Bay', date: '2026-07-03', resolution: '200 × 100', captureType: 'Drone 360 Panorama' },
    })
    const result = await importDirect(paths)
    assert.equal(result.code, 0, result.output)

    const after = await readJsonFile(paths.v2FilePaths.media)
    const beachAfter = itemByFile(after, 'beach.jpg')
    assert.equal(beachAfter.id, beachBefore.id)
    assert.equal(beachAfter.src, beachBefore.src)
    assert.deepEqual(beachAfter.variants, beachBefore.variants)
    assert.equal(beachBefore.placeId, ID.vik)
    assert.equal(beachAfter.placeId, ID.reykjavik)
    const bayAfter = itemByFile(after, 'bay.jpg')
    assert.equal(bayAfter.id, bayBefore.id)
    assert.equal(bayAfter.src, bayBefore.src)
    assert.equal(bayAfter.kind, 'panorama360')
    // 源文件索引跟着新位置走。
    const index = await readJsonFile(paths.v2MediaSourceIndexPath)
    assert.deepEqual(index.sourcesById[beachAfter.id], ['Iceland/Reykjavik/photos/beach.jpg'])
    // 雷克雅未克的封面仍是 cover-church；维克已经没有照片。
    assert.deepEqual(after.items.filter((item) => item.isCover).map((item) => item.originalFileName), ['cover-church.jpg'])
  })
})

test('V2 导入的错误：找不到国家或城市、place.json 指向别国城市、没有注册表；预检报告它们，一个文件都不写', async () => {
  await withV2Root(async ({ root, paths }) => {
    await writeInbox(paths)
    await makeImage(path.join(paths.inboxRoot, 'Atlantis', 'Capital', 'photos', 'a.jpg'), { color: RED })
    await makeImage(path.join(paths.inboxRoot, 'Iceland', 'Akureyri', 'photos', 'b.jpg'), { color: GREEN })
    await makeImage(path.join(paths.inboxRoot, '冰岛', '雷克雅未克', 'photos', 'c.jpg'), { color: BLUE })
    await writeJson(path.join(paths.inboxRoot, '冰岛', '雷克雅未克', 'place.json'), { placeId: ID.torshavn })

    const result = await runImportV2(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /需要处理（3）/)
    assert.match(result.stderr, /找不到国家：Atlantis。目录名需与 StarMap 中的国家中文名、英文名或国家代码一致，或在 place.json 中填写 placeId。/)
    assert.match(result.stderr, /在 Iceland 中找不到城市：Akureyri。请先在 StarMap 中添加这个城市。/)
    assert.ok(result.stderr.includes(`冰岛/雷克雅未克/place.json 指定的城市不属于 Iceland：${ID.torshavn}`), result.stderr)
    assert.equal(existsSync(paths.v2FilePaths.media), false)
    assert.equal(existsSync(paths.v2MediaSourceIndexPath), false)
    assert.equal(existsSync(paths.userMediaRoot), false)
    // 有错误时也不固定任何按名称匹配成功的文件夹（Iceland、Vik、Faroe Islands、Torshavn 都没有 place.json）。
    for (const folder of ['Iceland', 'Iceland/Vik', 'Faroe Islands', 'Faroe Islands/Torshavn']) {
      assert.equal(existsSync(path.join(paths.inboxRoot, ...folder.split('/'), 'place.json')), false, folder)
    }
  })

  await withV2Root(async ({ paths }) => {
    await rm(paths.v2FilePaths.places)
    await makeImage(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'a.jpg'), { color: RED })
    const result = await importDirect(paths)
    assert.equal(result.code, 1)
    assert.match(result.output, /找不到国家：Iceland/, '没有地点注册表时不回落到任何旧数据或样例')
    assert.equal(existsSync(paths.v2FilePaths.media), false)
  })
})

/**
 * 手动建的收件箱（模拟用户自己放照片）：雷克雅未克的文件夹没有 place.json；维克有一份手写的 place.json（格式与应用写的不同）。
 * 其余同 writeInbox：Iceland 与 Torshavn 按文件夹名解析，Faroe Islands 经旧 country.json 解析。
 */
const writeManualInbox = async (paths) => {
  await writeInbox(paths)
  await rm(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'place.json'))
  await writeFile(path.join(paths.inboxRoot, 'Iceland', 'Vik', 'place.json'), `{"placeId":"${ID.vik}","note":"hand-written"}`, 'utf8')
}

const PINNED_FOLDERS = [
  ['Iceland', ID.iceland],
  ['Iceland/Reykjavik', ID.reykjavik],
  ['Faroe Islands', ID.faroe],
  ['Faroe Islands/Torshavn', ID.torshavn],
]

const placeJsonOf = (paths, folder) => path.join(paths.inboxRoot, ...folder.split('/'), 'place.json')

test('文件夹绑定需要确认（第 2A 批，改写自「固定归属」）：预检列出「文件夹 → 地点」不写；确认之后才写入 place.json；已有的不动；改名后再导入 id、路径、归属都不变', async () => {
  await withV2Root(async ({ root, paths }) => {
    await writeManualInbox(paths)
    const vikPlaceJson = await readFile(placeJsonOf(paths, 'Iceland/Vik'), 'utf8')
    const countryJson = await readFile(path.join(paths.inboxRoot, 'Faroe Islands', 'country.json'), 'utf8')

    // 预检：列出待确认的绑定（国家与城市、按文件夹名或旧 country.json；雷克雅未克只匹配到一个候选也要确认），一个 place.json 都不写。
    // 改写：旧断言是「导入时将在 4 个……写入 place.json」，即 --apply 会直接固定。
    const preflight = runImportCli(root)
    assert.equal(preflight.status, 0, preflight.stderr)
    assert.match(preflight.stdout, /待确认的文件夹绑定（4）/)
    assert.ok(preflight.stdout.includes(`- Iceland/Reykjavik → 雷克雅未克 / Reykjavik（城市，按文件夹名，${ID.reykjavik}）`), preflight.stdout)
    assert.ok(preflight.stdout.includes(`- Faroe Islands → 法罗群岛 / Faroe Islands（国家，按旧 country.json，${ID.faroe}）`), preflight.stdout)
    assert.ok(!preflight.stdout.includes('Iceland/Vik →'), '已有 place.json 的文件夹不是待确认的绑定')
    assert.match(preflight.stdout, /--accept-folder-bindings/)
    for (const [folder] of PINNED_FOLDERS) assert.equal(existsSync(placeJsonOf(paths, folder)), false, `预检不写 ${folder}/place.json`)

    // 不带确认：什么都不写（place.json、媒体目录、源文件索引、生成文件）。
    const refused = await importDirect(paths, { acceptFolderBindings: false })
    assert.equal(refused.code, 2, refused.output)
    for (const [folder] of PINNED_FOLDERS) assert.equal(existsSync(placeJsonOf(paths, folder)), false, `拒绝时不写 ${folder}/place.json`)
    assert.equal(existsSync(paths.v2FilePaths.media), false)
    assert.equal(existsSync(paths.v2MediaSourceIndexPath), false)
    assert.equal(existsSync(paths.userMediaRoot), false)

    // 确认之后：国家与城市文件夹都写入指向正确地点的 place.json；手写的与旧 country.json 不动。
    const first = await importDirect(paths)
    assert.equal(first.code, 0, first.output)
    for (const [folder, placeId] of PINNED_FOLDERS) {
      assert.equal(await readFile(placeJsonOf(paths, folder), 'utf8'), `${JSON.stringify({ placeId }, null, 2)}\n`, folder)
    }
    assert.equal(await readFile(placeJsonOf(paths, 'Iceland/Vik'), 'utf8'), vikPlaceJson, '已有的 place.json 不动')
    assert.equal(await readFile(path.join(paths.inboxRoot, 'Faroe Islands', 'country.json'), 'utf8'), countryJson, '旧 country.json 不动')
    const catalogBefore = await readFile(paths.v2FilePaths.media, 'utf8')
    const indexBefore = await readFile(paths.v2MediaSourceIndexPath, 'utf8')

    // 注册表里把雷克雅未克改名为 Reykjavík City、把法罗群岛改名为 Faroes：文件夹名都对不上了，但归属已按 id 固定。
    const places = placesFile()
    places.places.find((place) => place.id === ID.reykjavik).names.en = 'Reykjavík City'
    places.places.find((place) => place.id === ID.faroe).names = { 'zh-Hans': '法罗', en: 'Faroes' }
    places.places.find((place) => place.id === ID.torshavn).names = { 'zh-Hans': '托尔斯港市', en: 'Tórshavn Town' }
    await writeJson(paths.v2FilePaths.places, places)
    const preview = await runImportV2(root)
    assert.equal(preview.status, 0, preview.stderr)
    assert.doesNotMatch(preview.stdout, /待确认的文件夹绑定/, '已经固定，不再需要确认')
    assert.equal((await importDirect(paths, { acceptFolderBindings: false })).code, 0, '固定之后不带确认也能写')
    assert.equal(withoutGeneratedAt(await readFile(paths.v2FilePaths.media, 'utf8')), withoutGeneratedAt(catalogBefore), 'id、路径、归属都不变')
    assert.equal(withoutGeneratedAt(await readFile(paths.v2MediaSourceIndexPath, 'utf8')), withoutGeneratedAt(indexBefore))
    const catalog = await readJsonFile(paths.v2FilePaths.media)
    assert.equal(itemByFile(catalog, 'harbour.jpg').placeId, ID.reykjavik)
    assert.equal(itemByFile(catalog, 'bay.jpg').placeId, ID.torshavn)
  })
})

test('固定归属之前：同样的改名会让按名称匹配的文件夹找不到城市，整次导入被拦下（这正是要固定的原因）', async () => {
  await withV2Root(async ({ paths }) => {
    await writeManualInbox(paths)
    const places = placesFile()
    places.places.find((place) => place.id === ID.reykjavik).names.en = 'Reykjavík City'
    await writeJson(paths.v2FilePaths.places, places)
    const result = await importDirect(paths)
    assert.equal(result.code, 1)
    assert.match(result.output, /在 Iceland 中找不到城市：Reykjavik。/)
    assert.equal(existsSync(placeJsonOf(paths, 'Iceland')), false, '有错误时一个 place.json 都不写')
  })
})

test('搬家（手动文件夹，已固定）：照片从雷克雅未克的文件夹挪到托尔斯港的文件夹，id 与路径不变，placeId 变为托尔斯港', async () => {
  await withV2Root(async ({ paths }) => {
    await writeManualInbox(paths)
    assert.equal((await importDirect(paths)).code, 0)
    const before = itemByFile(await readJsonFile(paths.v2FilePaths.media), 'cover-church.jpg')
    assert.equal(before.placeId, ID.reykjavik)

    const places = placesFile()
    places.places.find((place) => place.id === ID.reykjavik).names.en = 'Reykjavík City'
    await writeJson(paths.v2FilePaths.places, places)
    await mkdir(path.join(paths.inboxRoot, 'Faroe Islands', 'Torshavn', 'photos'), { recursive: true })
    await rename(
      path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'cover-church.jpg'),
      path.join(paths.inboxRoot, 'Faroe Islands', 'Torshavn', 'photos', 'cover-church.jpg'),
    )
    const result = await importDirect(paths)
    assert.equal(result.code, 0, result.output)
    const after = itemByFile(await readJsonFile(paths.v2FilePaths.media), 'cover-church.jpg')
    assert.equal(after.id, before.id)
    assert.equal(after.src, before.src)
    assert.deepEqual(after.variants, before.variants)
    assert.equal(after.placeId, ID.torshavn)
    assert.deepEqual((await readJsonFile(paths.v2MediaSourceIndexPath)).sourcesById[after.id], ['Faroe Islands/Torshavn/photos/cover-church.jpg'])
  })
})

test('V2 导入：投递箱为空时写出空目录；注册表不合法时报错且不写', async () => {
  await withV2Root(async ({ paths }) => {
    await mkdir(paths.inboxRoot, { recursive: true })
    const empty = await importDirect(paths)
    assert.equal(empty.code, 0, empty.output)
    assert.deepEqual((await readJsonFile(paths.v2FilePaths.media)).items, [])
    assert.deepEqual((await readJsonFile(paths.v2MediaSourceIndexPath)).sourcesById, {})

    await rm(paths.v2FilePaths.media)
    await writeJson(paths.v2FilePaths.places, { schema_version: 1, generated_at: 'x', places: [{ id: 'not-a-uuid', subtype: 'country', names: { en: 'X' } }] })
    const broken = await importDirect(paths)
    assert.equal(broken.code, 1)
    assert.match(broken.output, /没有通过校验/)
    assert.equal(existsSync(paths.v2FilePaths.media), false)
  })
})

// ---------------------------------------------------------------------------
// 生成文件的原子发布与 --verify（第 1 批 D7）
// ---------------------------------------------------------------------------

/** 把 node:fs/promises 的某个函数换成替身（syncBuiltinESMExports 让导入器的具名导入也看到它）；用例结束时还原。 */
const replaceFs = (t, name, replacement) => {
  const original = fsPromises[name]
  t.mock.method(fsPromises, name, (...args) => replacement(original, ...args))
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

const generatedNamesOf = async (paths) => {
  if (!existsSync(paths.userMediaRoot)) return []
  return (await readdir(paths.userMediaRoot, { recursive: true })).map((name) => name.split(path.sep).join('/')).sort()
}

test('D7：发布中断（模拟进程崩溃）只留下其他进程的临时文件，最终路径不存在；重新运行清理遗留并正常完成', async () => {
  await withV2Root(async ({ paths }) => {
    await makeImage(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'harbour.jpg'), { color: RED })
    await writeJson(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'place.json'), { placeId: ID.reykjavik })
    const source = path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'harbour.jpg')
    const hash = sha256File(source).slice(0, 16)
    const directory = path.join(paths.userMediaRoot, hash)
    // 崩溃的导入进程只写了一半的原图临时文件；最终路径从未出现。
    const staleName = `.original.jpg.${process.pid + 1}.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, staleName), readFileSync(source).subarray(0, 100))
    // 名字相近、但不是导入器临时文件的文件不删。
    await writeFile(path.join(directory, 'notes.tmp'), 'not ours')
    assert.equal(existsSync(path.join(directory, 'original.jpg')), false)

    const result = await importDirect(paths)
    assert.equal(result.code, 0, result.output)
    assert.equal(sha256File(path.join(directory, 'original.jpg')), sha256File(source), '原图是完整的副本')
    assert.deepEqual((await readdir(directory)).sort(), ['notes.tmp', 'original.jpg', 'preview.webp', 'thumb.webp'])
  })
})

test('D7：本进程发布失败时删除临时文件，最终路径不存在；故障消失后重新运行正常完成', async (t) => {
  await withV2Root(async ({ paths }) => {
    await writeInbox(paths)
    let failures = 0
    replaceFs(t, 'link', async () => {
      failures += 1
      throw Object.assign(new Error('injected link failure'), { code: 'EIO' })
    })
    replaceFs(t, 'rename', async (original, from, to) => {
      if (String(from).endsWith('.tmp') && path.basename(String(from)).startsWith('.')) throw Object.assign(new Error('injected publish failure'), { code: 'EIO' })
      return original(from, to)
    })
    await assert.rejects(importDirect(paths), /injected publish failure/)
    assert.equal(failures, 1, '第一张原图发布失败就停下')
    const names = await generatedNamesOf(paths)
    assert.ok(names.every((name) => !name.endsWith('.tmp')), `不留临时文件：${names.join(', ')}`)
    assert.ok(names.every((name) => !/\/(?:original\.jpg|thumb\.webp|preview\.webp)$/.test(name)), `没有发布任何最终文件：${names.join(', ')}`)
    assert.equal(existsSync(paths.v2FilePaths.media), false, '目录没有写')

    t.mock.restoreAll()
    syncBuiltinESMExports()
    const retry = await importDirect(paths)
    assert.equal(retry.code, 0, retry.output)
    const catalog = await readJsonFile(paths.v2FilePaths.media)
    for (const item of catalog.items) {
      const hash = /^media-([0-9a-f]{16})$/.exec(item.id)[1]
      for (const file of ['original.jpg', 'thumb.webp', 'preview.webp']) assert.ok(existsSync(path.join(paths.userMediaRoot, hash, file)), `${hash}/${file}`)
    }
    assert.ok((await generatedNamesOf(paths)).every((name) => !name.endsWith('.tmp')))
  })
})

test('D7：文件系统不支持硬链接时，在租约下确认最终路径不存在后 rename 发布；已存在的最终文件不被覆盖', async (t) => {
  await withV2Root(async ({ paths }) => {
    await writeInbox(paths)
    replaceFs(t, 'link', async () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }) })
    const first = await importDirect(paths)
    assert.equal(first.code, 0, first.output)
    const catalog = await readJsonFile(paths.v2FilePaths.media)
    const hash = /^media-([0-9a-f]{16})$/.exec(itemByFile(catalog, 'harbour.jpg').id)[1]
    const thumb = path.join(paths.userMediaRoot, hash, 'thumb.webp')
    const thumbBytes = readFileSync(thumb)
    assert.ok((await generatedNamesOf(paths)).every((name) => !name.endsWith('.tmp')))
    const second = await importDirect(paths)
    assert.equal(second.code, 0, second.output)
    assert.deepEqual(readFileSync(thumb), thumbBytes)
  })
})

test('D7：media:check --verify 只报告与目录名哈希不一致的原图，不修复；默认预检不做全量哈希', async () => {
  await withV2Root(async ({ root, paths }) => {
    await writeInbox(paths)
    assert.equal((await importDirect(paths)).code, 0)
    const clean = runImportCli(root, ['--verify'])
    assert.equal(clean.status, 0, clean.stderr)
    assert.match(clean.stdout, /校验：核对了 4 张已生成原图的内容哈希。/)

    const catalog = await readJsonFile(paths.v2FilePaths.media)
    const hash = /^media-([0-9a-f]{16})$/.exec(itemByFile(catalog, 'beach.jpg').id)[1]
    const original = path.join(paths.userMediaRoot, hash, 'original.jpg')
    const tampered = readFileSync(original).subarray(0, 200)
    await writeFile(original, tampered)

    const plain = runImportCli(root)
    assert.equal(plain.status, 0, '默认预检不核对原图内容')
    assert.doesNotMatch(plain.stdout, /校验：/)

    const verified = runImportCli(root, ['--verify'])
    assert.equal(verified.status, 1, verified.stdout)
    assert.match(verified.stderr, new RegExp(`生成的原图 media/user/${hash}/original\\.jpg 与目录名的内容哈希不一致`))
    assert.equal((verified.stderr.match(/内容哈希不一致/g) ?? []).length, 1, '只报告被篡改的那一张')
    assert.deepEqual(readFileSync(original), tampered, '只报告，不修复')
  })
})

// ---------------------------------------------------------------------------
// 旧格式数据（RFC-LOC-1 PR5a 决定 I）：旧导入器已删除；没迁移时拒绝，迁移之后的残留照常
// ---------------------------------------------------------------------------

test('入口只剩几行：import-media.mjs 不再含旧导入器，也不再按数据模式分派；只有新库能导入，V2 导入器只做只读预检（3C-4d）', () => {
  const source = readFileSync(path.join(webRoot, 'scripts', 'import-media.mjs'), 'utf8')
  assert.ok(source.split(/\r?\n/).length < 40, '入口文件应当只有几行')
  assert.doesNotMatch(source, /resolveDataMode|data-mode\.mjs|createLocationIndex|travel-map\.sample\.json|localTravelMapPath/)
  // 3C-4c：新库交给 store-media-cli.mjs。3C-4d：不是新库时 V2 导入器只预检（不取库租约），--apply 被拒绝。
  assert.match(source, /runStoreMediaCli\(/)
  assert.match(source, /runV2MediaImport\(\{ privatePaths, verify \}\)/)
  assert.doesNotMatch(source, /withLibraryOperation|apply: true|apply, verify/)
  // 3C-5 E：导入器不再有写入（评审 §7-3 保留到 3C-5 的那一段删除了），测试的输入由测试夹具写出。
  const importer = readFileSync(path.join(webRoot, 'scripts', 'v2-media-import.mjs'), 'utf8')
  assert.doesNotMatch(importer, /apply = false|apply: |import \{ atomicJsonWrite \}|applyV2MediaImportScan/)
  assert.ok(importer.includes('3C-5 E 删除了 runV2MediaImport 的写入'))
})

test('未迁移：私人目录只有旧数据、data/v2/ 没有 V2 文件 → media:check 与 media:import 都拒绝，退出码 2，说明怎么迁移；不写任何文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-legacy-media-test-'))
  const root = path.join(directory, 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  try {
    await writeJson(paths.localTravelMapPath, {
      schema_version: 1,
      records: [{ id: 'r1', country: '冰岛', country_en: 'Iceland', country_code: 'is', city: '雷克雅未克', city_en: 'Reykjavik', start_date: '2025-06-01', status: 'visited', lat: 64.1466, lng: -21.9426 }],
    })
    await writeInbox(paths)
    const before = (await readdir(root, { recursive: true })).sort()
    for (const args of [[], ['--apply']]) {
      const result = runImportCli(root, args)
      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /^\[import-media\] 私人目录里有旧格式的数据，还没有迁移，没有导入任何媒体。/)
      assert.match(result.stderr, /检出 StarMap 的提交 4fd32a9/)
    }
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, '不写 data/v2/、生成文件与 place.json')
    assert.equal(existsSync(paths.v2DataRoot), false)
    assert.equal(existsSync(paths.userMediaRoot), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('残留：旧文件与 V2 文件都在（已迁移到 V2）→ 按待迁移到新库处理（3C-4d）：media:import 退出码 2、提示迁移而不是旧数据；预检照常；什么都不写；PR4 的数据模式标记（哪怕是 legacy）被忽略', async () => {
  await withV2Root(async ({ root, paths }) => {
    await writeJson(paths.localTravelMapPath, { schema_version: 1, records: [] })
    await writeJson(path.join(paths.dataRoot, 'data-mode.local.json'), { mode: 'legacy' })
    await writeInbox(paths)
    const before = (await readdir(root, { recursive: true })).sort()
    const refused = runImportCli(root, ['--apply', '--accept-folder-bindings'])
    assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`)
    assert.match(refused.stderr, /还没有迁移到新库/)
    assert.doesNotMatch(refused.stderr, /旧格式的数据/)
    const checked = runImportCli(root, ['--accept-folder-bindings'])
    assert.equal(checked.status, 0, checked.stderr)
    assert.match(checked.stdout, /^StarMap 媒体预检：4 个文件$/m)
    assert.match(checked.stdout, /还没有迁移到新库/)
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, '不写媒体目录、生成文件、place.json，也不取库租约')
    assert.equal(existsSync(paths.mediaCatalogPath), false, '不写旧格式的媒体目录')
  })
})
