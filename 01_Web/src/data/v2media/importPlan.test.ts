/**
 * V2 媒体导入纯函数（v2media/importPlan.ts）的单元测试（RFC-LOC-1 PR3b-3 规格 §2.1–§2.3、§3「内容寻址」「解析」）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 地点注册表是手写的中性数据（冰岛、法罗群岛与两个同名的「刚果」）。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { CanonicalPlace } from '../canonical/types.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import {
  buildMediaItem,
  catalogIntegrityProblems,
  contentHashOf,
  createMediaPlaceIndex,
  droneKindOf,
  generatedDirectoryOfSrc,
  generatedFilesOf,
  markCovers,
  mediaCatalogFileOf,
  mediaIdOf,
  mediaSourceIndexFileOf,
  metadataForFile,
  normalizeName,
  placeConfigOf,
  placeDisplayName,
  resolveCityFolder,
  resolveCountryFolder,
  resolveFileOverride,
  sourcesByIdOf,
  uniqueById,
  type MediaFileFacts,
  type PlaceLookup,
  type V2MediaCatalogItem,
} from './importPlan.ts'

const newId = sequentialUuids(Date.UTC(2026, 8, 29))
const ids = {
  iceland: newId(),
  reykjavik: newId(),
  vik: newId(),
  hofnEn: newId(),
  hofnZh: newId(),
  faroe: newId(),
  torshavn: newId(),
  congoA: newId(),
  congoB: newId(),
}

const PLACES: CanonicalPlace[] = [
  { id: ids.iceland, subtype: 'country', names: { 'zh-Hans': '冰岛', en: 'Iceland' }, externalIds: { iso3166Alpha2: 'IS' }, legacyKeys: ['country:iceland'] },
  { id: ids.reykjavik, subtype: 'city', names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }, partOf: ids.iceland, legacyKeys: ['city:iceland__reykjavik'] },
  { id: ids.vik, subtype: 'city', names: { 'zh-Hans': '维克', en: 'Vík' }, partOf: ids.iceland, legacyKeys: ['city:iceland__vik'] },
  // 两个城市的名称规范化后相同（Höfn / Hofn）：按文件夹名解析时有歧义。
  { id: ids.hofnEn, subtype: 'city', names: { en: 'Höfn' }, partOf: ids.iceland },
  { id: ids.hofnZh, subtype: 'city', names: { 'zh-Hans': 'Hofn' }, partOf: ids.iceland },
  { id: ids.faroe, subtype: 'country', names: { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' }, externalIds: { iso3166Alpha2: 'FO' }, legacyKeys: ['country:faroe-islands'] },
  { id: ids.torshavn, subtype: 'city', names: { 'zh-Hans': '托尔斯港', en: 'Tórshavn' }, partOf: ids.faroe, legacyKeys: ['city:faroe-islands__torshavn'] },
  // 两个英文名相同的国家：按文件夹名解析时有歧义。
  { id: ids.congoA, subtype: 'country', names: { en: 'Congo' }, externalIds: { iso3166Alpha2: 'CG' } },
  { id: ids.congoB, subtype: 'country', names: { en: 'Congo' }, externalIds: { iso3166Alpha2: 'CD' } },
]

const index = createMediaPlaceIndex(PLACES)
const place = (id: string) => PLACES.find((candidate) => candidate.id === id) as CanonicalPlace
const iceland = place(ids.iceland)
const faroe = place(ids.faroe)

const assertFound = (lookup: PlaceLookup, id: string, message?: string) => {
  assert.equal(lookup.ok, true, lookup.ok ? message : `${message ?? ''} ${lookup.error}`)
  if (lookup.ok) assert.equal(lookup.place.id, id, message)
}

const assertFailed = (lookup: PlaceLookup, error: string, message?: string) => {
  assert.equal(lookup.ok, false, `${message ?? ''} 应当失败：${error}`)
  if (!lookup.ok) assert.equal(lookup.error, error, message)
}

const HASH_A = contentHashOf('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
const HASH_B = contentHashOf('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')

const photoFacts = (overrides: Partial<MediaFileFacts> = {}): MediaFileFacts => ({
  hash: HASH_A,
  extension: '.jpg',
  kind: 'photo',
  placeId: ids.reykjavik,
  originalFileName: 'harbour.jpg',
  dimensions: { width: 4000, height: 3000 },
  ...overrides,
})

// ---------------------------------------------------------------------------
// 内容寻址
// ---------------------------------------------------------------------------

test('内容寻址：id 为 media-<sha256 前 16 位>，生成目录为 media/user/<同一哈希>/，不含地名、城市与类型', () => {
  assert.equal(HASH_A, 'a1b2c3d4e5f60718')
  assert.equal(mediaIdOf(HASH_A), 'media-a1b2c3d4e5f60718')
  assert.deepEqual(generatedFilesOf(HASH_A, '.jpg'), {
    directory: 'a1b2c3d4e5f60718',
    original: 'a1b2c3d4e5f60718/original.jpg',
    derivatives: [
      { name: 'thumb.webp', maxEdge: 640, quality: 76, file: 'a1b2c3d4e5f60718/thumb.webp' },
      { name: 'preview.webp', maxEdge: 2400, quality: 84, file: 'a1b2c3d4e5f60718/preview.webp' },
    ],
  })
  assert.equal(contentHashOf('A1B2C3D4E5F60718FFFF'), 'a1b2c3d4e5f60718', '大写的十六进制按小写处理')
  assert.throws(() => contentHashOf('not-a-hash'), TypeError)
  assert.throws(() => mediaIdOf('../etc'), TypeError)
})

test('内容寻址：同一内容换文件名、换城市、换类型，id 与 src 都不变；内容不同则不同', () => {
  const base = buildMediaItem(photoFacts())
  const variants = [
    buildMediaItem(photoFacts({ originalFileName: 'IMG_0001.jpg' })),
    buildMediaItem(photoFacts({ placeId: ids.torshavn })),
    buildMediaItem(photoFacts({ kind: 'aerialPhoto', metadata: { date: '2026-07-01', resolution: '4000 × 3000' } })),
    buildMediaItem(photoFacts({ kind: 'panorama360', dimensions: { width: 4000, height: 2000 } })),
  ]
  for (const item of variants) {
    assert.equal(item.id, base.id)
    assert.equal(item.src, base.src)
    assert.equal(item.variants?.thumb?.src, base.variants?.thumb?.src)
    assert.equal(item.variants?.preview?.src, base.variants?.preview?.src)
  }
  assert.equal(base.id, 'media-a1b2c3d4e5f60718')
  assert.equal(base.src, '/media/user/a1b2c3d4e5f60718/original.jpg')
  for (const text of [base.id, base.src, JSON.stringify(base.variants)]) {
    for (const name of ['reykjavik', 'iceland', 'photo', 'harbour']) assert.ok(!text.toLowerCase().includes(name), `${text} 不应含 ${name}`)
  }
  const other = buildMediaItem(photoFacts({ hash: HASH_B }))
  assert.notEqual(other.id, base.id)
  assert.notEqual(other.src, base.src)
})

test('内容寻址：sidecar 里显式写的 id 优先（去掉首尾空白），生成路径仍按内容', () => {
  const item = buildMediaItem(photoFacts({ kind: 'aerialPhoto', metadata: { id: '  my-favourite-shot  ' } }))
  assert.equal(item.id, 'my-favourite-shot')
  assert.equal(item.src, '/media/user/a1b2c3d4e5f60718/original.jpg')
  assert.equal(buildMediaItem(photoFacts({ metadata: { id: '   ' } })).id, 'media-a1b2c3d4e5f60718', '空白的 id 不算')
})

test('目录条目（V3 格式）：placeId、title 只写非空值；静态图片三级 variants；无人机缺日期或分辨率为 needsMetadata', () => {
  assert.deepEqual(buildMediaItem(photoFacts()), {
    id: 'media-a1b2c3d4e5f60718',
    kind: 'photo',
    scope: 'city',
    placeId: ids.reykjavik,
    src: '/media/user/a1b2c3d4e5f60718/original.jpg',
    variants: {
      thumb: { src: '/media/user/a1b2c3d4e5f60718/thumb.webp', width: 640, height: 480 },
      preview: { src: '/media/user/a1b2c3d4e5f60718/preview.webp', width: 2400, height: 1800 },
      original: { src: '/media/user/a1b2c3d4e5f60718/original.jpg', width: 4000, height: 3000 },
    },
    width: 4000,
    height: 3000,
    originalFileName: 'harbour.jpg',
    isCover: false,
    status: 'ready',
  })

  const drone = buildMediaItem(photoFacts({
    kind: 'panorama360',
    dimensions: { width: 4000, height: 2000 },
    metadata: {
      titleZh: '港口全景',
      titleEn: '',
      date: '2026-07-01',
      resolution: '4000 × 2000',
      captureType: 'Drone 360 Panorama',
      position: { lat: 64.15, lng: -21.94, altitudeMeters: 120 },
      altitudeMeters: 120,
      countryName: '不会被抄过去',
    },
  }))
  assert.deepEqual(drone.title, { names: { 'zh-Hans': '港口全景' } })
  assert.equal(drone.status, 'ready')
  assert.deepEqual(drone.position, { lat: 64.15, lng: -21.94, altitudeMeters: 120 })
  for (const key of ['countryId', 'cityId', 'countryName', 'cityName', 'titleZh', 'titleEn']) assert.equal(Object.hasOwn(drone, key), false, key)

  const bothTitles = buildMediaItem(photoFacts({ kind: 'aerialPhoto', metadata: { titleZh: '码头', titleEn: 'Pier' } }))
  assert.deepEqual(bothTitles.title, { names: { 'zh-Hans': '码头', en: 'Pier' } })
  assert.equal(bothTitles.status, 'needsMetadata')

  const video = buildMediaItem({ hash: HASH_B, extension: '.mp4', kind: 'video', placeId: ids.vik, originalFileName: 'flight.mp4', metadata: { date: '2026-07-02', resolution: '3840 × 2160' } })
  assert.equal(video.id, 'media-0011223344556677')
  assert.deepEqual(video.variants, { original: { src: '/media/user/0011223344556677/original.mp4' } })
  assert.equal(Object.hasOwn(video, 'width'), false)
  assert.equal(video.status, 'ready')
  assert.throws(() => buildMediaItem(photoFacts({ dimensions: undefined })), TypeError, '静态图片没有宽高时是程序错误')
})

test('generatedDirectoryOfSrc：只认内容寻址的 /media/user/<16 位哈希>/<文件名>', () => {
  assert.equal(generatedDirectoryOfSrc('/media/user/a1b2c3d4e5f60718/original.jpg'), 'a1b2c3d4e5f60718')
  assert.equal(generatedDirectoryOfSrc('\\media\\user\\a1b2c3d4e5f60718\\original.jpg'), 'a1b2c3d4e5f60718', '反斜杠按斜杠处理（同旧删除逻辑）')
  for (const src of [
    '/media/user/iceland/reykjavik/photo/a1b2c3d4e5f60718/original.jpg',
    '/media/user/a1b2c3d4e5f60718',
    '/media/user/A1B2C3D4E5F60718/original.jpg',
    '/media/user/a1b2c3d4e5f6071/original.jpg',
    '/media/user/a1b2c3d4e5f60718/../original.jpg',
    '/media/user/a1b2c3d4e5f60718/..',
    '/other/a1b2c3d4e5f60718/original.jpg',
    undefined,
    42,
  ]) {
    assert.equal(generatedDirectoryOfSrc(src), undefined, String(src))
  }
})

// ---------------------------------------------------------------------------
// 国家文件夹
// ---------------------------------------------------------------------------

test('国家文件夹 · place.json：指向国家地点即通过，并优先于 country.json 与文件夹名', () => {
  assertFound(resolveCountryFolder(index, { folderName: 'whatever', placeConfig: placeConfigOf(ids.iceland) }), ids.iceland)
  assertFound(
    resolveCountryFolder(index, { folderName: 'Faroe Islands', placeConfig: { placeId: ` ${ids.iceland} ` }, countryConfig: { countryId: 'faroe-islands' } }),
    ids.iceland,
    'place.json 优先',
  )
})

test('国家文件夹 · place.json 的错误：格式无效、地点不存在、不是国家', () => {
  for (const config of [null, [], 'x', {}, { placeId: '' }, { placeId: 3 }]) {
    assertFailed(resolveCountryFolder(index, { folderName: 'Iceland', placeConfig: config }), 'Iceland/place.json 格式无效：内容应为 { "placeId": "<地点 id>" }。')
  }
  assertFailed(resolveCountryFolder(index, { folderName: 'Iceland', placeConfig: { placeId: 'nope' } }), 'Iceland/place.json 指定了不存在的地点：nope')
  assertFailed(
    resolveCountryFolder(index, { folderName: 'Iceland', placeConfig: { placeId: ids.reykjavik } }),
    `Iceland/place.json 指定的地点不是国家：${ids.reykjavik}`,
  )
})

test('国家文件夹 · 旧 country.json 的 countryId：经 legacyKeys 解析；找不到时报错；没有 countryId 时按文件夹名', () => {
  assertFound(resolveCountryFolder(index, { folderName: '冰岛照片', countryConfig: { countryId: 'iceland' } }), ids.iceland)
  assertFound(resolveCountryFolder(index, { folderName: 'Iceland', countryConfig: { countryId: 'faroe-islands' } }), ids.faroe, 'country.json 优先于文件夹名')
  assertFailed(resolveCountryFolder(index, { folderName: 'Iceland', countryConfig: { countryId: 'atlantis' } }), 'Iceland/country.json 指定了不存在的 countryId：atlantis')
  assertFailed(
    resolveCountryFolder(index, { folderName: 'Iceland', countryConfig: { countryId: 'iceland__reykjavik' } }),
    'Iceland/country.json 指定了不存在的 countryId：iceland__reykjavik',
    '城市的旧键不算',
  )
  assertFound(resolveCountryFolder(index, { folderName: 'Iceland', countryConfig: {} }), ids.iceland)
  assertFound(resolveCountryFolder(index, { folderName: 'Iceland', countryConfig: { countryId: '' } }), ids.iceland)
})

test('国家文件夹 · 文件夹名：中文名、英文名或 ISO 代码，规范化后相等（大小写、重音、空白与连字符）', () => {
  for (const folderName of ['Iceland', 'ICELAND', '冰岛', 'IS', 'is', ' Iceland ']) {
    assertFound(resolveCountryFolder(index, { folderName }), ids.iceland, folderName)
  }
  for (const folderName of ['Faroe Islands', 'faroe-islands', 'Faroe_Islands', 'FaroeIslands', '法罗群岛', 'FO']) {
    assertFound(resolveCountryFolder(index, { folderName }), ids.faroe, folderName)
  }
})

test('国家文件夹 · 文件夹名的错误：0 个、多个', () => {
  assertFailed(
    resolveCountryFolder(index, { folderName: 'Atlantis' }),
    '找不到国家：Atlantis。目录名需与 StarMap 中的国家中文名、英文名或国家代码一致，或在 place.json 中填写 placeId。',
  )
  assertFailed(resolveCountryFolder(index, { folderName: 'Ice' }), '找不到国家：Ice。目录名需与 StarMap 中的国家中文名、英文名或国家代码一致，或在 place.json 中填写 placeId。', '不做模糊匹配')
  assertFailed(resolveCountryFolder(index, { folderName: '___' }), '找不到国家：___。目录名需与 StarMap 中的国家中文名、英文名或国家代码一致，或在 place.json 中填写 placeId。')
  assertFailed(resolveCountryFolder(index, { folderName: 'Congo' }), '国家目录名称存在歧义：Congo。请在 place.json 中填写 placeId。')
  assertFound(resolveCountryFolder(index, { folderName: 'CD' }), ids.congoB, 'ISO 代码能区分同名国家')
  assertFound(resolveCountryFolder(index, { folderName: 'Congo', placeConfig: placeConfigOf(ids.congoA) }), ids.congoA, 'place.json 消除歧义')
})

// ---------------------------------------------------------------------------
// 城市文件夹
// ---------------------------------------------------------------------------

test('城市文件夹 · place.json：必须是城市，且属于所在国家文件夹解析出的国家', () => {
  assertFound(resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'anything', placeConfig: placeConfigOf(ids.vik) }), ids.vik)
  assertFound(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Reykjavik', placeConfig: placeConfigOf(ids.vik) }),
    ids.vik,
    'place.json 优先于文件夹名',
  )
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Reykjavik', placeConfig: placeConfigOf(ids.iceland) }),
    `Iceland/Reykjavik/place.json 指定的地点不是城市：${ids.iceland}`,
  )
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Torshavn', placeConfig: placeConfigOf(ids.torshavn) }),
    `Iceland/Torshavn/place.json 指定的城市不属于 Iceland：${ids.torshavn}`,
  )
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: '冰岛', folderName: 'Reykjavik', placeConfig: { placeId: 'ghost' } }),
    '冰岛/Reykjavik/place.json 指定了不存在的地点：ghost',
  )
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Reykjavik', placeConfig: { id: ids.reykjavik } }),
    'Iceland/Reykjavik/place.json 格式无效：内容应为 { "placeId": "<地点 id>" }。',
  )
})

test('城市文件夹 · 文件夹名：只在该国家的城市里，与中英文名规范化后比对', () => {
  for (const folderName of ['Reykjavik', 'reykjavik', '雷克雅未克', 'REYKJAVIK']) {
    assertFound(resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName }), ids.reykjavik, folderName)
  }
  for (const folderName of ['Vík', 'Vik', 'VIK', '维克']) {
    assertFound(resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName }), ids.vik, folderName)
  }
  assertFound(resolveCityFolder(index, faroe, { countryFolderName: 'Faroe Islands', folderName: 'Torshavn' }), ids.torshavn)
})

test('城市文件夹 · 文件夹名的错误：0 个（包括别国的城市）、多个', () => {
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Akureyri' }),
    '在 Iceland 中找不到城市：Akureyri。请先在 StarMap 中添加这个城市。',
  )
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Torshavn' }),
    '在 Iceland 中找不到城市：Torshavn。请先在 StarMap 中添加这个城市。',
  )
  assertFailed(
    resolveCityFolder(index, iceland, { countryFolderName: 'Iceland', folderName: 'Hofn' }),
    'Iceland 内的城市目录名称存在歧义：Hofn。请在 place.json 中填写 placeId。',
  )
})

// ---------------------------------------------------------------------------
// 逐文件覆盖
// ---------------------------------------------------------------------------

test('逐文件覆盖：没有覆盖时归属城市文件夹；placeId；旧的 countryId + cityId 经 legacyKeys；两者一致也可以', () => {
  const reykjavik = place(ids.reykjavik)
  assertFound(resolveFileOverride(index, reykjavik, {}, 'Iceland/Reykjavik/drone/a.jpg'), ids.reykjavik)
  assertFound(resolveFileOverride(index, reykjavik, { kind: 'aerialPhoto', placeId: '  ' }, 'x'), ids.reykjavik, '空白不算覆盖')
  assertFound(resolveFileOverride(index, reykjavik, { placeId: ids.torshavn }, 'x'), ids.torshavn)
  assertFound(resolveFileOverride(index, reykjavik, { countryId: 'iceland', cityId: 'iceland__vik' }, 'x'), ids.vik)
  assertFound(resolveFileOverride(index, reykjavik, { placeId: ids.vik, countryId: 'iceland', cityId: 'iceland__vik' }, 'x'), ids.vik)
})

test('逐文件覆盖的错误：placeId 不是城市、旧字段不成对、旧键不存在或不属于该国、两种都有且不一致', () => {
  const reykjavik = place(ids.reykjavik)
  const rel = 'Iceland/Reykjavik/drone/a.jpg'
  assertFailed(resolveFileOverride(index, reykjavik, { placeId: ids.iceland }, rel), `${rel} 的 placeId 不是 StarMap 中的城市：${ids.iceland}`)
  assertFailed(resolveFileOverride(index, reykjavik, { placeId: 'ghost' }, rel), `${rel} 的 placeId 不是 StarMap 中的城市：ghost`)
  assertFailed(resolveFileOverride(index, reykjavik, { countryId: 'iceland' }, rel), `${rel} 的归属覆盖必须同时填写 countryId 和 cityId。`)
  assertFailed(resolveFileOverride(index, reykjavik, { cityId: 'iceland__vik' }, rel), `${rel} 的归属覆盖必须同时填写 countryId 和 cityId。`)
  assertFailed(resolveFileOverride(index, reykjavik, { countryId: 'atlantis', cityId: 'iceland__vik' }, rel), `${rel} 指定了不存在的 countryId：atlantis`)
  assertFailed(
    resolveFileOverride(index, reykjavik, { countryId: 'iceland', cityId: 'faroe-islands__torshavn' }, rel),
    `${rel} 指定了不属于 Iceland 的 cityId：faroe-islands__torshavn`,
  )
  assertFailed(
    resolveFileOverride(index, reykjavik, { placeId: ids.torshavn, countryId: 'iceland', cityId: 'iceland__vik' }, rel),
    `${rel} 的 placeId 与 countryId / cityId 指向不同的城市，请只保留一种。`,
  )
})

test('legacyKeys 属于不止一个地点时（注册表本身不合法）按歧义报错，不任选一个', () => {
  const broken = createMediaPlaceIndex([
    ...PLACES,
    { id: newId(), subtype: 'country', names: { en: 'Iceland copy' }, externalIds: { iso3166Alpha2: 'IS' }, legacyKeys: ['country:iceland'] },
  ])
  assertFailed(
    resolveCountryFolder(broken, { folderName: 'x', countryConfig: { countryId: 'iceland' } }),
    'x/country.json 的 countryId 对应了不止一个国家：iceland。请改用 place.json 填写 placeId。',
  )
})

// ---------------------------------------------------------------------------
// 其余小件
// ---------------------------------------------------------------------------

test('normalizeName 与旧导入器相同：Unicode 组合形式、拉丁重音、大小写、空白、下划线与连字符', () => {
  const composed = 'São Miguel'
  const decomposed = 'Sa' + String.fromCharCode(0x0303) + 'o Miguel'
  assert.notEqual(composed, decomposed)
  assert.equal(normalizeName(composed), 'saomiguel')
  assert.equal(normalizeName(decomposed), 'saomiguel')
  assert.equal(normalizeName('Sao_Miguel'), 'saomiguel')
  assert.equal(normalizeName(undefined), '')
  assert.equal(placeDisplayName(place(ids.hofnZh)), 'Hofn', '没有英文名时用中文名')
  assert.equal(placeDisplayName(iceland), 'Iceland')
})

test('无人机类型与 sidecar 条目（照抄旧导入器）', () => {
  assert.deepEqual(droneKindOf('a.mp4', '.mp4', {}), { kind: 'video', unlabelled: false })
  assert.deepEqual(droneKindOf('a.jpg', '.jpg', { kind: '全景' }), { kind: 'panorama360', unlabelled: false })
  assert.deepEqual(droneKindOf('a.jpg', '.jpg', { type: 'aerial-photo' }), { kind: 'aerialPhoto', unlabelled: false })
  assert.deepEqual(droneKindOf('bay-360.jpg', '.jpg', {}), { kind: 'panorama360', unlabelled: false })
  assert.deepEqual(droneKindOf('bay.jpg', '.jpg', {}), { kind: 'aerialPhoto', unlabelled: true })
  const sidecar = { 'drone/a.jpg': { kind: 'aerialPhoto' }, 'b.jpg': { kind: 'panorama360' }, 'drone/c.jpg': 'bad' }
  assert.deepEqual(metadataForFile(sidecar, 'drone/a.jpg', 'a.jpg'), { kind: 'aerialPhoto' })
  assert.deepEqual(metadataForFile(sidecar, 'drone/b.jpg', 'b.jpg'), { kind: 'panorama360' })
  assert.deepEqual(metadataForFile(sidecar, 'drone/c.jpg', 'c.jpg'), {})
  assert.deepEqual(metadataForFile(null, 'drone/a.jpg', 'a.jpg'), {})
})

const catalogItem = (overrides: Partial<V2MediaCatalogItem>): V2MediaCatalogItem => ({
  ...buildMediaItem(photoFacts()),
  ...overrides,
})

test('封面按 placeId 分组：文件名以 cover 开头的优先，其余按文件名；只在普通照片里选；不改变顺序', () => {
  const items = [
    catalogItem({ id: 'a', originalFileName: 'b.jpg' }),
    catalogItem({ id: 'b', originalFileName: 'a.jpg' }),
    catalogItem({ id: 'c', originalFileName: 'Cover-harbour.jpg' }),
    catalogItem({ id: 'd', originalFileName: 'a.jpg', placeId: ids.vik }),
    catalogItem({ id: 'e', originalFileName: '0.jpg', placeId: ids.vik, kind: 'aerialPhoto' }),
    catalogItem({ id: 'f', originalFileName: 'coverage.jpg', placeId: ids.torshavn }),
    catalogItem({ id: 'g', originalFileName: 'b.jpg', placeId: ids.torshavn, isCover: true }),
  ]
  const marked = markCovers(items)
  assert.deepEqual(marked.map((item) => item.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.deepEqual(marked.filter((item) => item.isCover).map((item) => item.id), ['c', 'd', 'g'])
  assert.equal(items[6].isCover, true, '输入不被修改')
  assert.equal(items[2].isCover, false)
})

test('去重与源文件索引：同一 id 只留一条（位置取第一次、值取最后一次）；索引收齐全部源路径', () => {
  const planned = [
    { id: 'media-1', sourcePath: 'Iceland/Reykjavik/photos/a.jpg', value: 1 },
    { id: 'media-2', sourcePath: 'Iceland/Reykjavik/photos/b.jpg', value: 2 },
    { id: 'media-1', sourcePath: 'Faroe Islands/Torshavn/photos/a-copy.jpg', value: 3 },
    { id: 'media-1', sourcePath: 'Iceland/Reykjavik/photos/a.jpg', value: 4 },
  ]
  assert.deepEqual(uniqueById(planned).map((item) => [item.id, item.value]), [['media-1', 4], ['media-2', 2]])
  assert.deepEqual(sourcesByIdOf(planned), {
    'media-1': ['Iceland/Reykjavik/photos/a.jpg', 'Faroe Islands/Torshavn/photos/a-copy.jpg'],
    'media-2': ['Iceland/Reykjavik/photos/b.jpg'],
  })
  assert.deepEqual(mediaCatalogFileOf([], 'T'), { schemaVersion: 3, generatedAt: 'T', privacyLevel: 'local-only', items: [] })
  assert.deepEqual(mediaSourceIndexFileOf({}, 'T'), { schemaVersion: 1, generatedAt: 'T', sourcesById: {} })
})

test('写目录前的完整性检查：每个条目的 placeId 都必须是注册表里的城市', () => {
  const now = new Date(Date.UTC(2026, 8, 29))
  const files = { places: { schema_version: 1, generated_at: 'T', places: PLACES } }
  const good = mediaCatalogFileOf([catalogItem({}), catalogItem({ id: 'b', placeId: ids.torshavn })], 'T')
  assert.deepEqual(catalogIntegrityProblems(files, good, now), [])
  const toCountry = mediaCatalogFileOf([catalogItem({ placeId: ids.iceland })], 'T')
  assert.deepEqual(catalogIntegrityProblems(files, toCountry, now), ['media $.items[0].placeId：必须指向一个城市地点'])
  const toNowhere = mediaCatalogFileOf([catalogItem({ placeId: 'ghost' })], 'T')
  assert.deepEqual(catalogIntegrityProblems(files, toNowhere, now), ['media $.items[0].placeId：引用的地点不存在'])
  assert.deepEqual(catalogIntegrityProblems(undefined, mediaCatalogFileOf([catalogItem({})], 'T'), now), ['media $.items[0].placeId：引用的地点不存在'], '全新目录没有地点')
})
