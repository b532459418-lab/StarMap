/**
 * 媒体目录与无人机媒体纯派生（derive/mediaCatalog.ts、derive/droneMedia.ts）的单元测试
 * （RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveDroneMedia } from './droneMedia.ts'
import { emptyEditorState, type TravelAtlasEditorState } from './editorState.ts'
import { deriveMediaCatalog, getMediaSource, type ImportedMediaCatalogItem } from './mediaCatalog.ts'

const editor = (overrides: Partial<TravelAtlasEditorState> = {}): TravelAtlasEditorState => ({
  ...emptyEditorState,
  ...overrides,
})

const media = (id: string, overrides: Partial<ImportedMediaCatalogItem> = {}): ImportedMediaCatalogItem => ({
  id,
  kind: 'photo',
  scope: 'city',
  countryId: 'norway',
  countryName: 'Norway',
  cityId: 'norway__bergen',
  cityName: 'Bergen',
  src: `/media/user/${id}.jpg`,
  originalFileName: `${id}.jpg`,
  isCover: false,
  status: 'ready',
  ...overrides,
})

const catalog = (items: ImportedMediaCatalogItem[], schemaVersion = 2) => ({ schemaVersion, items })

// ---------------------------------------------------------------------------
// 目录解析与隐藏
// ---------------------------------------------------------------------------

test('只认 schemaVersion 1 / 2 且 items 是数组的目录，否则为空', () => {
  const items = [media('a')]
  assert.deepEqual(deriveMediaCatalog(catalog(items, 1), emptyEditorState).allImportedMediaItems, items)
  assert.deepEqual(deriveMediaCatalog(catalog(items, 2), emptyEditorState).allImportedMediaItems, items)
  assert.deepEqual(deriveMediaCatalog(catalog(items, 3), emptyEditorState).allImportedMediaItems, [])
  assert.deepEqual(deriveMediaCatalog({ schemaVersion: 2, items: {} }, emptyEditorState).allImportedMediaItems, [])
  assert.deepEqual(deriveMediaCatalog(undefined, emptyEditorState).allImportedMediaItems, [])
  // 条目本身不做校验，原样放行。
  assert.equal(deriveMediaCatalog(catalog(items), emptyEditorState).allImportedMediaItems, items)
})

test('hiddenMediaIds 与 hiddenDroneMediaIds 都从 importedMediaItems 里去掉，allImportedMediaItems 不受影响', () => {
  const items = [media('a'), media('b'), media('c', { kind: 'aerialPhoto' })]
  const derived = deriveMediaCatalog(catalog(items), editor({ hiddenMediaIds: ['a'], hiddenDroneMediaIds: ['c'] }))
  assert.deepEqual(derived.allImportedMediaItems.map((item) => item.id), ['a', 'b', 'c'])
  assert.deepEqual(derived.importedMediaItems.map((item) => item.id), ['b'])
})

test('getMediaSource：所需 variant → original variant → 条目 src', () => {
  const item = media('a', { variants: { thumb: { src: '/t.jpg' }, original: { src: '/o.jpg' } } })
  assert.equal(getMediaSource(item, 'thumb'), '/t.jpg')
  assert.equal(getMediaSource(item, 'preview'), '/o.jpg')
  assert.equal(getMediaSource(item, 'original'), '/o.jpg')
  assert.equal(getMediaSource(media('b'), 'preview'), '/media/user/b.jpg')
})

// ---------------------------------------------------------------------------
// 城市照片与封面
// ---------------------------------------------------------------------------

test('getCityPhotos：只取该城市 ready 的 photo，按 mediaOrderByCity 排序；没有城市 id 时为空', () => {
  const items = [
    media('p1'),
    media('p2'),
    media('p3'),
    media('draft', { status: 'needsMetadata' }),
    media('pano', { kind: 'panorama360' }),
    media('elsewhere', { cityId: 'norway__oslo' }),
  ]
  const derived = deriveMediaCatalog(catalog(items), editor({ mediaOrderByCity: { norway__bergen: ['p3', 'p1'] } }))
  assert.deepEqual(derived.getCityPhotos('norway__bergen').map((item) => item.id), ['p3', 'p1', 'p2'])
  assert.deepEqual(derived.getCityPhotos('norway__oslo').map((item) => item.id), ['elsewhere'])
  assert.deepEqual(derived.getCityPhotos(undefined), [])
  assert.deepEqual(derived.getCityPhotos(''), [])
})

test('getCityCoverPhoto：保存的封面 > isCover > 排序后的第一张；被隐藏的封面不算', () => {
  const items = [media('p1'), media('p2', { isCover: true }), media('p3')]
  const byCity = (cover: Record<string, string>, hidden: string[] = []) =>
    deriveMediaCatalog(catalog(items), editor({ coverMediaByCity: cover, hiddenMediaIds: hidden, mediaOrderByCity: { norway__bergen: ['p3'] } }))

  assert.equal(byCity({ norway__bergen: 'p1' }).getCityCoverPhoto('norway__bergen')?.id, 'p1')
  assert.equal(byCity({}).getCityCoverPhoto('norway__bergen')?.id, 'p2')
  assert.equal(byCity({ norway__bergen: 'p1' }, ['p1', 'p2']).getCityCoverPhoto('norway__bergen')?.id, 'p3')
  assert.equal(byCity({}).getCityCoverPhoto('norway__oslo'), undefined)
  assert.equal(byCity({}).getCityCoverPhoto(undefined), undefined)
})

// ---------------------------------------------------------------------------
// 无人机媒体
// ---------------------------------------------------------------------------

const droneItems = () => [
  media('d1', { kind: 'aerialPhoto', date: '2025-06-01', resolution: '4000x3000' }),
  media('photo', { date: '2025-06-01', resolution: '4000x3000' }),
  media('d2', { kind: 'panorama360', date: '2025-06-02', resolution: '8000x4000', cityId: 'norway__oslo', cityName: 'Oslo' }),
  media('d3', { kind: 'panorama360', date: '2025-06-03', resolution: '8000x4000' }),
  media('no-date', { kind: 'aerialPhoto', resolution: '4000x3000' }),
  media('no-resolution', { kind: 'aerialPhoto', date: '2025-06-01' }),
  media('draft', { kind: 'aerialPhoto', date: '2025-06-01', resolution: '4000x3000', status: 'needsMetadata' }),
  media('hidden', { kind: 'aerialPhoto', date: '2025-06-01', resolution: '4000x3000' }),
]

test('importedDroneMediaCatalogItems：只取 ready、有城市 / 日期 / 分辨率的 360 与航拍；按城市首次出现分组，组内按 droneOrderByCity', () => {
  const derived = deriveMediaCatalog(catalog(droneItems()), editor({
    hiddenDroneMediaIds: ['hidden'],
    droneOrderByCity: { norway__bergen: ['d3'] },
  }))
  assert.deepEqual(derived.importedDroneMediaCatalogItems.map((item) => item.id), ['d3', 'd1', 'd2'])
})

test('deriveDroneMedia：字段映射与回落、按城市与 id 的索引', () => {
  const derived = deriveMediaCatalog(catalog([
    ...droneItems(),
    media('titled', {
      kind: 'aerialPhoto',
      date: '2025-06-04',
      resolution: '4000x3000',
      titleZh: '港口',
      captureType: 'Custom',
      position: { lat: 60.1, lng: 5.1, altitudeMeters: 120 },
      variants: { preview: { src: '/p.jpg' }, original: { src: '/o.jpg' } },
    }),
  ]), editor({ hiddenDroneMediaIds: ['hidden'] }))
  const drone = deriveDroneMedia(derived.importedDroneMediaCatalogItems)

  assert.deepEqual(drone.droneMediaItems.map((item) => item.id), ['d1', 'd3', 'titled', 'd2'])
  assert.deepEqual(drone.droneMediaById.titled, {
    id: 'titled',
    cityId: 'norway__bergen',
    type: 'aerialPhoto',
    titleZh: '港口',
    titleEn: '港口',
    src: '/o.jpg',
    previewSrc: '/p.jpg',
    thumbSrc: '/o.jpg',
    date: '2025-06-04',
    resolution: '4000x3000',
    captureType: 'Custom',
    fileName: 'titled.jpg',
    city: 'Bergen',
    country: 'Norway',
    description: undefined,
    altitudeMeters: 120,
    relativeAltitudeMeters: undefined,
    position: { lat: 60.1, lng: 5.1, altitudeMeters: 120 },
  })
  // 没有标题时回落到城市名；没有 captureType 时按种类给默认值。
  assert.deepEqual(
    [drone.droneMediaById.d1.titleZh, drone.droneMediaById.d1.titleEn, drone.droneMediaById.d1.captureType],
    ['Bergen', 'Bergen', 'Aerial Photo'],
  )
  assert.equal(drone.droneMediaById.d2.captureType, 'Drone 360 Panorama')
  assert.deepEqual(Object.keys(drone.droneMediaByCity), ['norway__bergen', 'norway__oslo'])
  assert.deepEqual(drone.getDroneMediaForCity('norway__oslo').map((item) => item.id), ['d2'])
  assert.deepEqual(drone.getDroneMediaForCity('norway__tromso'), [])
  assert.deepEqual(drone.getDroneMediaForCity(undefined), [])
  assert.equal(drone.hasDroneMedia('norway__bergen'), true)
  assert.equal(drone.hasDroneMedia('norway__tromso'), false)
})

test('deriveDroneMedia 对输入再筛一次：非无人机种类或缺字段的条目被丢弃', () => {
  const drone = deriveDroneMedia([
    media('photo', { date: '2025-06-01', resolution: '1x1' }),
    media('no-date', { kind: 'aerialPhoto', resolution: '1x1' }),
    media('ok', { kind: 'aerialPhoto', date: '2025-06-01', resolution: '1x1', cityName: '' }),
  ])
  assert.deepEqual(drone.droneMediaItems.map((item) => [item.id, item.titleEn, item.city]), [['ok', '', '']])
})
