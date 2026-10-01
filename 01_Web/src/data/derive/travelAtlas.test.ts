/**
 * 足迹派生用到的小工具（derive/travelAtlas.ts 的 coordinateForRecord、derive/editorState.ts 的 orderBySavedIds）的单元测试
 * （RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * RFC-LOC-1 PR5b 删除了旧派生 `deriveTravelAtlas` 与按名字推导身份的旧规则，它们的用例随之删除；
 * 足迹派生本身由 ../canonical/derive.test.ts 覆盖（新派生的断言与冻结夹具的基线锁定）。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TravelMapRecord } from '../../types/travel.ts'
import { cityCoordinates, countryCoordinates } from '../geoCoordinates.ts'
import { orderBySavedIds } from './editorState.ts'
import { coordinateForRecord } from './travelAtlas.ts'

const record = (overrides: Partial<TravelMapRecord> & { id: string }): TravelMapRecord => ({
  country: '甲国',
  country_en: 'Alpha',
  city: '一城',
  city_en: 'One',
  start_date: '2025-01-01',
  lat: 1,
  lng: 2,
  ...overrides,
})

// ---------------------------------------------------------------------------
// 坐标回落
// ---------------------------------------------------------------------------

test('coordinateForRecord：记录坐标 > 城市英文名查表 > 城市名查表 > 国家名查表', () => {
  // 内置坐标表今天是空的（见 geoCoordinates.ts），这里临时填几条再清掉，只为覆盖回落路径。
  assert.equal(Object.keys(cityCoordinates).length, 0)
  assert.equal(Object.keys(countryCoordinates).length, 0)
  cityCoordinates['lookup city'] = { lat: 10, lng: 20, approximate: true }
  cityCoordinates['alt name'] = { lat: 11, lng: 21, approximate: true }
  countryCoordinates.beta = { lat: 30, lng: 40, approximate: true }
  try {
    const own = record({ id: 'own', country_en: 'Gamma', country: '丙', city_en: 'Lookup City', lat: 5, lng: 6 })
    const byCityEn = record({ id: 'by-city-en', country_en: 'Gamma', country: '丙', city_en: 'Lookup City', lat: null, lng: null })
    const byCity = record({ id: 'by-city', country_en: 'Gamma', country: '丙', city_en: 'Unknown', city: 'Alt Name', lat: null, lng: null })
    const byCountry = record({ id: 'by-country', country_en: 'Beta', country: '乙', city_en: 'Nowhere', lat: null, lng: null })
    const none = record({ id: 'none', country_en: 'Delta', country: '丁', city_en: 'Void', lat: null, lng: null })

    assert.deepEqual(coordinateForRecord(own), { lat: 5, lng: 6, approximate: false })
    assert.deepEqual(coordinateForRecord(byCityEn), { lat: 10, lng: 20, approximate: true })
    assert.deepEqual(coordinateForRecord(byCity), { lat: 11, lng: 21, approximate: true })
    assert.deepEqual(coordinateForRecord(byCountry), { lat: 30, lng: 40, approximate: true })
    assert.equal(coordinateForRecord(none), undefined)
  } finally {
    delete cityCoordinates['lookup city']
    delete cityCoordinates['alt name']
    delete countryCoordinates.beta
  }
})

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

test('orderBySavedIds：空顺序返回同一个数组；已列出的按名次，未列出的放后面且相对顺序不变', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  assert.equal(orderBySavedIds(items), items)
  assert.equal(orderBySavedIds(items, []), items)
  const ordered = orderBySavedIds(items, ['c', 'x', 'a'])
  assert.deepEqual(ordered.map((item) => item.id), ['c', 'a', 'b', 'd'])
  assert.notEqual(ordered, items)
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c', 'd'])
})
