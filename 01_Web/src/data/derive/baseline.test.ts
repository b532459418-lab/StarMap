/**
 * buildBaseline / stableStringify 的单元测试（RFC-LOC-1 PR1 §3.2、§3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 这里的输入是手写的「六个模块导出」形状（travel 部分复用 Core 的 travel.fixture.ts，
 * 快照用 Core 适配器现算），不依赖派生层，所以本文件可以早于派生层存在。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { City, TravelMapRecord } from '../../types/travel.ts'
import { plannedRecordsToWorldGraph } from '../../worldgraph/adapters/plannedRecords.ts'
import { sampleCities, sampleCountries, sampleJourneyDays, sampleRoutes } from '../../worldgraph/adapters/travel.fixture.ts'
import { travelToWorldGraph } from '../../worldgraph/adapters/travel.ts'
import { wantToGoToWorldGraph, type WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import { mergeWorldGraphSnapshots } from '../../worldgraph/snapshot.ts'
import {
  baselineExportNames,
  buildBaseline,
  NOW_PLACEHOLDER,
  stableStringify,
  type AppDataExports,
} from './baseline.ts'

const NOW = '2000-01-01T00:00:00.000Z'

type MediaItem = {
  id: string
  kind: string
  cityId: string
  status: string
  src: string
  variants?: Record<string, { src: string }>
  isCover: boolean
}

/** 手写的「六个模块导出」：每个导出都非空，改动任何一处都应当反映到基线里。 */
const makeExports = (now = NOW): AppDataExports => {
  const countries = sampleCountries()
  const cities = sampleCities()
  const journeyDays = sampleJourneyDays()
  const routes = sampleRoutes()
  const cityById = Object.fromEntries(cities.map((city) => [city.id, city]))
  const countryById = Object.fromEntries(countries.map((country) => [country.id, country]))

  const plannedRecords: TravelMapRecord[] = [{
    id: 'planned_bergen',
    country: '挪威',
    country_en: 'Norway',
    country_code: 'no',
    city: '卑尔根',
    city_en: 'Bergen',
    start_date: '2026-07-01',
    status: 'planned',
    lat: 60.3913,
    lng: 5.3221,
  }]

  const mediaItems: MediaItem[] = [
    {
      id: 'photo_a',
      kind: 'photo',
      cityId: cities[0].id,
      status: 'ready',
      src: '/media/user/a.jpg',
      variants: { thumb: { src: '/media/user/a.thumb.jpg' }, original: { src: '/media/user/a.jpg' } },
      isCover: false,
    },
    {
      id: 'aerial_b',
      kind: 'aerialPhoto',
      cityId: 'elsewhere__city',
      status: 'ready',
      src: '/media/user/b.jpg',
      isCover: false,
    },
  ]
  const droneItems = [{ id: 'aerial_b', cityId: 'elsewhere__city', titleEn: 'Drone' }]

  const wantToGoItems: WantToGoItem[] = [
    {
      id: 'wtg_nuuk',
      place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.1814, lng: -51.6941 },
      addedAt: '2026-08-12',
      hidden: false,
    },
    {
      id: 'wtg_iceland',
      place: { kind: 'country', nameZh: '冰岛', nameEn: 'Iceland', countryCode: 'IS' },
      addedAt: '2026-08-13',
      hidden: true,
    },
  ]

  const travelSnapshot = travelToWorldGraph({ countries, cities, journeyDays, routes }, { now })
  const wantToGoSnapshot = wantToGoToWorldGraph(wantToGoItems, { now })
  const plannedSnapshot = plannedRecordsToWorldGraph(plannedRecords, { now, countryCodes: { Norway: 'no' } })

  return {
    travelAtlas: {
      travelAtlasDataSource: 'sample',
      travelAtlasDisplay: { overviewTarget: { lat: 64, lng: -13 } },
      plannedRecords,
      travelAtlasCountryCodes: { Norway: 'no' },
      travelAtlasMeta: { schemaVersion: 1, generatedAt: now, totalRecords: 5 },
      hiddenHomeRecords: [{ id: 'hidden_record' }],
      countries,
      cities,
      journeyDays,
      routes,
      countryById,
      cityById,
      missingCoordinateCities: [cities[1]],
      getCitiesForCountry: (countryId: string) =>
        countryById[countryId]?.cityIds.map((cityId) => cityById[cityId]).filter(Boolean) ?? [],
      shouldHideCityFromNavigation: (city: City) => city.nameEn === 'Vik',
    },
    editorState: {
      travelAtlasEditorState: { schemaVersion: 1, hiddenCityIds: ['iceland__vik'], updatedAt: `edited ${now}` },
    },
    mediaCatalog: {
      allImportedMediaItems: mediaItems,
      importedMediaItems: mediaItems,
      importedDroneMediaCatalogItems: [mediaItems[1]],
      getMediaSource: (item, variant) => {
        const media = item as MediaItem
        return media.variants?.[variant]?.src ?? media.variants?.original?.src ?? media.src
      },
      getCityPhotos: (cityId?: string) => mediaItems.filter((item) => item.kind === 'photo' && item.cityId === cityId),
      getCityCoverPhoto: (cityId?: string) => mediaItems.find((item) => item.kind === 'photo' && item.cityId === cityId),
    },
    droneMedia: {
      droneMediaItems: droneItems,
      droneMediaByCity: { 'elsewhere__city': droneItems },
      droneMediaById: { aerial_b: droneItems[0] },
      getDroneMediaForCity: (cityId?: string) => droneItems.filter((item) => item.cityId === cityId),
      hasDroneMedia: (cityId?: string) => droneItems.some((item) => item.cityId === cityId),
    },
    wantToGo: {
      wantToGoDataSource: 'sample',
      wantToGoItems,
      wantToGoProblems: ['第 3 条想去记录缺少 id，已跳过。'],
      hiddenWantToGoItems: wantToGoItems.filter((item) => item.hidden),
      wantToGoItemByEntityId: new Map([['place:wtg:GL:nuuk', wantToGoItems[0]]]),
      plannedRecordByEntityId: new Map([['place:planned:planned_bergen', plannedRecords[0]]]),
      wantToGoConvertBlockReason: (item: WantToGoItem) => (item.place.kind === 'city' ? undefined : '整个国家'),
      plannedConvertBlockReason: () => undefined,
    },
    worldGraph: {
      worldGraphSessionNow: now,
      travelSnapshot,
      wantToGoSnapshot,
      plannedSnapshot,
      worldGraphSnapshot: mergeWorldGraphSnapshots(travelSnapshot, wantToGoSnapshot, plannedSnapshot),
    },
  }
}

const baselineText = (exports: AppDataExports, now = NOW) => stableStringify(buildBaseline(exports, { now }))

/** 把任意值改成「不同但形状相近」的值：改第一个叶子，空容器就加一项；函数则改它的返回值。 */
const mutate = (value: unknown): unknown => {
  if (typeof value === 'string') return `${value}·changed`
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  if (value === undefined || value === null) return 'changed'
  if (typeof value === 'function') {
    return (...args: unknown[]) => mutate((value as (...inner: unknown[]) => unknown)(...args))
  }
  if (value instanceof Map) {
    if (value.size === 0) return new Map([['changed', 'changed']])
    const [[firstKey, firstValue], ...rest] = [...value]
    return new Map([[firstKey, mutate(firstValue)], ...rest])
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? ['changed'] : [mutate(value[0]), ...value.slice(1)]
  }
  const record = value as Record<string, unknown>
  const [firstKey] = Object.keys(record)
  return firstKey === undefined ? { changed: true } : { ...record, [firstKey]: mutate(record[firstKey]) }
}

test('同一输入两次 buildBaseline 字节相同', () => {
  const first = baselineText(makeExports())
  const second = baselineText(makeExports())
  assert.equal(first, second)
  assert.ok(first.length > 1000, '基线不应是空壳')
})

test('buildBaseline 不修改输入', () => {
  const exports = makeExports()
  const before = JSON.stringify(exports.travelAtlas.cities)
  buildBaseline(exports, { now: NOW })
  assert.equal(JSON.stringify(exports.travelAtlas.cities), before)
})

test('恰好等于 now 的字符串替换为 <now>，包含 now 的字符串保持原样', () => {
  const text = baselineText(makeExports())
  const baseline = JSON.parse(text)
  assert.equal(baseline.modules.worldGraph.worldGraphSessionNow, NOW_PLACEHOLDER)
  assert.equal(baseline.modules.travelAtlas.travelAtlasMeta.generatedAt, NOW_PLACEHOLDER)
  assert.equal(baseline.modules.editorState.travelAtlasEditorState.updatedAt, `edited ${NOW}`)
  // 快照里的 createdAt / updatedAt 也被替换：除了上面那条包含 now 的字符串，全文不再出现 now。
  assert.equal(text.split(NOW).length - 1, 1)
})

test('不同的 now 只要各自注入，基线相同', () => {
  const other = '2031-05-06T07:08:09.010Z'
  assert.equal(
    baselineText(makeExports(NOW), NOW).replace(`edited ${NOW}`, ''),
    baselineText(makeExports(other), other).replace(`edited ${other}`, ''),
  )
})

test('改动任何一个被覆盖的导出，基线都随之改变', () => {
  const original = baselineText(makeExports())
  for (const [moduleName, names] of Object.entries(baselineExportNames)) {
    for (const name of [...names.data, ...names.evaluated]) {
      const exports = makeExports() as unknown as Record<string, Record<string, unknown>>
      exports[moduleName] = { ...exports[moduleName], [name]: mutate(exports[moduleName][name]) }
      const changed = baselineText(exports as unknown as AppDataExports)
      assert.notEqual(changed, original, `${moduleName}.${name} 改动后基线没有变化`)
    }
  }
})

test('缺少任何一个数据导出时直接报错', () => {
  const exports = makeExports() as unknown as Record<string, Record<string, unknown>>
  const { countryById: _omitted, ...travelAtlas } = exports.travelAtlas
  void _omitted
  exports.travelAtlas = travelAtlas
  assert.throws(() => buildBaseline(exports as unknown as AppDataExports, { now: NOW }), /travelAtlas 缺少导出 countryById/)
})

test('module namespace 之类多出的导出被忽略', () => {
  const exports = makeExports()
  const withExtras = {
    ...exports,
    editorState: { ...exports.editorState, orderBySavedIds: () => [], localEditorAvailable: true },
  }
  assert.equal(baselineText(withExtras), baselineText(exports))
})

test('Map 转成按插入顺序的 [key, value] 数组，函数按定义域求值', () => {
  const baseline = JSON.parse(baselineText(makeExports()))
  assert.deepEqual(baseline.modules.wantToGo.wantToGoItemByEntityId.map(([key]: [string]) => key), ['place:wtg:GL:nuuk'])
  assert.deepEqual(baseline.modules.wantToGo.wantToGoConvertBlockReason, [['wtg_nuuk', null], ['wtg_iceland', '整个国家']])
  assert.deepEqual(baseline.modules.mediaCatalog.getMediaSource[0], [
    'photo_a',
    { thumb: '/media/user/a.thumb.jpg', preview: '/media/user/a.jpg', original: '/media/user/a.jpg' },
  ])
  // 城市级函数的定义域 = 足迹城市 ∪ 媒体引用的城市，按首次出现顺序。
  const domain = baseline.modules.droneMedia.hasDroneMedia.map(([cityId]: [string]) => cityId)
  assert.deepEqual(domain, [...sampleCities().map((city) => city.id), 'elsewhere__city'])
  assert.deepEqual(baseline.modules.droneMedia.hasDroneMedia.at(-1), ['elsewhere__city', true])
  assert.deepEqual(
    baseline.queries.visiblePlaces.map(({ name, visibleLayerIds }: { name: string; visibleLayerIds: string[] }) => [name, visibleLayerIds]),
    [['travel+want_to_go', ['travel', 'want_to_go']], ['travel', ['travel']], ['want_to_go', ['want_to_go']], ['none', []]],
  )
  assert.ok(Array.isArray(baseline.queries.collection.want_to_go))
})

test('stableStringify：对象键排序、数组保序、两空格缩进，与 JSON.stringify 的格式一致', () => {
  const value = { b: [3, 1, { d: 1, c: undefined }], a: 'x', 10: true, 9: null }
  const text = stableStringify(value)
  assert.equal(text, [
    '{',
    '  "10": true,',
    '  "9": null,',
    '  "a": "x",',
    '  "b": [',
    '    3,',
    '    1,',
    '    {',
    '      "d": 1',
    '    }',
    '  ]',
    '}',
  ].join('\n'))
  // 键已按字符串排序的输入上，与 JSON.stringify(…, null, 2) 逐字相同。
  const sorted = { a: [1, 'two', [], {}], b: { c: -0, d: Number.NaN, e: [undefined] }, f: '中文\n"引号"' }
  assert.equal(stableStringify(sorted), JSON.stringify(sorted, null, 2))
})

test('stableStringify 拒绝没转换的 Map / Set', () => {
  assert.throws(() => stableStringify({ table: new Map() }), /Map \/ Set/)
  assert.throws(() => stableStringify([new Set()]), /Map \/ Set/)
})
