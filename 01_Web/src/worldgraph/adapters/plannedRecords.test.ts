/**
 * plannedRecordsToWorldGraph 的单元测试（PRD FR-WTG-7）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * fixture 手写，理由与 travel.test.ts 相同：travelAtlas.ts import 了 Vite 虚拟模块
 * 'virtual:starmap-private-data' 并读 import.meta.env，node --test 下无法解析。
 * 这里的记录形状对齐 03_Reference/travel-map.schema.json 的 record 定义。
 *
 * 下面这行 reference 不能删，理由见 travel.test.ts 的同一段说明。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TravelMapRecord } from '../../types/travel.ts'
import { plannedEntityId, plannedRecordsToWorldGraph } from './plannedRecords.ts'

/** 固定时间戳：不传它输出就不可 deepEqual。 */
const NOW = '2026-09-22T00:00:00.000Z'

const plannedNuuk = (): TravelMapRecord => ({
  id: 'planned-nuuk',
  country: '格陵兰',
  country_en: 'Greenland',
  country_code: 'gl',
  city: '努克',
  city_en: 'Nuuk',
  start_date: '2027-06-01',
  status: 'planned',
  lat: 64.18,
  lng: -51.72,
  notes: '冰岛之后的下一站',
})

const visitedReykjavik = (): TravelMapRecord => ({
  id: 'sample-reykjavik',
  country: '冰岛',
  country_en: 'Iceland',
  city: '雷克雅未克',
  city_en: 'Reykjavik',
  start_date: '2025-06-01',
  status: 'visited',
  lat: 64.1466,
  lng: -21.9426,
})

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

// ---------------------------------------------------------------------------
// 1. 只取 planned
// ---------------------------------------------------------------------------

test('空输入产出一个四个数组都为空的快照', () => {
  assert.deepEqual(plannedRecordsToWorldGraph([], { now: NOW }), {
    entities: [],
    memberships: [],
    anchors: [],
    relations: [],
  })
})

test('只取 status === planned 的记录，其余一律忽略（FR-TA-5 的另一半）', () => {
  const snapshot = plannedRecordsToWorldGraph(
    [
      visitedReykjavik(),
      plannedNuuk(),
      { ...visitedReykjavik(), id: 'no-status', status: undefined },
      { ...visitedReykjavik(), id: 'weird-status', status: 'Planned' },
    ],
    { now: NOW },
  )
  assert.deepEqual(snapshot.entities.map((entity) => entity.id), [plannedEntityId('planned-nuuk')])
})

// ---------------------------------------------------------------------------
// 2. 逐字段映射
// ---------------------------------------------------------------------------

test('planned 记录的 Entity / Anchor / Membership 逐字段正确', () => {
  const snapshot = plannedRecordsToWorldGraph([plannedNuuk()], { now: NOW })
  const entityId = plannedEntityId('planned-nuuk')

  assert.deepEqual(snapshot.entities, [{
    id: entityId,
    type: 'place',
    subtype: 'city',
    title: { zh: '努克', en: 'Nuuk' },
    metadata: {
      source: 'travel-map:planned',
      readOnly: true,
      recordId: 'planned-nuuk',
      countryCode: 'GL',
      countryEn: 'Greenland',
    },
    visibility: 'private',
    createdAt: '2027-06-01',
    updatedAt: NOW,
  }])

  assert.deepEqual(snapshot.anchors, [{
    id: `anchor:location:${entityId}`,
    entityId,
    kind: 'location',
    lat: 64.18,
    lng: -51.72,
    precision: 'exact',
  }])

  assert.deepEqual(snapshot.memberships, [{
    entityId,
    layerId: 'want_to_go',
    addedBy: 'rule',
    addedAt: '2027-06-01',
    metadata: { source: 'travel-map:planned', readOnly: true, note: '冰岛之后的下一站' },
  }])

  assert.deepEqual(snapshot.relations, [])
})

test('没有 notes 时 membership.metadata 里不出现 note 键', () => {
  const record = plannedNuuk()
  delete record.notes
  const snapshot = plannedRecordsToWorldGraph([record], { now: NOW })
  assert.deepEqual(snapshot.memberships[0].metadata, {
    source: 'travel-map:planned',
    readOnly: true,
  })
})

// ---------------------------------------------------------------------------
// 3. countryCode 的三级回落
// ---------------------------------------------------------------------------

test('countryCode 优先用记录自带的 country_code，并统一大写', () => {
  const snapshot = plannedRecordsToWorldGraph([plannedNuuk()], {
    now: NOW,
    countryCodes: { Greenland: 'xx' },
  })
  assert.equal(snapshot.entities[0].metadata.countryCode, 'GL')
})

test('记录没有 country_code 时回落到 options.countryCodes', () => {
  const record = plannedNuuk()
  delete record.country_code
  const snapshot = plannedRecordsToWorldGraph([record], {
    now: NOW,
    countryCodes: { Greenland: 'gl' },
  })
  assert.equal(snapshot.entities[0].metadata.countryCode, 'GL')
})

test('两级都没有时省略 countryCode 键，其余字段照常', () => {
  const record = plannedNuuk()
  delete record.country_code
  const snapshot = plannedRecordsToWorldGraph([record], { now: NOW })
  assert.equal('countryCode' in snapshot.entities[0].metadata, false)
  assert.equal(snapshot.entities[0].metadata.countryEn, 'Greenland')
})

// ---------------------------------------------------------------------------
// 4. 坐标（D06 / FR-TA-3 的同一条规则）
// ---------------------------------------------------------------------------

test('lat / lng 为 null 时仍产出 Entity 与 Membership，但不产出 Anchor', () => {
  const snapshot = plannedRecordsToWorldGraph(
    [{ ...plannedNuuk(), lat: null, lng: null }],
    { now: NOW },
  )
  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.memberships.length, 1)
  assert.deepEqual(snapshot.anchors, [])
})

test('只有一半坐标或坐标为 NaN 时不产出 Anchor', () => {
  const halfSnapshot = plannedRecordsToWorldGraph([{ ...plannedNuuk(), lng: null }], { now: NOW })
  assert.deepEqual(halfSnapshot.anchors, [])
  const nanSnapshot = plannedRecordsToWorldGraph([{ ...plannedNuuk(), lat: Number.NaN }], { now: NOW })
  assert.deepEqual(nanSnapshot.anchors, [])
})

test('坐标恰好为 0 是合法坐标，必须产出 Anchor', () => {
  const snapshot = plannedRecordsToWorldGraph([{ ...plannedNuuk(), lat: 0, lng: 0 }], { now: NOW })
  assert.equal(snapshot.anchors.length, 1)
})

// ---------------------------------------------------------------------------
// 5. 标题回落、去重与纯函数
// ---------------------------------------------------------------------------

test('中文城市名缺失时 title.zh 回落到英文名', () => {
  const snapshot = plannedRecordsToWorldGraph([{ ...plannedNuuk(), city: '' }], { now: NOW })
  assert.deepEqual(snapshot.entities[0].title, { zh: 'Nuuk', en: 'Nuuk' })
})

test('同一个 record id 出现两次时第一条胜出', () => {
  const snapshot = plannedRecordsToWorldGraph(
    [plannedNuuk(), { ...plannedNuuk(), city: '另一个努克' }],
    { now: NOW },
  )
  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.entities[0].title.zh, '努克')
})

test('纯函数：不修改输入，相同输入产出逐字段相同的快照', () => {
  const records = deepFreeze([plannedNuuk(), visitedReykjavik()])
  const options = deepFreeze({ now: NOW, countryCodes: { Greenland: 'GL' } })
  const first = plannedRecordsToWorldGraph(records, options)
  const second = plannedRecordsToWorldGraph(records, options)
  assert.deepEqual(first, second)
  assert.deepEqual(records, [plannedNuuk(), visitedReykjavik()])
})

test('ID 规则遵循 PRD §8.2，且与 want-to-go 的 id 空间刻意不同', () => {
  assert.equal(plannedEntityId('planned-nuuk'), 'place:planned:planned-nuuk')
  assert.notEqual(plannedEntityId('planned-nuuk'), 'place:wtg:GL:nuuk')
})
