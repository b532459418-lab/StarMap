/**
 * 媒体上传 IO 层（scripts/v2-media-store.mjs 的 prepareV2Upload / handleV2Upload；RFC-LOC-1 PR3b-3 规格 §2.4，第 2D 批）的测试：
 * 在临时私人根上上传照片与全景，检查收件箱文件夹的选择、place.json、无人机 sidecar 与各种拒绝。
 *
 * 3C-4d：个人数据只写新库。上传由新库的上传端点（./store-media-endpoints.mjs）与媒体任务的接收调用，它们传入新库的官方读取器
 * （`reader`，3C-5 E）；这里传入按地点注册表查地点的读取器（readerOf），不读 data/v2/。V2 的导入与彻底删除已删除，它们的测试随之删除（新库的
 * 导入与删除见 store-media-endpoints.test.mjs、media-service 的测试）。导入时文件夹的归属与待确认的绑定用共用的扫描
 * （scanV2MediaImport，新库的扫描也走它的 walkInbox）检查。
 *
 * 图片由 sharp 现场生成（纯色小图，一张 2:1）。私人根总是 fs.mkdtemp 建的临时目录，用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'

import { atomicJsonWrite, readJson } from './json-file.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { handleV2Upload, prepareV2Upload } from './v2-media-store.mjs'
import { scanV2MediaImport } from './compat/v2-media-import.mjs'
import { safeSegment, reserveDestination, writeUpload } from './local-editor-upload.mjs'
import { placeFolderSuffix } from '../src/data/v2media/editorWrites.ts'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'

const newId = sequentialUuids(Date.UTC(2026, 8, 29))
const ID = { iceland: newId(), reykjavik: newId(), vik: newId(), faroe: newId(), torshavn: newId() }

const placesFile = () => ({
  schema_version: 1,
  generated_at: '2026-09-29T00:00:00.000Z',
  places: [
    { id: ID.iceland, subtype: 'country', names: { 'zh-Hans': '冰岛', en: 'Iceland' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 } },
    { id: ID.reykjavik, subtype: 'city', names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }, partOf: ID.iceland, location: { lat: 64.1466, lng: -21.9426 } },
    { id: ID.vik, subtype: 'city', names: { 'zh-Hans': '维克' }, partOf: ID.iceland, location: { lat: 63.4186, lng: -19.006 } },
    { id: ID.faroe, subtype: 'country', names: { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' }, externalIds: { iso3166Alpha2: 'FO' }, location: { lat: 62, lng: -7 } },
    { id: ID.torshavn, subtype: 'city', names: { 'zh-Hans': '托尔斯港', en: 'Torshavn' }, partOf: ID.faroe, location: { lat: 62.0107, lng: -6.7741 } },
  ],
})

const jpeg = (color, width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer()

/** 上传复用插件实际的 helper；无人机 sidecar 用合成私人根上的同一写法。 */
const depsFor = () => ({
  safeSegment,
  reserveDestination,
  writeUpload,
  updateDroneSidecar: async (cityRoot, destination, metadata, imageMetadata) => {
    const sidecarPath = path.join(cityRoot, 'media.json')
    const sidecar = await readJson(sidecarPath, {})
    sidecar[path.posix.join('drone', path.basename(destination))] = {
      kind: metadata.kind,
      titleZh: metadata.titleZh,
      titleEn: metadata.titleEn,
      date: metadata.date,
      resolution: `${imageMetadata.width} × ${imageMetadata.height}`,
      captureType: metadata.kind === 'panorama360' ? 'Drone 360 Panorama' : 'Aerial Photo',
    }
    await atomicJsonWrite(sidecarPath, sidecar)
  },
})

/** 私人根与它的「视图」：地点注册表放在 `places` 里（新库传给上传的就是这个形状），`setPlaces` 换掉它。 */
const withV2Root = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-v2-media-store-test-'))
  const root = path.join(directory, 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await mkdir(paths.inboxRoot, { recursive: true })
  const env = { root, paths, deps: depsFor(), view: { places: placesFile() } }
  env.setPlaces = (places) => { env.view = { places } }
  try {
    await run(env)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 3C-5 E: the upload reads places through the official reader; this one answers from the view's places file. */
const readerOf = (view) => ({ place: (id) => view.places.places.find((place) => place.id === id) })

const upload = async ({ paths, deps, view }, params, body) => {
  const request = Readable.from([body])
  request.headers = { 'content-length': String(body.length) }
  return handleV2Upload({ privatePaths: paths, query: new URLSearchParams(params), request, deps, reader: readerOf(view) })
}

/** 共用的扫描（只读）：data/v2/ 里放视图的地点注册表，扫描结果之后删掉它，私人根恢复原样。 */
const scanWith = async ({ paths, view }) => {
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, `${JSON.stringify(view.places, null, 2)}\n`, 'utf8')
  try {
    return await scanV2MediaImport({ privatePaths: paths, log: () => {}, logError: () => {} })
  } finally {
    await rm(paths.dataRoot, { recursive: true, force: true })
  }
}

const listTree = async (root) => {
  const result = []
  const walk = async (directory) => {
    if (!existsSync(directory)) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else result.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  await walk(root)
  return result.sort()
}

// ---------------------------------------------------------------------------

test('3C-4d：上传必须给出新库的视图；没有视图时拒绝（E_STORE_MIGRATION_REQUIRED），什么都不写', async () => {
  await withV2Root(async (env) => {
    const { paths, deps } = env
    await assert.rejects(prepareV2Upload({ privatePaths: paths, query: new URLSearchParams({ countryId: ID.iceland, cityId: ID.vik, fileName: 'a.jpg' }), deps }), { code: 'E_STORE_MIGRATION_REQUIRED' })
    const request = Readable.from([await jpeg({ r: 1, g: 2, b: 3 })])
    const refused = await handleV2Upload({ privatePaths: paths, query: new URLSearchParams({ countryId: ID.iceland, cityId: ID.vik, fileName: 'a.jpg' }), request, deps })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.code, 'E_STORE_MIGRATION_REQUIRED')
    assert.deepEqual(await listTree(paths.root), [])
  })
})

test('上传：照片写入城市文件夹并给新建的国家、城市文件夹写 place.json；同名文件不覆盖；全景写无人机 sidecar；不写 data/v2/', async () => {
  await withV2Root(async (env) => {
    const { paths } = env
    const red = await jpeg({ r: 200, g: 30, b: 30 })
    const green = await jpeg({ r: 30, g: 160, b: 60 })
    const pano = await jpeg({ r: 230, g: 200, b: 40 }, 200, 100)

    const first = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, kind: 'photo', fileName: 'Harbour.JPG' }, red)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.deepEqual(first.body, { ok: true, fileName: 'Harbour.jpg', bytes: red.length, sourcePath: 'Iceland/Reykjavik/photos/Harbour.jpg' })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Iceland', 'place.json')), { placeId: ID.iceland })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'place.json')), { placeId: ID.reykjavik })
    const second = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, fileName: 'church.jpg' }, green)
    assert.equal(second.status, 201, JSON.stringify(second.body))
    const again = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, fileName: 'church.jpg' }, green)
    assert.equal(again.body.sourcePath, 'Iceland/Reykjavik/photos/church-1.jpg', '同名文件不覆盖')

    const panorama = await upload(env, { countryId: ID.faroe, cityId: ID.torshavn, kind: 'panorama360', fileName: 'bay.jpg', date: '2026-07-03', titleZh: '海湾', titleEn: 'Bay' }, pano)
    assert.equal(panorama.status, 201, JSON.stringify(panorama.body))
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Faroe Islands', 'place.json')), { placeId: ID.faroe })
    assert.deepEqual((await readJson(path.join(paths.inboxRoot, 'Faroe Islands', 'Torshavn', 'media.json')))['drone/bay.jpg'], {
      kind: 'panorama360', titleZh: '海湾', titleEn: 'Bay', date: '2026-07-03', resolution: '200 × 100', captureType: 'Drone 360 Panorama',
    })
    assert.deepEqual(await listTree(paths.root), [
      'MediaInbox/Faroe Islands/Torshavn/drone/bay.jpg',
      'MediaInbox/Faroe Islands/Torshavn/media.json',
      'MediaInbox/Faroe Islands/Torshavn/place.json',
      'MediaInbox/Faroe Islands/place.json',
      'MediaInbox/Iceland/Reykjavik/photos/Harbour.jpg',
      'MediaInbox/Iceland/Reykjavik/photos/church-1.jpg',
      'MediaInbox/Iceland/Reykjavik/photos/church.jpg',
      'MediaInbox/Iceland/Reykjavik/place.json',
      'MediaInbox/Iceland/place.json',
    ].sort())
    // 导入时的归属：共用的扫描按 place.json 找到各自的城市。
    const scan = await scanWith(env)
    assert.deepEqual(scan.errors, [])
    // church.jpg 与 church-1.jpg 内容相同，扫描合成一条（V2 的内容寻址）：两张照片、一张全景。
    assert.deepEqual(scan.items.map((item) => `${item.placeId} ${item.kind}`).sort(), [
      `${ID.reykjavik} photo`, `${ID.reykjavik} photo`, `${ID.torshavn} panorama360`,
    ].sort())
  })
})

test('上传的拒绝：类型、地点、扩展名、无人机日期、真实上传校验、候选文件夹全都不能用——都不写文件；两个候选被占用时新建带数字的文件夹', async () => {
  await withV2Root(async (env) => {
    const { paths } = env
    const red = await jpeg({ r: 200, g: 30, b: 30 })
    const cases = [
      [{ countryId: ID.iceland, cityId: ID.vik, kind: 'video', fileName: 'a.jpg' }, 'E_MEDIA_KIND_INVALID', '不支持的媒体类型。'],
      [{ countryId: ID.faroe, cityId: ID.vik, fileName: 'a.jpg' }, 'E_MEDIA_LOCATION_NOT_FOUND', '找不到对应的国家和城市，请先把城市加入旅行数据。'],
      [{ countryId: ID.iceland, cityId: 'iceland__vik', fileName: 'a.jpg' }, 'E_MEDIA_LOCATION_NOT_FOUND', '找不到对应的国家和城市，请先把城市加入旅行数据。'],
      [{ countryId: ID.iceland, cityId: ID.vik, fileName: 'a.gif' }, 'E_MEDIA_EXTENSION', '当前网页编辑器只接收 JPG、PNG、WebP 或 AVIF 图片。'],
      [{ countryId: ID.iceland, cityId: ID.vik, kind: 'aerialPhoto', fileName: 'a.jpg' }, 'E_MEDIA_DRONE_DATE', '无人机影像必须填写有效日期。'],
      [{ countryId: ID.iceland, cityId: ID.vik, kind: 'panorama360', fileName: 'a.jpg', date: '2026-07-03' }, 'E_MEDIA_PANORAMA_RATIO', '所选图片为 64 × 48，不是常见的 2:1 等距柱状全景图。请改选“航拍照片”，或上传正确的 360 全景图。', { width: 64, height: 48 }],
      [{ countryId: ID.iceland, cityId: ID.vik, fileName: '..' }, 'E_MEDIA_NAME_INVALID', '文件名无效。', { field: 'media_filename' }],
    ]
    for (const [params, code, error, errorParams] of cases) {
      const result = await upload(env, params, red)
      assert.equal(result.status, 400, JSON.stringify(params))
      assert.equal(result.body.code, code, JSON.stringify(result.body))
      assert.equal(result.body.error, error)
      if (errorParams !== undefined) assert.deepEqual(result.body.params, errorParams)
    }
    const invalid = await upload(env, { countryId: ID.iceland, cityId: ID.vik, fileName: 'invalid.jpg' }, Buffer.from('synthetic invalid image bytes'))
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'E_MEDIA_IMAGE_INVALID')
    assert.equal(typeof invalid.body.details, 'string')
    assert.ok(invalid.body.details.trim().length > 0, '保留 sharp 的真实诊断')
    assert.deepEqual(await listTree(paths.inboxRoot), [], '失败的上传不写文件，也不写 place.json')

    // 维克没有英文名：文件夹用中文名。
    const vik = await upload(env, { countryId: ID.iceland, cityId: ID.vik, fileName: 'beach.jpg' }, red)
    assert.equal(vik.body.sourcePath, 'Iceland/维克/photos/beach.jpg')

    // 显示名的文件夹与带后缀的文件夹都已有 place.json 且指向别的地点；带数字的 2 到 9 都是手放的（没有 place.json）。
    // 候选全都不能用：冲突，不写文件（第 2D 批之前，手放的文件夹会被认领）。
    const suffixed = `维克 (${placeFolderSuffix(ID.vik)})`
    await writeFile(path.join(paths.inboxRoot, 'Iceland', '维克', 'place.json'), `${JSON.stringify({ placeId: ID.reykjavik })}\n`, 'utf8')
    await mkdir(path.join(paths.inboxRoot, 'Iceland', suffixed), { recursive: true })
    await writeFile(path.join(paths.inboxRoot, 'Iceland', suffixed, 'place.json'), `${JSON.stringify({ placeId: ID.torshavn })}\n`, 'utf8')
    const numbered = Array.from({ length: 8 }, (_, index) => `${suffixed} ${index + 2}`)
    for (const folder of numbered) await mkdir(path.join(paths.inboxRoot, 'Iceland', folder, 'photos'), { recursive: true })
    const before = await listTree(paths.inboxRoot)
    const conflict = await upload(env, { countryId: ID.iceland, cityId: ID.vik, fileName: 'other.jpg' }, red)
    assert.equal(conflict.status, 400)
    assert.equal(conflict.body.code, 'E_MEDIA_FOLDER_CONFLICT')
    const folders = ['维克', suffixed, ...numbered].map((folder) => `Iceland/${folder}`).join('、')
    assert.equal(conflict.body.error, `投递箱文件夹 ${folders} 都不能使用：它们是没有 place.json 的手放文件夹，或 place.json 指向别的地点（或内容无效）。未写入文件。请先确认这些文件夹属于哪个地点。`)
    assert.deepEqual(await listTree(paths.inboxRoot), before)
    for (const folder of numbered) assert.equal(existsSync(path.join(paths.inboxRoot, 'Iceland', folder, 'place.json')), false, folder)

    // 只有显示名与带后缀的两个被占用（旧规则在这里报冲突）：新建 `维克 (<后缀>) 2` 并写入 place.json，上传成功。
    for (const folder of numbered) await rm(path.join(paths.inboxRoot, 'Iceland', folder), { recursive: true })
    const second = await upload(env, { countryId: ID.iceland, cityId: ID.vik, fileName: 'other.jpg' }, red)
    assert.equal(second.status, 201, JSON.stringify(second.body))
    assert.equal(second.body.sourcePath, `Iceland/${suffixed} 2/photos/other.jpg`)
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Iceland', `${suffixed} 2`, 'place.json')), { placeId: ID.vik })
  })
})

/** 美国：两个英文名、中文名都相同的 Springfield（各自的地点），以及一个只差大小写的 springfield。 */
const SAME_NAME = { us: newId(), springfieldA: newId(), springfieldB: newId(), springfieldLower: newId() }
const sameNamePlaces = () => {
  const places = placesFile()
  places.places.push(
    { id: SAME_NAME.us, subtype: 'country', names: { 'zh-Hans': '美国', en: 'United States' }, externalIds: { iso3166Alpha2: 'US' }, location: { lat: 39, lng: -98 } },
    { id: SAME_NAME.springfieldA, subtype: 'city', names: { 'zh-Hans': '斯普林菲尔德', en: 'Springfield' }, partOf: SAME_NAME.us, location: { lat: 39.8, lng: -89.65 } },
    { id: SAME_NAME.springfieldB, subtype: 'city', names: { 'zh-Hans': '斯普林菲尔德', en: 'Springfield' }, partOf: SAME_NAME.us, location: { lat: 42.1, lng: -72.59 } },
    { id: SAME_NAME.springfieldLower, subtype: 'city', names: { en: 'springfield' }, partOf: SAME_NAME.us, location: { lat: 37.2, lng: -93.29 } },
  )
  return places
}

test('同一国家的同名城市不共用收件箱文件夹：两个 Springfield 各上传一张照片都成功、各进各的文件夹（第二个用 <显示名> (<地点 id 后缀>)），导入后归属正确；只差大小写的也一样', async () => {
  await withV2Root(async (env) => {
    const { paths } = env
    env.setPlaces(sameNamePlaces())
    // 先后添加的地点 id 前 8 位相同（UUIDv7 的时间戳高位），所以后缀取最后 8 位。
    assert.equal(SAME_NAME.springfieldA.slice(0, 8), SAME_NAME.springfieldB.slice(0, 8))

    const a = await upload(env, { countryId: SAME_NAME.us, cityId: SAME_NAME.springfieldA, fileName: 'capitol.jpg' }, await jpeg({ r: 10, g: 20, b: 30 }))
    const b = await upload(env, { countryId: SAME_NAME.us, cityId: SAME_NAME.springfieldB, fileName: 'armory.jpg' }, await jpeg({ r: 40, g: 50, b: 60 }))
    const lower = await upload(env, { countryId: SAME_NAME.us, cityId: SAME_NAME.springfieldLower, fileName: 'square.jpg' }, await jpeg({ r: 70, g: 80, b: 90 }))
    for (const result of [a, b, lower]) assert.equal(result.status, 201, JSON.stringify(result.body))
    const folderB = `Springfield (${placeFolderSuffix(SAME_NAME.springfieldB)})`
    assert.equal(a.body.sourcePath, 'United States/Springfield/photos/capitol.jpg')
    assert.equal(b.body.sourcePath, `United States/${folderB}/photos/armory.jpg`)
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'United States', 'place.json')), { placeId: SAME_NAME.us })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'United States', 'Springfield', 'place.json')), { placeId: SAME_NAME.springfieldA })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'United States', folderB, 'place.json')), { placeId: SAME_NAME.springfieldB })
    // 只差大小写：文件系统不分大小写（Windows）时 springfield 就是 Springfield 那个文件夹，被 A 占用，于是用带后缀的名字；
    // 分大小写的文件系统上它是另一个文件夹。两种情况下它都有自己的文件夹与 place.json。
    const lowerFolder = lower.body.sourcePath.split('/')[1]
    assert.ok([`springfield (${placeFolderSuffix(SAME_NAME.springfieldLower)})`, 'springfield'].includes(lowerFolder), lowerFolder)
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'United States', lowerFolder, 'place.json')), { placeId: SAME_NAME.springfieldLower })

    // 再给第二个 Springfield 上传一张：直接用它自己的文件夹。
    const b2 = await upload(env, { countryId: SAME_NAME.us, cityId: SAME_NAME.springfieldB, fileName: 'park.jpg' }, await jpeg({ r: 45, g: 55, b: 65 }))
    assert.equal(b2.body.sourcePath, `United States/${folderB}/photos/park.jpg`)

    // 导入时的归属：共用的扫描按各自的 place.json 找到城市，同名城市互不混淆。
    const scan = await scanWith(env)
    assert.deepEqual(scan.errors, [])
    const owners = Object.fromEntries(scan.items.map((item) => [item.originalFileName, item.placeId]))
    assert.deepEqual(owners, {
      'capitol.jpg': SAME_NAME.springfieldA,
      'armory.jpg': SAME_NAME.springfieldB,
      'park.jpg': SAME_NAME.springfieldB,
      'square.jpg': SAME_NAME.springfieldLower,
    })
  })
})

// ---------------------------------------------------------------------------
// 第 2D 批：上传不认领手放的文件夹
// ---------------------------------------------------------------------------

/** 中国与苏州。注册表里只有这一个 Suzhou，所以手放的 Suzhou 文件夹按名字只匹配到它。 */
const CHINA = { cn: newId(), suzhou: newId() }
const chinaPlaces = () => {
  const places = placesFile()
  places.places.push(
    { id: CHINA.cn, subtype: 'country', names: { 'zh-Hans': '中国', en: 'China' }, externalIds: { iso3166Alpha2: 'CN' }, location: { lat: 35, lng: 105 } },
    { id: CHINA.suzhou, subtype: 'city', names: { 'zh-Hans': '苏州', en: 'Suzhou' }, partOf: CHINA.cn, location: { lat: 31.2989, lng: 120.5853 } },
  )
  return places
}

/** 一个目录下的全部条目：文件的大小、SHA-256 与修改时间；目录（含根）的修改时间——里面加过或删过东西，它就会变。 */
const snapshot = async (root) => {
  const records = { './': { mtimeMs: (await fsPromises.stat(root)).mtimeMs } }
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      const info = await fsPromises.stat(full)
      if (entry.isDirectory()) {
        records[`${relative}/`] = { mtimeMs: info.mtimeMs }
        await walk(full)
      } else {
        records[relative] = { bytes: info.size, mtimeMs: info.mtimeMs, sha256: createHash('sha256').update(await readFile(full)).digest('hex') }
      }
    }
  }
  await walk(root)
  return records
}

/** 用户手放的城市文件夹：两张照片，没有 place.json。 */
const handMadeCity = async (cityRoot) => {
  await mkdir(path.join(cityRoot, 'photos'), { recursive: true })
  await writeFile(path.join(cityRoot, 'photos', 'old-street.jpg'), await jpeg({ r: 120, g: 90, b: 60 }))
  await writeFile(path.join(cityRoot, 'photos', 'bridge.jpg'), await jpeg({ r: 60, g: 90, b: 120 }))
}

/** 导入扫描列出的待确认绑定：`[文件夹, 地点 id, 来源]`，按文件夹排序。 */
const pendingBindings = async (env) => {
  const { paths } = env
  const scan = await scanWith(env)
  assert.deepEqual(scan.errors, [])
  return scan.pins
    .map((pin) => [path.relative(paths.inboxRoot, pin.directory).split(path.sep).join('/'), pin.placeId, pin.source])
    .sort(([a], [b]) => a.localeCompare(b))
}

test('第 2D 批：手放的 China/Suzhou（有照片，没有 place.json）不被认领——照片进新建的 Suzhou (<后缀>)，再传复用它；手放的文件夹逐字节不变；导入时它作为待确认的绑定出现', async () => {
  await withV2Root(async (env) => {
    const { paths } = env
    env.setPlaces(chinaPlaces())
    // 国家文件夹已经指向中国（例如以前给别的城市上传过）；城市文件夹 Suzhou 是用户手放的。
    const countryRoot = path.join(paths.inboxRoot, 'China')
    const handMade = path.join(countryRoot, 'Suzhou')
    await handMadeCity(handMade)
    const countryPin = `${JSON.stringify({ placeId: CHINA.cn })}\n`
    await writeFile(path.join(countryRoot, 'place.json'), countryPin, 'utf8')
    const before = await snapshot(handMade)

    const first = await upload(env, { countryId: CHINA.cn, cityId: CHINA.suzhou, fileName: 'garden.jpg' }, await jpeg({ r: 30, g: 140, b: 90 }))
    assert.equal(first.status, 201, JSON.stringify(first.body))
    const folder = `Suzhou (${placeFolderSuffix(CHINA.suzhou)})`
    assert.equal(first.body.sourcePath, `China/${folder}/photos/garden.jpg`)
    assert.deepEqual(await readJson(path.join(countryRoot, folder, 'place.json')), { placeId: CHINA.suzhou })
    // 已指向中国的国家文件夹照常复用，它的 place.json 一个字节都不变。
    assert.equal(await readFile(path.join(countryRoot, 'place.json'), 'utf8'), countryPin)
    // 手放的文件夹：没有 place.json，里面的文件一个字节都不变，也没有多出或少掉任何东西。
    assert.equal(existsSync(path.join(handMade, 'place.json')), false)
    assert.deepEqual(await snapshot(handMade), before)

    // 再传一张：复用这次新建的文件夹（place.json 已指向苏州），手放的仍然不动。
    const second = await upload(env, { countryId: CHINA.cn, cityId: CHINA.suzhou, fileName: 'canal.jpg' }, await jpeg({ r: 90, g: 30, b: 140 }))
    assert.equal(second.status, 201, JSON.stringify(second.body))
    assert.equal(second.body.sourcePath, `China/${folder}/photos/canal.jpg`)
    assert.deepEqual(await snapshot(handMade), before)

    // 之后导入：手放的文件夹按名字匹配到苏州，作为待确认的绑定出现（第 2A 批）；新建的文件夹有 place.json，不在其中。
    assert.deepEqual(await pendingBindings(env), [['China/Suzhou', CHINA.suzhou, 'name']])
    assert.deepEqual(await snapshot(handMade), before, '扫描只读')
  })
})

test('第 2D 批：手放的国家文件夹 China（没有 place.json）同样不认领——上传新建 China (<后缀>)/Suzhou；手放的 China 整棵逐字节不变；导入时 China 与 China/Suzhou 都是待确认的绑定', async () => {
  await withV2Root(async (env) => {
    const { paths } = env
    env.setPlaces(chinaPlaces())
    const handMade = path.join(paths.inboxRoot, 'China')
    await handMadeCity(path.join(handMade, 'Suzhou'))
    const before = await snapshot(handMade)

    const result = await upload(env, { countryId: CHINA.cn, cityId: CHINA.suzhou, fileName: 'garden.jpg' }, await jpeg({ r: 30, g: 140, b: 90 }))
    assert.equal(result.status, 201, JSON.stringify(result.body))
    const countryFolder = `China (${placeFolderSuffix(CHINA.cn)})`
    assert.equal(result.body.sourcePath, `${countryFolder}/Suzhou/photos/garden.jpg`)
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, countryFolder, 'place.json')), { placeId: CHINA.cn })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, countryFolder, 'Suzhou', 'place.json')), { placeId: CHINA.suzhou })
    assert.equal(existsSync(path.join(handMade, 'place.json')), false)
    assert.equal(existsSync(path.join(handMade, 'Suzhou', 'place.json')), false)
    assert.deepEqual(await snapshot(handMade), before)

    // 两个国家文件夹最终都会指向中国：手放的那个经导入确认后才绑定（规格 §3，接受）。
    assert.deepEqual(await pendingBindings(env), [['China', CHINA.cn, 'name'], ['China/Suzhou', CHINA.suzhou, 'name']])
    assert.deepEqual(await snapshot(handMade), before, '扫描只读')
  })
})
