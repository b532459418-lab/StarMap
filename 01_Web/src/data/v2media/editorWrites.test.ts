/**
 * 三个媒体端点在 V2 下的纯函数（v2media/editorWrites.ts）的单元测试（RFC-LOC-1 PR3b-3 规格 §2.4、§3「端点纯函数」）：
 * 上传时 place.json 的写入与冲突（第 2D 批：手放的文件夹不认领）、导入后排序表的追加与隐藏状态恢复、删除时生成目录的定位与 editor-state 清理。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 数据是中性个人模式数据迁移后的 V2 文件（../editor/editor.fixture.ts），媒体换成按内容寻址的条目。
 * 3C-5 E: the upload target and the deletion rule read the official reader; the tests give them the reader of these files
 * migrated into an empty store (readerOf).
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { V2Files } from '../compat/v2/v2Schema.ts'
import { assertIntact, assertV2Error, migratedFiles, placeNamed } from '../editor/editor.fixture.ts'
import {
  deletableMediaOf,
  droneUploadMetadataOf,
  generatedDirectoriesOf,
  INBOX_FOLDER_CANDIDATE_COUNT,
  inboxFolderCandidates,
  inboxFolderDecision,
  pickInboxFolder,
  placeFolderSuffix,
  uploadKindOf,
  uploadTargetOf,
  type InboxFolderState,
} from './editorWrites.ts'
import { buildMediaItem, mediaIdOf } from './importPlan.ts'
import { mediaCatalogFileOf } from '../compat/v2/v2MediaFiles.ts'
import { officialReader } from '../store/officialReader.ts'
import { migrateIntoEmptyStore } from '../store/v2Store.fixture.ts'
import { readModelOf } from '../../worldgraph/readModel/build.ts'
import { indexReadModel } from '../../worldgraph/readModel/lookup.ts'
import { emptyFormalState } from '../../worldgraph/store/formal.ts'

const H = { p1: '1111111111111111', p2: '2222222222222222', d1: '3333333333333333', v1: '4444444444444444', x: '5555555555555555' }
const ID = Object.fromEntries(Object.entries(H).map(([key, hash]) => [key, mediaIdOf(hash)])) as Record<keyof typeof H, string>

const query = (values: Record<string, string>) => new URLSearchParams(values)

/** The official reader of `files` migrated into an empty store (the media rules' input since 3C-5 E). */
const readerOf = (files: V2Files) => officialReader(indexReadModel(readModelOf(migrateIntoEmptyStore(files).state, { origin: 'local' })))

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
  const reader = readerOf(files)
  const target = uploadTargetOf(reader, { countryId: iceland.id, cityId: reykjavik.id })
  assert.equal(target.country.id, iceland.id)
  assert.equal(target.city.id, reykjavik.id)
  assert.equal(target.countryFolderName, 'Iceland')
  assert.equal(target.cityFolderName, 'Reykjavik')

  const zhOnly = contentFiles()
  const vik = placeNamed(zhOnly, 'Vik', 'city')
  vik.names = { 'zh-Hans': '维克' }
  assert.equal(uploadTargetOf(readerOf(zhOnly), { countryId: iceland.id, cityId: vik.id }).cityFolderName, '维克')

  const faroe = placeNamed(files, 'Faroe Islands', 'country')
  const message = '找不到对应的国家和城市，请先把城市加入旅行数据。'
  assertV2Error(() => uploadTargetOf(reader, { countryId: faroe.id, cityId: reykjavik.id }), 'E_MEDIA_LOCATION_NOT_FOUND', message)
  assertV2Error(() => uploadTargetOf(reader, { countryId: iceland.id, cityId: iceland.id }), 'E_MEDIA_LOCATION_NOT_FOUND', message)
  assertV2Error(() => uploadTargetOf(reader, { countryId: iceland.id, cityId: 'iceland__reykjavik' }), 'E_MEDIA_LOCATION_NOT_FOUND', message, undefined)
  // An empty library (before 3C-5 E: no V2 files) has no place.
  const empty = officialReader(indexReadModel(readModelOf(emptyFormalState(), { origin: 'local' })))
  assertV2Error(() => uploadTargetOf(empty, { countryId: iceland.id, cityId: reykjavik.id }), 'E_MEDIA_LOCATION_NOT_FOUND', message)
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

test('上传 · 文件夹能不能用（第 2D 批）：不存在 → 新建并写入；已指向这个地点 → 直接用；手放的（没有 place.json）→ 跳过；指向别的地点或内容无效 → 被占用', () => {
  assert.equal(inboxFolderDecision('city-1', { exists: false }), 'claim')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: undefined }), 'skip', '手放的文件夹（没有 place.json）不认领')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: { placeId: ' city-1 ' } }), 'mine')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: { placeId: 'city-1', note: 'x' } }), 'mine')
  assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: { placeId: 'city-2' } }), 'taken')
  for (const invalid of [null, {}, { placeId: '' }, 'city-1', []]) {
    assert.equal(inboxFolderDecision('city-1', { exists: true, placeConfig: invalid }), 'taken', JSON.stringify(invalid))
  }
})

test('上传 · 同名地点的文件夹名：显示名被别的地点占用时用 <显示名> (<地点 id 最后 8 位>)；这个也被占用时依次加数字（第 2D 批）', () => {
  // 先后添加的两个同名城市：UUIDv7 的前 8 位（时间戳高位）相同，最后 8 位不同。
  const first = '019b76da-0001-7000-8000-00000000a1b2'
  const second = '019b76da-0002-7000-8000-00000000c3d4'
  assert.equal(first.slice(0, 8), second.slice(0, 8))
  assert.equal(placeFolderSuffix(first), '0000a1b2')
  assert.equal(placeFolderSuffix(second), '0000c3d4')
  assert.equal(INBOX_FOLDER_CANDIDATE_COUNT, 10)
  assert.deepEqual(inboxFolderCandidates('Springfield', second), [
    'Springfield',
    'Springfield (0000c3d4)',
    'Springfield (0000c3d4) 2',
    'Springfield (0000c3d4) 3',
    'Springfield (0000c3d4) 4',
    'Springfield (0000c3d4) 5',
    'Springfield (0000c3d4) 6',
    'Springfield (0000c3d4) 7',
    'Springfield (0000c3d4) 8',
    'Springfield (0000c3d4) 9',
  ])
  assert.deepEqual(inboxFolderCandidates('Springfield', second), inboxFolderCandidates('Springfield', second), '稳定：同一个地点每次得到同一串候选')

  /** 前几个候选的状态；没给的候选按「不存在」。 */
  const candidates = (states: InboxFolderState[]) => inboxFolderCandidates('Springfield', second).map((name, index) => ({
    name,
    label: `United States/${name}`,
    state: states[index] ?? { exists: false as const },
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
  // 两个都被占用（旧规则在这里报冲突）：新建 <显示名> (<后缀>) 2，上传不因别人的文件夹失败。
  assert.deepEqual(
    pickInboxFolder(second, candidates([{ exists: true, placeConfig: { placeId: first } }, { exists: true, placeConfig: null }])),
    { name: 'Springfield (0000c3d4) 2', claim: true },
  )
  // 下一次上传：前两个仍被占用，带数字的那个已经指向这个地点 → 复用。
  assert.deepEqual(
    pickInboxFolder(second, candidates([
      { exists: true, placeConfig: { placeId: first } },
      { exists: true, placeConfig: null },
      { exists: true, placeConfig: { placeId: second } },
    ])),
    { name: 'Springfield (0000c3d4) 2', claim: false },
  )
  // 数字依次递增：2、3 都被占用 → 4。
  assert.deepEqual(
    pickInboxFolder(second, candidates([
      { exists: true, placeConfig: { placeId: first } },
      { exists: true, placeConfig: { placeId: first } },
      { exists: true, placeConfig: undefined },
      { exists: true, placeConfig: { placeId: 'other' } },
    ])),
    { name: 'Springfield (0000c3d4) 4', claim: true },
  )
})

test('上传 · 选文件夹的顺序（第 2D 批）：手放的文件夹（没有 place.json）不认领，改用下一个；已指向这个地点的优先于新建', () => {
  const placeId = '019b76da-0002-7000-8000-00000000c3d4'
  const names = inboxFolderCandidates('Suzhou', placeId)
  const candidates = (states: InboxFolderState[]) => names.map((name, index) => ({
    name,
    label: `China/${name}`,
    state: states[index] ?? { exists: false as const },
  }))
  const handMade: InboxFolderState = { exists: true, placeConfig: undefined }

  // 显示名的文件夹是手放的，「显示名 (后缀)」不存在 → 用后者，并写入 place.json。
  assert.deepEqual(pickInboxFolder(placeId, candidates([handMade])), { name: 'Suzhou (0000c3d4)', claim: true })
  // 下一次上传：手放的仍然跳过，后者已指向这个地点 → 复用，不写。
  assert.deepEqual(pickInboxFolder(placeId, candidates([handMade, { exists: true, placeConfig: { placeId } }])), { name: 'Suzhou (0000c3d4)', claim: false })
  // 两个候选都是手放的 → 新建 Suzhou (0000c3d4) 2。
  assert.deepEqual(pickInboxFolder(placeId, candidates([handMade, handMade])), { name: 'Suzhou (0000c3d4) 2', claim: true })
  // 手放的文件夹在导入时经确认绑定到这个地点之后（有了 place.json）→ 按「mine」复用最靠前的那个。
  assert.deepEqual(
    pickInboxFolder(placeId, candidates([{ exists: true, placeConfig: { placeId } }, { exists: true, placeConfig: { placeId } }])),
    { name: 'Suzhou', claim: false },
  )
  // 已指向这个地点的文件夹优先于前面不存在的候选：手放的 Suzhou 被移走之后，照片仍进原来的 Suzhou (0000c3d4)，不另开一个。
  assert.deepEqual(pickInboxFolder(placeId, candidates([{ exists: false }, { exists: true, placeConfig: { placeId } }])), { name: 'Suzhou (0000c3d4)', claim: false })

  // 全部候选都不能用（手放的或别的地点的）→ 冲突，什么都不写。
  const allBlocked = names.map((_, index): InboxFolderState => (index % 2 === 0 ? handMade : { exists: true, placeConfig: { placeId: 'other' } }))
  assertV2Error(
    () => pickInboxFolder(placeId, candidates(allBlocked)),
    'E_MEDIA_FOLDER_CONFLICT',
    `投递箱文件夹 ${names.map((name) => `China/${name}`).join('、')} 都不能使用：它们是没有 place.json 的手放文件夹，或 place.json 指向别的地点（或内容无效）。未写入文件。请先确认这些文件夹属于哪个地点。`,
    (error) => assert.deepEqual(error.params, { folders: names.map((name) => `China/${name}`), expected: placeId }),
  )
})

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test('删除 · 能删哪些：该城市里已隐藏的照片或全景 / 航拍照片；id 去重保序（文案同旧）', () => {
  const files = contentFiles()
  const reykjavik = placeNamed(files, 'Reykjavik', 'city').id
  const torshavn = placeNamed(files, 'Torshavn', 'city').id
  const reader = readerOf(files)
  const photos = deletableMediaOf(reader, { cityId: reykjavik, ids: [ID.p2, ID.p2] })
  assert.equal(photos.cityId, reykjavik)
  assert.deepEqual(photos.ids, [ID.p2])
  assert.deepEqual(photos.items.map((item) => item.id), [ID.p2])
  assert.deepEqual(deletableMediaOf(reader, { cityId: ` ${torshavn} `, ids: [ID.d1] }).ids, [ID.d1])

  for (const input of [undefined, {}, { cityId: reykjavik, ids: [] }, { cityId: '', ids: [ID.p2] }, { cityId: reykjavik, ids: 'x' }]) {
    assertV2Error(() => deletableMediaOf(reader, input), 'E_MEDIA_DELETE_EMPTY', '没有可删除的隐藏媒体。')
  }
  const notHidden = '只能彻底删除当前城市中已经隐藏的照片或无人机影像。'
  assertV2Error(() => deletableMediaOf(reader, { cityId: reykjavik, ids: [ID.p1] }), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden, (error) => assert.equal(error.params?.id, ID.p1))
  assertV2Error(() => deletableMediaOf(reader, { cityId: torshavn, ids: [ID.p2] }), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden)
  assertV2Error(() => deletableMediaOf(reader, { cityId: torshavn, ids: [ID.v1] }), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden, (error) => assert.equal(error.params?.id, ID.v1))
  assertV2Error(() => deletableMediaOf(reader, { cityId: reykjavik, ids: [ID.p2, 'ghost'] }), 'E_MEDIA_DELETE_NOT_HIDDEN', notHidden)
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
