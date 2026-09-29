/**
 * 三个媒体端点在 V2 下的纯函数（v2media/editorWrites.ts）的单元测试（RFC-LOC-1 PR3b-3 规格 §2.4、§3「端点纯函数」）：
 * 上传时 place.json 的写入与冲突、导入后排序表的追加与隐藏状态恢复、删除时生成目录的定位与 editor-state 清理。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 数据是中性个人模式数据迁移后的 V2 文件（../v2write/v2write.fixture.ts），媒体换成按内容寻址的条目。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { V2Files } from '../canonical/v2Schema.ts'
import { WRITE_NOW, applyWrites, assertIntact, assertV2Error, migratedFiles, placeNamed, testContext, writeOrder } from '../v2write/v2write.fixture.ts'
import {
  deletableMediaOf,
  droneUploadMetadataOf,
  generatedDirectoriesOf,
  idsMissingFromSourceIndex,
  inboxFolderCandidates,
  inboxFolderDecision,
  mediaSourcesOf,
  pickInboxFolder,
  placeFolderSuffix,
  removeMediaFromEditorState,
  restoreImportedMedia,
  uploadKindOf,
  uploadTargetOf,
  type InboxFolderState,
} from './editorWrites.ts'
import { buildMediaItem, mediaCatalogFileOf, mediaIdOf } from './importPlan.ts'

const H = { p1: '1111111111111111', p2: '2222222222222222', d1: '3333333333333333', v1: '4444444444444444', x: '5555555555555555' }
const ID = Object.fromEntries(Object.entries(H).map(([key, hash]) => [key, mediaIdOf(hash)])) as Record<keyof typeof H, string>

const query = (values: Record<string, string>) => new URLSearchParams(values)

/**
 * 迁移后的 V2 文件，媒体换成按内容寻址的四项：雷克雅未克两张照片（p1、p2，p2 已隐藏且是封面），
 * 托尔斯港一张航拍（d1，已隐藏）与一段视频（v1，已隐藏）。
 */
const contentFiles = (): V2Files => {
  const files = migratedFiles()
  const reykjavik = placeNamed(files, 'Reykjavik', 'city').id
  const torshavn = placeNamed(files, 'Torshavn', 'city').id
  const photo = (hash: string, name: string) => buildMediaItem({ hash, extension: '.jpg', kind: 'photo', placeId: reykjavik, originalFileName: name, dimensions: { width: 64, height: 48 } })
  files.media = mediaCatalogFileOf([
    photo(H.p1, 'a.jpg'),
    photo(H.p2, 'b.jpg'),
    buildMediaItem({ hash: H.d1, extension: '.jpg', kind: 'aerialPhoto', placeId: torshavn, originalFileName: 'bay.jpg', dimensions: { width: 200, height: 100 }, metadata: { date: '2026-07-03', resolution: '200 × 100' } }),
    buildMediaItem({ hash: H.v1, extension: '.mp4', kind: 'video', placeId: torshavn, originalFileName: 'flight.mp4', metadata: { date: '2026-07-03', resolution: '3840 × 2160' } }),
  ], '2026-09-29T00:00:00.000Z')
  Object.assign(files.editorState, {
    mediaOrderByCity: { [reykjavik]: [ID.p2, ID.p1] },
    hiddenMediaIds: [ID.p2],
    coverMediaByCity: { [reykjavik]: ID.p2 },
    droneOrderByCity: { [torshavn]: [ID.v1, ID.d1] },
    hiddenDroneMediaIds: [ID.d1, ID.v1],
  })
  assertIntact(files, 'fixture')
  return files
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

test('上传 · kind：默认 photo；只收三种（文案同旧）', () => {
  assert.equal(uploadKindOf(query({})), 'photo')
  assert.equal(uploadKindOf(query({ kind: 'panorama360' })), 'panorama360')
  assert.equal(uploadKindOf(query({ kind: 'aerialPhoto' })), 'aerialPhoto')
  for (const kind of ['video', 'Photo', '']) assertV2Error(() => uploadKindOf(query({ kind })), 'E_MEDIA_KIND_INVALID', '不支持的媒体类型。')
})

test('上传 · 目标：cityId 是城市地点，countryId 必须是它的 partOf；文件夹名取英文名，没有则中文名', () => {
  const files = contentFiles()
  const iceland = placeNamed(files, 'Iceland', 'country')
  const reykjavik = placeNamed(files, 'Reykjavik', 'city')
  const target = uploadTargetOf(files, { countryId: iceland.id, cityId: reykjavik.id }, WRITE_NOW)
  assert.equal(target.country.id, iceland.id)
  assert.equal(target.city.id, reykjavik.id)
  assert.equal(target.countryFolderName, 'Iceland')
  assert.equal(target.cityFolderName, 'Reykjavik')

  const zhOnly = contentFiles()
  const vik = placeNamed(zhOnly, 'Vik', 'city')
  vik.names = { 'zh-Hans': '维克' }
  assert.equal(uploadTargetOf(zhOnly, { countryId: iceland.id, cityId: vik.id }, WRITE_NOW).cityFolderName, '维克')

  const faroe = placeNamed(files, 'Faroe Islands', 'country')
  const message = '找不到对应的国家和城市，请先把城市加入旅行数据。'
  assertV2Error(() => uploadTargetOf(files, { countryId: faroe.id, cityId: reykjavik.id }, WRITE_NOW), 'E_MEDIA_LOCATION_NOT_FOUND', message)
  assertV2Error(() => uploadTargetOf(files, { countryId: iceland.id, cityId: iceland.id }, WRITE_NOW), 'E_MEDIA_LOCATION_NOT_FOUND', message)
  assertV2Error(() => uploadTargetOf(files, { countryId: iceland.id, cityId: 'iceland__reykjavik' }, WRITE_NOW), 'E_MEDIA_LOCATION_NOT_FOUND', message, undefined)
  assertV2Error(() => uploadTargetOf(undefined, { countryId: iceland.id, cityId: reykjavik.id }, WRITE_NOW), 'E_MEDIA_LOCATION_NOT_FOUND', message)
  const broken = contentFiles()
  ;(broken.media.items[0] as { placeId: string }).placeId = 'ghost'
  assertV2Error(() => uploadTargetOf(broken, { countryId: iceland.id, cityId: reykjavik.id }, WRITE_NOW), 'E_INTEGRITY')
})

test('上传 · 无人机参数：日期必填、经纬度成对且在范围内、默认标题（规则与文案同旧）', () => {
  assert.deepEqual(droneUploadMetadataOf(query({ date: '2026-07-03', lat: '62.01', lng: '-6.77', altitudeMeters: '120', relativeAltitudeMeters: 'x' }), 'aerialPhoto', 'Tórshavn'), {
    kind: 'aerialPhoto',
    date: '2026-07-03',
    lat: 62.01,
    lng: -6.77,
    altitudeMeters: 120,
    relativeAltitudeMeters: undefined,
    titleZh: 'Tórshavn无人机影像',
    titleEn: 'Tórshavn Drone Media',
  })
  const titled = droneUploadMetadataOf(query({ date: '2026-07-03', titleZh: '海湾', titleEn: 'Bay' }), 'panorama360', 'X')
  assert.equal(titled.titleZh, '海湾')
  assert.equal(titled.lat, undefined)
  assertV2Error(() => droneUploadMetadataOf(query({}), 'aerialPhoto', 'X'), 'E_MEDIA_DRONE_DATE', '无人机影像必须填写有效日期。')
  assertV2Error(() => droneUploadMetadataOf(query({ date: '2026-7-3' }), 'aerialPhoto', 'X'), 'E_MEDIA_DRONE_DATE')
  assertV2Error(() => droneUploadMetadataOf(query({ date: '2026-07-03', lat: '1' }), 'aerialPhoto', 'X'), 'E_COORDINATES_PAIR', '经纬度需要同时填写，或同时留空。')
  assertV2Error(() => droneUploadMetadataOf(query({ date: '2026-07-03', lat: '91', lng: '0' }), 'aerialPhoto', 'X'), 'E_MEDIA_COORDINATES_RANGE', '经纬度超出有效范围。')
  assertV2Error(() => droneUploadMetadataOf(query({ date: '2026-07-03', lat: 'a', lng: '0' }), 'aerialPhoto', 'X'), 'E_MEDIA_COORDINATES_RANGE')
})

test('上传 · 文件夹能不能用：不存在或没有 place.json → 用并写入；已指向这个地点 → 直接用；指向别的地点或内容无效 → 被占用', () => {
  assert.equal(inboxFolderDecision('city-1', { exists: false }), 'claim')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: undefined }), 'claim', '手动建的文件夹（还没有 place.json）')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: { placeId: ' city-1 ' } }), 'mine')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: { placeId: 'city-1', note: 'x' } }), 'mine')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: { placeId: 'city-2' } }), 'taken')
  for (const invalid of [null, {}, { placeId: '' }, 'city-1', []]) {
    assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: invalid }), 'taken', JSON.stringify(invalid))
  }
})

test('上传 · 同名地点的文件夹名：显示名被别的地点占用时用 <显示名> (<地点 id 最后 8 位>)；两个都被占用 → 冲突，一个都不写', () => {
  // 先后添加的两个同名城市：UUIDv7 的前 8 位（时间戳高位）相同，最后 8 位不同。
  const first = '019b76da-0001-7000-8000-00000000a1b2'
  const second = '019b76da-0002-7000-8000-00000000c3d4'
  assert.equal(first.slice(0, 8), second.slice(0, 8))
  assert.equal(placeFolderSuffix(first), '0000a1b2')
  assert.equal(placeFolderSuffix(second), '0000c3d4')
  assert.deepEqual(inboxFolderCandidates('Springfield', second), ['Springfield', 'Springfield (0000c3d4)'])

  const candidates = (states: InboxFolderState[]) => inboxFolderCandidates('Springfield', second).map((name, index) => ({
    name,
    label: `United States/${name}`,
    state: states[index],
  }))
  assert.deepEqual(pickInboxFolder(second, candidates([{ exists: false }, { exists: false }])), { name: 'Springfield', claim: true })
  assert.deepEqual(pickInboxFolder(second, candidates([{ exists: true, placeConfig: { placeId: second } }, { exists: false }])), { name: 'Springfield', claim: false })
  assert.deepEqual(
    pickInboxFolder(second, candidates([{ exists: true, placeConfig: { placeId: first } }, { exists: false }])),
    { name: 'Springfield (0000c3d4)', claim: true },
    '显示名已归第一个 Springfield',
  )
  assert.deepEqual(
    pickInboxFolder(second, candidates([{ exists: true, placeConfig: { placeId: first } }, { exists: true, placeConfig: { placeId: second } }])),
    { name: 'Springfield (0000c3d4)', claim: false },
  )
  assertV2Error(
    () => pickInboxFolder(second, candidates([{ exists: true, placeConfig: { placeId: first } }, { exists: true, placeConfig: null }])),
    'E_MEDIA_FOLDER_CONFLICT',
    '投递箱文件夹 United States/Springfield、United States/Springfield (0000c3d4) 的 place.json 都指向别的地点（或内容无效），未写入文件。请先确认这些文件夹属于哪个地点。',
    (error) => assert.deepEqual(error.params, { folders: ['United States/Springfield', 'United States/Springfield (0000c3d4)'], expected: second }),
  )
})

// ---------------------------------------------------------------------------
// 导入之后
// ---------------------------------------------------------------------------

test('导入之后：按源文件索引找到新导入的条目，从隐藏表里恢复，追加到所在城市排序表末尾（照片与无人机分表，键为地点 id）', () => {
  const files = contentFiles()
  const reykjavik = placeNamed(files, 'Reykjavik', 'city').id
  const torshavn = placeNamed(files, 'Torshavn', 'city').id
  const sourceIndex = {
    schemaVersion: 1,
    sourcesById: {
      [ID.p1]: ['Iceland/Reykjavik/photos/a.jpg'],
      [ID.p2]: ['Iceland/Reykjavik/photos/b.jpg', 'Iceland/Reykjavik/photos/b-copy.jpg'],
      [ID.d1]: ['Faroe Islands/Torshavn/drone/bay.jpg'],
      [ID.v1]: ['Faroe Islands/Torshavn/drone/flight.mp4'],
    },
  }
  const outcome = restoreImportedMedia(files, {
    sourcePaths: ['iceland/reykjavik/photos/B-COPY.jpg', 'Faroe Islands\\Torshavn\\drone\\bay.jpg'],
    sourceIndex,
  }, testContext())
  assert.deepEqual(outcome.result, { restoredMediaIds: [ID.p2, ID.d1] })
  assert.deepEqual(writeOrder(outcome.writes), ['editorState'])
  const after = applyWrites(files, outcome.writes)
  assert.deepEqual(after.editorState.hiddenMediaIds, [])
  assert.deepEqual(after.editorState.hiddenDroneMediaIds, [ID.v1])
  assert.deepEqual(after.editorState.mediaOrderByCity, { [reykjavik]: [ID.p1, ID.p2] }, '已在表里的挪到末尾')
  assert.deepEqual(after.editorState.droneOrderByCity, { [torshavn]: [ID.v1, ID.d1] })
  assert.deepEqual(after.editorState.coverMediaByCity, files.editorState.coverMediaByCity, '封面不动')
  assert.equal(after.editorState.updatedAt, WRITE_NOW.toISOString())
  assertIntact(after)

  // 城市还没有排序表时新建。
  const fresh = contentFiles()
  fresh.editorState.mediaOrderByCity = {}
  const created = applyWrites(fresh, restoreImportedMedia(fresh, { sourcePaths: ['Iceland/Reykjavik/photos/a.jpg'], sourceIndex }, testContext()).writes)
  assert.deepEqual(created.editorState.mediaOrderByCity, { [reykjavik]: [ID.p1] })
})

test('导入之后：没有上传文件时什么都不写；索引里找不到这些文件、或索引与目录不一致 → 报错（文案同旧），不写', () => {
  const files = contentFiles()
  assert.deepEqual(restoreImportedMedia(files, { sourcePaths: [], sourceIndex: undefined }, testContext()), { writes: [], result: { restoredMediaIds: [] } })
  assertV2Error(
    () => restoreImportedMedia(files, { sourcePaths: ['Iceland/Reykjavik/photos/new.jpg'], sourceIndex: { sourcesById: { [ID.p1]: ['Iceland/Reykjavik/photos/a.jpg'] } } }, testContext()),
    'E_MEDIA_IMPORT_NO_RECORD',
    '文件已经接收，但导入结果没有对应媒体记录。请保留当前页面并查看导入详情。',
  )
  assertV2Error(() => restoreImportedMedia(files, { sourcePaths: ['a.jpg'], sourceIndex: 'broken' }, testContext()), 'E_MEDIA_IMPORT_NO_RECORD')
  assertV2Error(
    () => restoreImportedMedia(files, { sourcePaths: ['x.jpg'], sourceIndex: { sourcesById: { [ID.x]: ['x.jpg'] } } }, testContext()),
    'E_MEDIA_INDEX_MISMATCH',
    '导入索引与媒体目录不一致，已停止刷新页面。',
  )
})

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test('删除 · 能删哪些：该城市里已隐藏的照片或全景 / 航拍照片；id 去重保序（文案同旧）', () => {
  const files = contentFiles()
  const reykjavik = placeNamed(files, 'Reykjavik', 'city').id
  const torshavn = placeNamed(files, 'Torshavn', 'city').id
  const photos = deletableMediaOf(files, { cityId: reykjavik, ids: [ID.p2, ID.p2] }, WRITE_NOW)
  assert.equal(photos.cityId, reykjavik)
  assert.deepEqual(photos.ids, [ID.p2])
  assert.deepEqual(photos.items.map((item) => item.id), [ID.p2])
  assert.deepEqual(deletableMediaOf(files, { cityId: ` ${torshavn} `, ids: [ID.d1] }, WRITE_NOW).ids, [ID.d1])

  for (const input of [undefined, {}, { cityId: reykjavik, ids: [] }, { cityId: '', ids: [ID.p2] }, { cityId: reykjavik, ids: 'x' }]) {
    assertV2Error(() => deletableMediaOf(files, input, WRITE_NOW), 'E_MEDIA_DELETE_EMPTY', '没有可删除的隐藏媒体。')
  }
  const notHidden = '只能彻底删除当前城市中已经隐藏的照片或无人机影像。'
  assertV2Error(() => deletableMediaOf(files, { cityId: reykjavik, ids: [ID.p1] }, WRITE_NOW), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden, (error) => assert.equal(error.params?.id, ID.p1))
  assertV2Error(() => deletableMediaOf(files, { cityId: torshavn, ids: [ID.p2] }, WRITE_NOW), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden)
  assertV2Error(() => deletableMediaOf(files, { cityId: torshavn, ids: [ID.v1] }, WRITE_NOW), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden, (error) => assert.equal(error.params?.id, ID.v1))
  assertV2Error(() => deletableMediaOf(files, { cityId: reykjavik, ids: [ID.p2, 'ghost'] }, WRITE_NOW), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden)
})

test('删除 · 源文件：索引里缺哪些 id；每个 id 的全部源文件；缺了或为空 → 报错（文案同旧）', () => {
  const index = { sourcesById: { [ID.p2]: ['Iceland/Reykjavik/photos/b.jpg', 'Iceland/Reykjavik/photos/b-copy.jpg'], [ID.d1]: [] } }
  assert.deepEqual(idsMissingFromSourceIndex(index, [ID.p2, ID.d1, ID.p1]), [ID.p1])
  assert.deepEqual(idsMissingFromSourceIndex(undefined, [ID.p2]), [ID.p2])
  assert.deepEqual(mediaSourcesOf(index, [ID.p2]), ['Iceland/Reykjavik/photos/b.jpg', 'Iceland/Reykjavik/photos/b-copy.jpg'])
  assertV2Error(() => mediaSourcesOf(index, [ID.p1]), 'E_MEDIA_SOURCE_MISSING', `找不到媒体 ${ID.p1} 对应的投递箱原图，已停止删除。`)
  assertV2Error(() => mediaSourcesOf(index, [ID.d1]), 'E_MEDIA_SOURCE_MISSING')
})

test('删除 · 生成目录：由 src 定位到内容寻址的 media/user/<哈希>/（去重）；不是这种形状 → 一个都不删', () => {
  const files = contentFiles()
  const items = files.media.items
  assert.deepEqual(generatedDirectoriesOf([items[1], items[2], items[1]]), [H.p2, H.d1])
  assert.deepEqual(generatedDirectoriesOf([items[3]]), [H.v1], '视频也一样')
  const legacyShaped = { ...items[0], src: '/media/user/iceland/reykjavik/photo/1111111111111111/original.jpg' }
  assertV2Error(() => generatedDirectoriesOf([items[1], legacyShaped]), 'E_MEDIA_PATH_INVALID', '影像生成路径格式无效，已停止删除。')
  assertV2Error(() => generatedDirectoriesOf([{ ...items[0], src: '/media/user/../../secret/original.jpg' }]), 'E_MEDIA_PATH_INVALID')
})

test('删除 · editor-state：清掉这些 id（两个隐藏表、两个排序表、指向它们的封面），其余不动；只写 editor-state', () => {
  const files = contentFiles()
  const reykjavik = placeNamed(files, 'Reykjavik', 'city').id
  const torshavn = placeNamed(files, 'Torshavn', 'city').id
  const outcome = removeMediaFromEditorState(files, [ID.p2, ID.d1], testContext())
  assert.deepEqual(outcome.result, { deletedIds: [ID.p2, ID.d1] })
  assert.deepEqual(writeOrder(outcome.writes), ['editorState'])
  const after = applyWrites(files, outcome.writes)
  assert.deepEqual(after.editorState.hiddenMediaIds, [])
  assert.deepEqual(after.editorState.hiddenDroneMediaIds, [ID.v1])
  assert.deepEqual(after.editorState.mediaOrderByCity, { [reykjavik]: [ID.p1] })
  assert.deepEqual(after.editorState.droneOrderByCity, { [torshavn]: [ID.v1] })
  assert.deepEqual(after.editorState.coverMediaByCity, {}, '封面指向被删的照片时一并清掉')
  for (const key of ['countryOrder', 'hiddenCountryIds', 'cityOrderByCountry', 'hiddenCityIds', 'addedCountries'] as const) {
    assert.deepEqual(after.editorState[key], files.editorState[key], key)
  }
  assertIntact(after)
  assert.deepEqual(files.editorState.hiddenMediaIds, [ID.p2], '输入不被修改')

  // 现有文件不合法时不在它上面继续（E_INTEGRITY，不给出写入）。
  const broken = contentFiles()
  broken.editorState.mediaOrderByCity = { ghost: [] }
  assertV2Error(() => removeMediaFromEditorState(broken, [ID.p2], testContext()), 'E_INTEGRITY')
})
