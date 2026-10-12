/**
 * V2 媒体端点 IO 层（scripts/v2-media-store.mjs）的端到端测试（RFC-LOC-1 PR3b-3 规格 §2.4、§3）：在临时私人根上
 * 依次上传照片与全景 → 导入（恢复隐藏、追加排序）→ 隐藏 → 彻底删除，每一步之后五个 V2 文件都通过完整性检查。
 *
 * 插件本身在模块顶层 import sharp / undici / world-countries 并解析私有资料层路径，node --test 下不能加载，
 * 所以插件传给 IO 层的辅助函数（deps）在这里重写无人机 sidecar、删 sidecar 条目与路径规则。
 * 文件名、预留文件名与上传流直接复用 local-editor-upload.mjs，导入器复用 local-editor-importer.mjs。
 * 上传请求使用带 content-length 的 Readable 流，走真实接收与图片校验。插件接线由 private-data-module.test.mjs 读源码断言。
 *
 * 图片由 sharp 现场生成（纯色小图，一张 2:1）。STARMAP_PRIVATE_ROOT 总是指向 fs.mkdtemp 建的临时目录，用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { atomicJsonWrite, exists, readJson } from './json-file.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { V2_EDITOR_ROUTES, createV2WriteContext, readV2EditorState, readV2Files, runV2Write } from './v2-editor-store.mjs'
import { handleV2Import, handleV2MediaDelete, handleV2Upload } from './v2-media-store.mjs'
import { createLocalEditorImporter } from './local-editor-importer.mjs'
import { safeSegment, reserveDestination, writeUpload } from './local-editor-upload.mjs'
import { V2WriteError } from '../src/data/v2write/errors.ts'
import { placeFolderSuffix } from '../src/data/v2media/editorWrites.ts'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { completeForWrite, integrityProblems } from '../src/data/v2write/transaction.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/** 上传与导入复用插件实际 helper；sidecar 与路径 helper 使用合成私人根。 */
const depsFor = (paths) => {
  const inboxRoot = paths.inboxRoot
  const isPathInside = (root, target) => {
    const relative = path.relative(root, target)
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  return {
    isPathInside,
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
    runImporter: createLocalEditorImporter({ webRoot, privateRoot: paths.root }),
    normalizeInboxRelativePath: (value) => {
      if (typeof value !== 'string' || !value.trim()) return undefined
      const target = path.resolve(inboxRoot, value.trim())
      if (!isPathInside(inboxRoot, target)) throw new Error('媒体源文件路径超出投递箱范围。')
      return path.relative(inboxRoot, target).split(path.sep).join('/')
    },
    removeSidecarEntries: async (sourcePaths) => {
      for (const sourcePath of sourcePaths) {
        const mediaFolder = path.dirname(sourcePath)
        const sidecarPath = path.join(path.dirname(mediaFolder), 'media.json')
        if (!await exists(sidecarPath)) continue
        const key = path.posix.join(path.basename(mediaFolder), path.basename(sourcePath)).toLocaleLowerCase('en-US')
        const sidecar = await readJson(sidecarPath, {})
        let changed = false
        for (const candidate of Object.keys(sidecar)) {
          if (candidate.replaceAll('\\', '/').toLocaleLowerCase('en-US') !== key) continue
          delete sidecar[candidate]
          changed = true
        }
        if (changed) await atomicJsonWrite(sidecarPath, sidecar)
      }
    },
  }
}

const withV2Root = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-v2-media-store-test-'))
  const root = path.join(directory, 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, `${JSON.stringify(placesFile(), null, 2)}\n`, 'utf8')
  try {
    await run({ root, paths, deps: depsFor(paths), ctx: createV2WriteContext({ countryCatalog: new Map() }) })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const upload = async ({ paths, deps }, params, body) => {
  const request = Readable.from([body])
  request.headers = { 'content-length': String(body.length) }
  return handleV2Upload({ privatePaths: paths, query: new URLSearchParams(params), request, deps })
}

const assertIntact = async (paths, step) => {
  const problems = integrityProblems(completeForWrite(await readV2Files(paths), new Date()))
  assert.deepEqual(problems, [], `${step}：五个 V2 文件应通过完整性检查`)
}

const readCatalog = (paths) => readJson(paths.v2FilePaths.media, { items: [] })

/** GET → 改 → PUT（客户端的整份写回，走 PR3b-2 的真实路径）。 */
const editState = async ({ paths, ctx }, change) => {
  const current = await readV2EditorState({ privatePaths: paths })
  assert.equal(current.status, 200)
  const state = current.body.state
  change(state)
  const result = await runV2Write({ privatePaths: paths, route: V2_EDITOR_ROUTES['PUT /__travelatlas/editor/state'], input: state, ctx })
  assert.equal(result.status, 200, JSON.stringify(result.body))
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

test('V2 媒体端点：上传（写 place.json）→ 导入（恢复与追加排序）→ 隐藏 → 彻底删除（源文件、sidecar 条目、生成目录、editor-state）', async () => {
  await withV2Root(async (env) => {
    const { paths, deps, ctx } = env
    const red = await jpeg({ r: 200, g: 30, b: 30 })
    const green = await jpeg({ r: 30, g: 160, b: 60 })
    const pano = await jpeg({ r: 230, g: 200, b: 40 }, 200, 100)

    // ---- 上传两张照片 ----
    const first = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, kind: 'photo', fileName: 'Harbour.JPG' }, red)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.deepEqual(first.body, { ok: true, fileName: 'Harbour.jpg', bytes: red.length, sourcePath: 'Iceland/Reykjavik/photos/Harbour.jpg' })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Iceland', 'place.json')), { placeId: ID.iceland })
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'place.json')), { placeId: ID.reykjavik })
    const second = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, fileName: 'church.jpg' }, green)
    assert.equal(second.status, 201, JSON.stringify(second.body))

    // ---- 导入：新条目追加到排序表 ----
    const imported = await handleV2Import({ privatePaths: paths, input: { sourcePaths: [first.body.sourcePath, second.body.sourcePath] }, ctx, deps })
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.match(imported.body.output, /^StarMap 媒体导入：2 个文件$/m)
    const catalog = await readCatalog(paths)
    const idOf = (fileName) => catalog.items.find((item) => item.originalFileName === fileName).id
    const harbourId = idOf('Harbour.jpg')
    const churchId = idOf('church.jpg')
    assert.match(harbourId, /^media-[0-9a-f]{16}$/)
    assert.deepEqual(imported.body.restoredMediaIds.sort(), [harbourId, churchId].sort())
    let state = (await readV2EditorState({ privatePaths: paths })).body.state
    assert.deepEqual(state.mediaOrderByCity, { [ID.reykjavik]: imported.body.restoredMediaIds })
    await assertIntact(paths, '导入照片之后')

    // ---- 上传一张全景（无人机 sidecar）并导入 ----
    const panorama = await upload(env, { countryId: ID.faroe, cityId: ID.torshavn, kind: 'panorama360', fileName: 'bay.jpg', date: '2026-07-03', titleZh: '海湾', titleEn: 'Bay' }, pano)
    assert.equal(panorama.status, 201, JSON.stringify(panorama.body))
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Faroe Islands', 'place.json')), { placeId: ID.faroe })
    assert.equal((await readJson(path.join(paths.inboxRoot, 'Faroe Islands', 'Torshavn', 'media.json')))['drone/bay.jpg'].kind, 'panorama360')
    const panoImport = await handleV2Import({ privatePaths: paths, input: { sourcePaths: [panorama.body.sourcePath] }, ctx, deps })
    assert.equal(panoImport.status, 200, JSON.stringify(panoImport.body))
    const panoId = panoImport.body.restoredMediaIds[0]
    const panoItem = (await readCatalog(paths)).items.find((item) => item.id === panoId)
    assert.equal(panoItem.kind, 'panorama360')
    assert.equal(panoItem.placeId, ID.torshavn)
    assert.deepEqual(panoItem.title, { names: { 'zh-Hans': '海湾', en: 'Bay' } })
    state = (await readV2EditorState({ privatePaths: paths })).body.state
    assert.deepEqual(state.droneOrderByCity, { [ID.torshavn]: [panoId] })
    await assertIntact(paths, '导入全景之后')

    // ---- 隐藏教堂照片（并设为封面）与全景；重新上传同一张会恢复 ----
    await editState(env, (draft) => {
      draft.hiddenMediaIds = [churchId]
      draft.coverMediaByCity = { [ID.reykjavik]: churchId }
      draft.hiddenDroneMediaIds = [panoId]
    })
    const again = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, fileName: 'church.jpg' }, green)
    assert.equal(again.body.sourcePath, 'Iceland/Reykjavik/photos/church-1.jpg', '同名文件不覆盖')
    const reimported = await handleV2Import({ privatePaths: paths, input: { sourcePaths: [again.body.sourcePath] }, ctx, deps })
    assert.deepEqual(reimported.body.restoredMediaIds, [churchId], '内容相同 → 同一个 id')
    state = (await readV2EditorState({ privatePaths: paths })).body.state
    assert.deepEqual(state.hiddenMediaIds, [])
    assert.deepEqual(state.mediaOrderByCity[ID.reykjavik], [harbourId, churchId])
    await editState(env, (draft) => { draft.hiddenMediaIds = [churchId] })

    // ---- 删除：没隐藏的不能删；该城市里已隐藏的可以删 ----
    const refused = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [harbourId] }, ctx, deps })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.code, 'E_MEDIA_DELETE_NOT_HIDDEN')
    assert.equal(refused.body.error, '只能彻底删除当前城市中已经隐藏的照片或无人机影像。')
    const churchHash = churchId.slice('media-'.length)
    assert.ok(existsSync(path.join(paths.userMediaRoot, churchHash, 'thumb.webp')))

    const deleted = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [churchId] }, ctx, deps })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.deepEqual(deleted.body.deletedIds, [churchId])
    assert.equal(deleted.body.deletedSourceFiles, 2, '同一内容的两个源文件都删')
    assert.equal(existsSync(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'church.jpg')), false)
    assert.equal(existsSync(path.join(paths.inboxRoot, 'Iceland', 'Reykjavik', 'photos', 'church-1.jpg')), false)
    assert.equal(existsSync(path.join(paths.userMediaRoot, churchHash)), false, '生成目录已删')
    assert.ok(existsSync(path.join(paths.userMediaRoot, harbourId.slice('media-'.length), 'original.jpg')), '别的生成目录不动')
    state = (await readV2EditorState({ privatePaths: paths })).body.state
    assert.deepEqual(state.hiddenMediaIds, [])
    assert.deepEqual(state.mediaOrderByCity[ID.reykjavik], [harbourId])
    assert.deepEqual(state.coverMediaByCity, {})
    assert.equal((await readCatalog(paths)).items.some((item) => item.id === churchId), false, '导入器重新运行后目录里没有它')
    assert.equal(Object.hasOwn((await readJson(paths.v2MediaSourceIndexPath)).sourcesById, churchId), false)
    await assertIntact(paths, '删除照片之后')

    // ---- 删除全景：sidecar 条目一起删 ----
    const panoDeleted = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.torshavn, ids: [panoId] }, ctx, deps })
    assert.equal(panoDeleted.status, 200, JSON.stringify(panoDeleted.body))
    assert.deepEqual(await readJson(path.join(paths.inboxRoot, 'Faroe Islands', 'Torshavn', 'media.json')), {})
    assert.equal(existsSync(path.join(paths.userMediaRoot, panoId.slice('media-'.length))), false)
    state = (await readV2EditorState({ privatePaths: paths })).body.state
    assert.deepEqual(state.hiddenDroneMediaIds, [])
    assert.deepEqual(state.droneOrderByCity, { [ID.torshavn]: [] })
    await assertIntact(paths, '删除全景之后')

    // 收件箱里剩下的：一张照片与三个 place.json；没有写任何旧文件。
    assert.deepEqual(await listTree(paths.inboxRoot), [
      'Faroe Islands/Torshavn/media.bak',
      'Faroe Islands/Torshavn/media.json',
      'Faroe Islands/Torshavn/place.json',
      'Faroe Islands/place.json',
      'Iceland/Reykjavik/photos/Harbour.jpg',
      'Iceland/Reykjavik/place.json',
      'Iceland/place.json',
    ].sort())
    for (const legacy of [paths.mediaCatalogPath, path.join(paths.dataRoot, 'media-source-index.local.json'), paths.editorStatePath, paths.localTravelMapPath]) {
      assert.equal(existsSync(legacy), false, legacy)
    }
  })
})

test('V2 上传的拒绝：类型、地点、扩展名、无人机日期、真实上传校验、place.json 冲突——都不写文件', async () => {
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

    // 显示名的文件夹与带后缀的文件夹都已有 place.json 且指向别的地点：冲突，不写文件。
    const suffixed = `维克 (${placeFolderSuffix(ID.vik)})`
    await writeFile(path.join(paths.inboxRoot, 'Iceland', '维克', 'place.json'), `${JSON.stringify({ placeId: ID.reykjavik })}\n`, 'utf8')
    await mkdir(path.join(paths.inboxRoot, 'Iceland', suffixed), { recursive: true })
    await writeFile(path.join(paths.inboxRoot, 'Iceland', suffixed, 'place.json'), `${JSON.stringify({ placeId: ID.torshavn })}\n`, 'utf8')
    const before = await listTree(paths.inboxRoot)
    const conflict = await upload(env, { countryId: ID.iceland, cityId: ID.vik, fileName: 'other.jpg' }, red)
    assert.equal(conflict.status, 400)
    assert.equal(conflict.body.code, 'E_MEDIA_FOLDER_CONFLICT')
    assert.equal(conflict.body.error, `投递箱文件夹 Iceland/维克、Iceland/${suffixed} 的 place.json 都指向别的地点（或内容无效），未写入文件。请先确认这些文件夹属于哪个地点。`)
    assert.deepEqual(await listTree(paths.inboxRoot), before)
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
    const { paths, deps, ctx } = env
    await writeFile(paths.v2FilePaths.places, `${JSON.stringify(sameNamePlaces(), null, 2)}\n`, 'utf8')
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

    const imported = await handleV2Import({
      privatePaths: paths,
      input: { sourcePaths: [a, b, lower, b2].map((result) => result.body.sourcePath) },
      ctx,
      deps,
    })
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    const owners = Object.fromEntries((await readCatalog(paths)).items.map((item) => [item.originalFileName, item.placeId]))
    assert.deepEqual(owners, {
      'capitol.jpg': SAME_NAME.springfieldA,
      'armory.jpg': SAME_NAME.springfieldB,
      'park.jpg': SAME_NAME.springfieldB,
      'square.jpg': SAME_NAME.springfieldLower,
    })
    const state = (await readV2EditorState({ privatePaths: paths })).body.state
    assert.equal(state.mediaOrderByCity[SAME_NAME.springfieldA].length, 1)
    assert.equal(state.mediaOrderByCity[SAME_NAME.springfieldB].length, 2)
    assert.equal(state.mediaOrderByCity[SAME_NAME.springfieldLower].length, 1)
    await assertIntact(paths, '同名城市导入之后')
  })
})

test('V2 导入的拒绝：预检有需要处理的问题 → E_MEDIA_IMPORT_FAILED（原因原样），不写 editor-state；请求路径超出收件箱 → E_MEDIA_IMPORT_PATH_INVALID', async () => {
  await withV2Root(async (env) => {
    const { paths, deps, ctx } = env
    await mkdir(path.join(paths.inboxRoot, 'Atlantis', 'Capital', 'photos'), { recursive: true })
    await writeFile(path.join(paths.inboxRoot, 'Atlantis', 'Capital', 'photos', 'a.jpg'), await jpeg({ r: 1, g: 2, b: 3 }))
    const failed = await handleV2Import({ privatePaths: paths, input: { sourcePaths: ['Atlantis/Capital/photos/a.jpg'] }, ctx, deps })
    assert.equal(failed.status, 400)
    assert.equal(failed.body.code, 'E_MEDIA_IMPORT_FAILED')
    assert.match(failed.body.error, /找不到国家：Atlantis/)
    assert.equal(existsSync(paths.v2FilePaths.editorState), false)
    assert.equal(existsSync(paths.v2FilePaths.media), false)

    const outside = await handleV2Import({ privatePaths: paths, input: { sourcePaths: ['../../etc/passwd'] }, ctx, deps })
    assert.equal(outside.status, 400)
    assert.equal(outside.body.code, 'E_MEDIA_IMPORT_PATH_INVALID')
    assert.equal(outside.body.error, '媒体源文件路径超出投递箱范围。')
  })
})

test('V2 导入的拒绝：预检提醒里有未解决信息（无人机缺日期）→ E_MEDIA_IMPORT_BLOCKED，带导入器的完整输出', async () => {
  await withV2Root(async (env) => {
    const { paths, deps, ctx } = env
    const cityRoot = path.join(paths.inboxRoot, 'Iceland', 'Reykjavik')
    await mkdir(path.join(cityRoot, 'drone'), { recursive: true })
    await writeFile(path.join(cityRoot, 'drone', 'shot.jpg'), await jpeg({ r: 9, g: 9, b: 9 }))
    await writeFile(path.join(cityRoot, 'media.json'), `${JSON.stringify({ 'drone/shot.jpg': { kind: 'aerialPhoto' } })}\n`, 'utf8')
    const blocked = await handleV2Import({ privatePaths: paths, input: { sourcePaths: ['Iceland/Reykjavik/drone/shot.jpg'] }, ctx, deps })
    assert.equal(blocked.status, 400)
    assert.equal(blocked.body.code, 'E_MEDIA_IMPORT_BLOCKED')
    assert.equal(blocked.body.error, '媒体预检发现未解决信息，已停止导入。')
    assert.match(blocked.body.details, /缺少日期或分辨率/)
    assert.equal(existsSync(paths.v2FilePaths.media), false)
  })
})

test('V2 删除：editor-state 通不过完整性检查时一个文件都不删', async () => {
  await withV2Root(async (env) => {
    const { paths, deps, ctx } = env
    const upload1 = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, fileName: 'a.jpg' }, await jpeg({ r: 5, g: 5, b: 5 }))
    await handleV2Import({ privatePaths: paths, input: { sourcePaths: [upload1.body.sourcePath] }, ctx, deps })
    const id = (await readCatalog(paths)).items[0].id
    await editState(env, (draft) => { draft.hiddenMediaIds = [id] })
    // 手工把 editor-state 弄坏（引用一个不存在的地点）。
    const state = await readJson(paths.v2FilePaths.editorState)
    state.cityOrderByCountry = { [newId()]: [] }
    await writeFile(paths.v2FilePaths.editorState, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    const before = [...await listTree(paths.inboxRoot), ...await listTree(paths.userMediaRoot)]
    const result = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [id] }, ctx, deps })
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'E_INTEGRITY')
    assert.deepEqual([...await listTree(paths.inboxRoot), ...await listTree(paths.userMediaRoot)], before)
    assert.deepEqual(await readFile(paths.v2FilePaths.editorState, 'utf8'), `${JSON.stringify(state, null, 2)}\n`)
  })
})

test('V2 导入保留明确错误码、参数、原始文案和 details，不按文案或 details 推断阻断', async () => {
  const cases = [
    Object.assign(new V2WriteError('E_MEDIA_IMPORT_BLOCKED'), { details: '原预检输出\r\n' }),
    Object.assign(new V2WriteError('E_MEDIA_IMPORT_FAILED', { reason: 'apply IO failure\n', stage: 'apply' }), { details: 'original stdout\noriginal stderr\n' }),
    new V2WriteError('E_MEDIA_IMPORT_BLOCKED'),
    Object.assign(new V2WriteError('E_REQUIRED', { field: 'search_query' }), { details: '' }),
    Object.assign(new Error('future typed diagnostic'), { name: 'V2WriteError', code: 'E_FUTURE', params: { stage: 'apply' }, details: 'future details\n' }),
  ]
  for (const error of cases) {
    let calls = 0
    const result = await handleV2Import({ privatePaths: {}, input: {}, ctx: {}, deps: { runImporter: async () => {
      calls += 1
      throw error
    } } })
    assert.equal(calls, 1)
    assert.equal(result.status, 400)
    assert.deepEqual(result.body, {
      ok: false, error: error.message, code: error.code,
      ...(error.params !== undefined ? { params: error.params } : {}),
      ...(typeof error.details === 'string' ? { details: error.details } : {}),
    })
  }
})

test('V2 导入普通错误即使带 details 或阻断文案仍是 FAILED，保留原始诊断', async () => {
  for (const error of [
    Object.assign(new Error('IO failure\r\n'), { code: 'EACCES', details: '  stdout\n\nstderr\r\n' }),
    Object.assign(new Error('媒体预检发现未解决信息，已停止导入。'), { details: 'raw diagnostic\n' }),
    Object.assign(new Error('failure with empty details'), { details: '' }),
  ]) {
    const result = await handleV2Import({ privatePaths: {}, input: {}, ctx: {}, deps: { runImporter: async () => { throw error } } })
    assert.equal(result.status, 400)
    assert.deepEqual(result.body, {
      ok: false, error: error.message, code: 'E_MEDIA_IMPORT_FAILED',
      params: { reason: error.message }, details: error.details,
    })
  }
})

// ---------------------------------------------------------------------------
// 第 1 批 D5：删除前预检；导入器成功之后才清理 editor-state
// ---------------------------------------------------------------------------

/** 私人根下每个文件的内容哈希（含 data/v2、投递箱与生成文件）。 */
const hashTree = async (root) => {
  const result = {}
  for (const name of await listTree(root)) result[name] = createHash('sha256').update(await readFile(path.join(root, ...name.split('/')))).digest('hex')
  return result
}

/** 上传并导入一张照片，再把它隐藏。返回它的媒体 id 与源文件路径。 */
const hiddenPhoto = async (env, fileName, color) => {
  const { paths, deps, ctx } = env
  const uploaded = await upload(env, { countryId: ID.iceland, cityId: ID.reykjavik, fileName }, await jpeg(color))
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
  const imported = await handleV2Import({ privatePaths: paths, input: { sourcePaths: [uploaded.body.sourcePath] }, ctx, deps })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  const id = imported.body.restoredMediaIds[0]
  await editState(env, (draft) => { draft.hiddenMediaIds = [...new Set([...draft.hiddenMediaIds, id])] })
  return { id, source: path.join(paths.inboxRoot, ...uploaded.body.sourcePath.split('/')) }
}

test('D5 删除前预检：投递箱里有无关的阻断问题 → E_MEDIA_DELETE_BLOCKED，带诊断，磁盘上什么都不变', async () => {
  await withV2Root(async (env) => {
    const { root, paths, deps, ctx } = env
    const { id } = await hiddenPhoto(env, 'hidden.jpg', { r: 90, g: 10, b: 10 })
    // 无关的问题：一个解析不到的城市文件夹。
    await mkdir(path.join(paths.inboxRoot, 'Iceland', 'Nowhere Town', 'photos'), { recursive: true })
    await writeFile(path.join(paths.inboxRoot, 'Iceland', 'Nowhere Town', 'photos', 'stray.jpg'), await jpeg({ r: 1, g: 2, b: 3 }))
    const before = await hashTree(root)
    const result = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [id] }, ctx, deps })
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'E_MEDIA_DELETE_BLOCKED')
    assert.match(result.body.error, /没有删除任何文件/)
    assert.match(result.body.details, /Nowhere Town/)
    assert.deepEqual(await hashTree(root), before, '源文件、sidecar、生成文件与五个 V2 文件都不变')
  })
})

test('第 2A 批：投递箱里有按文件夹名匹配、还没确认的绑定 → 删除前预检拦下（E_MEDIA_DELETE_BLOCKED，列出绑定）；/import 端点同样拦下（E_MEDIA_IMPORT_BLOCKED）；都不写', async () => {
  await withV2Root(async (env) => {
    const { root, paths, deps, ctx } = env
    const { id } = await hiddenPhoto(env, 'hidden.jpg', { r: 90, g: 10, b: 10 })
    // 手动放的城市文件夹：没有 place.json，按文件夹名「维克」只匹配到一个城市——仍然只是匹配提示，要确认。
    await mkdir(path.join(paths.inboxRoot, 'Iceland', '维克', 'photos'), { recursive: true })
    await writeFile(path.join(paths.inboxRoot, 'Iceland', '维克', 'photos', 'manual.jpg'), await jpeg({ r: 4, g: 5, b: 6 }))
    const before = await hashTree(root)
    const deleted = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [id] }, ctx, deps })
    assert.equal(deleted.status, 400)
    assert.equal(deleted.body.code, 'E_MEDIA_DELETE_BLOCKED')
    assert.ok(deleted.body.details.includes(`待确认的文件夹绑定：Iceland/维克 → 维克（城市，按文件夹名，${ID.vik}）`), deleted.body.details)
    assert.match(deleted.body.details, /--accept-folder-bindings/)
    const imported = await handleV2Import({ privatePaths: paths, input: { sourcePaths: [] }, ctx, deps })
    assert.equal(imported.status, 400)
    assert.equal(imported.body.code, 'E_MEDIA_IMPORT_BLOCKED')
    assert.match(imported.body.details, /待确认的文件夹绑定（1）/)
    // 导入器子进程会记录库操作租约（operations/ 下的协调文件），那不是数据。
    const data = (tree) => Object.fromEntries(Object.entries(tree).filter(([name]) => !name.startsWith('operations/')))
    assert.deepEqual(data(await hashTree(root)), data(before), '没有写 place.json，也没有删除或导入任何文件')
  })
})

test('D5 删除前预检按删除之后的投递箱判断：要删的那张图本身坏了也能删', async () => {
  await withV2Root(async (env) => {
    const { paths, deps, ctx } = env
    const { id, source } = await hiddenPhoto(env, 'broken-later.jpg', { r: 10, g: 90, b: 10 })
    // On Windows libvips' cache keeps the validated upload open; drop it before corrupting the file.
    sharp.cache(false)
    try {
      await writeFile(source, 'no longer an image')
    } finally {
      sharp.cache(true)
    }
    const result = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [id] }, ctx, deps })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(existsSync(source), false)
    assert.equal((await readCatalog(paths)).items.some((item) => item.id === id), false)
    assert.deepEqual((await readV2EditorState({ privatePaths: paths })).body.state.hiddenMediaIds, [])
  })
})

test('D5 删除之后导入器失败：E_PARTIAL_WRITE 如实说明，条目仍保持隐藏、不会以坏图出现；修复后重新导入即可', async () => {
  await withV2Root(async (env) => {
    const { paths, ctx } = env
    const { id, source } = await hiddenPhoto(env, 'hidden.jpg', { r: 10, g: 10, b: 90 })
    const failing = { ...env.deps, runImporter: async () => {
      const failure = new V2WriteError('E_MEDIA_IMPORT_FAILED', { reason: 'synthetic importer failure', stage: 'apply' })
      failure.details = 'synthetic importer output'
      throw failure
    } }
    const result = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [id] }, ctx, deps: failing })
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'E_PARTIAL_WRITE')
    assert.match(result.body.params.message, /影像文件已删除/)
    assert.match(result.body.params.message, /媒体目录还没有刷新/)
    assert.match(result.body.params.message, /仍保持隐藏/)
    assert.match(result.body.params.message, /重新导入/)
    assert.equal(result.body.details, 'synthetic importer output')
    assert.equal(existsSync(source), false, '文件已经删除')
    assert.ok((await readCatalog(paths)).items.some((item) => item.id === id), '目录还没刷新')
    assert.ok((await readV2EditorState({ privatePaths: paths })).body.state.hiddenMediaIds.includes(id), '条目仍在隐藏列表里')

    // 修复之后重新导入：目录不再列出它；隐藏列表里留下的 id 无害。
    const reimported = await handleV2Import({ privatePaths: paths, input: {}, ctx, deps: env.deps })
    assert.equal(reimported.status, 200, JSON.stringify(reimported.body))
    assert.equal((await readCatalog(paths)).items.some((item) => item.id === id), false)
    await assertIntact(paths, '重新导入之后')
  })
})

test('D5 导入器成功、editor-state 写入失败：E_PARTIAL_WRITE；残留的已删 id 不触发完整性检查，后续保存照常', async (t) => {
  await withV2Root(async (env) => {
    const { paths, deps, ctx } = env
    const { id } = await hiddenPhoto(env, 'hidden.jpg', { r: 120, g: 120, b: 10 })
    const originalOpen = fsPromises.open
    t.mock.method(fsPromises, 'open', async (...args) => {
      if (/editor-state\.local\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(String(args[0]))) throw Object.assign(new Error('injected editor-state failure'), { code: 'EIO' })
      return originalOpen(...args)
    })
    syncBuiltinESMExports()
    let result
    try {
      result = await handleV2MediaDelete({ privatePaths: paths, input: { cityId: ID.reykjavik, ids: [id] }, ctx, deps })
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'E_PARTIAL_WRITE')
    assert.equal(result.body.params.failed, 'editorState')
    assert.match(result.body.params.message, /媒体目录已刷新，但编辑状态没有更新/)
    assert.equal((await readCatalog(paths)).items.some((item) => item.id === id), false, '目录已刷新')
    assert.ok((await readV2EditorState({ privatePaths: paths })).body.state.hiddenMediaIds.includes(id), '已删的 id 残留在隐藏列表里')
    await assertIntact(paths, '残留已删 id 之后')
    // 后续保存不被阻塞。
    await editState(env, (draft) => { draft.hiddenCityIds = [] })
    await assertIntact(paths, '后续保存之后')
  })
})
