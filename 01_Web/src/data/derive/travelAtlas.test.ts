/**
 * 足迹派生用到的小工具（derive/travelAtlas.ts 的 coordinateForRecord、derive/editorState.ts 的 orderBySavedIds）的单元测试
 * （RFC-LOC-1 PR1 §3.5；PR5b §4.3：coordinateForRecord 不再按名字查坐标）。
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
// 坐标
// ---------------------------------------------------------------------------

test('coordinateForRecord：只用记录自身的坐标；没有（或只有一半）时为 undefined，不按城市名、国家名查表（RFC-LOC-1 PR5b）', () => {
  assert.deepEqual(coordinateForRecord(record({ id: 'own', lat: 5, lng: 6 })), { lat: 5, lng: 6, approximate: false })
  assert.deepEqual(coordinateForRecord(record({ id: 'zero', lat: 0, lng: 0 })), { lat: 0, lng: 0, approximate: false })
  assert.equal(coordinateForRecord(record({ id: 'none', lat: null, lng: null })), undefined)
  assert.equal(coordinateForRecord(record({ id: 'half', lat: 5, lng: null })), undefined)
  // PR5b 之前这里会按城市英文名、城市名、国家名去查一张（一直为空的）坐标表；现在名字不参与。
  assert.equal(coordinateForRecord(record({ id: 'named', country_en: 'Iceland', city_en: 'Reykjavik', lat: null, lng: null })), undefined)
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
