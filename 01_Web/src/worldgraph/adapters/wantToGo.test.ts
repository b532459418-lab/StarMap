/**
 * wantToGoToWorldGraph 的单元测试（PRD FR-WTG-1 / FR-WTG-2）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * fixture 全部手写。这里【不能】 import src/data/wantToGo.ts 或 travelAtlas.ts：
 * 两者都 import 了 Vite 虚拟模块 'virtual:starmap-private-data'，在 node --test 下无法解析。
 *
 * 下面这行 reference 不能删，理由见 travel.test.ts 的同一段说明：
 * tsconfig.app.json 的 types 是 ["vite/client"]，不含 "node"。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  wantToGoEntityId,
  wantToGoToWorldGraph,
  type WantToGoItem,
} from './wantToGo.ts'

/** 固定时间戳：不传它输出就不可 deepEqual。 */
const NOW = '2026-09-22T00:00:00.000Z'

const nuukItem = (): WantToGoItem => ({
  id: 'wtg_2026-09-17_nuuk',
  place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.18, lng: -51.72 },
  note: '格陵兰首府',
  addedAt: '2026-09-17',
  hidden: false,
  source: 'local-editor',
})

const greenlandItem = (): WantToGoItem => ({
  id: 'wtg_2026-09-18_greenland',
  place: { kind: 'country', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'GL', lat: 71.7, lng: -42.6 },
  addedAt: '2026-09-18',
  hidden: true,
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
// wantToGoToWorldGraph
// ---------------------------------------------------------------------------

test('空输入产出一个四个数组都为空的快照', () => {
  assert.deepEqual(wantToGoToWorldGraph([], { now: NOW }), {
    entities: [],
    memberships: [],
    anchors: [],
    relations: [],
  })
})

test('有坐标的 city 条目：Entity / Anchor / Membership 逐字段正确', () => {
  const snapshot = wantToGoToWorldGraph([nuukItem()], { now: NOW })
  const entityId = wantToGoEntityId('GL', 'Nuuk')

  assert.deepEqual(snapshot.entities, [{
    id: entityId,
    type: 'place',
    subtype: 'city',
    title: { zh: '努克', en: 'Nuuk' },
    metadata: { countryCode: 'GL', source: 'want-to-go', wantToGoId: 'wtg_2026-09-17_nuuk' },
    visibility: 'private',
    createdAt: '2026-09-17',
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
    recordId: 'wtg_2026-09-17_nuuk',
    addedBy: 'user',
    addedAt: '2026-09-17',
    metadata: { hidden: false, source: 'want-to-go', note: '格陵兰首府' },
  }])
})

test('country 条目的 Anchor 精度是 region，不是 exact', () => {
  const snapshot = wantToGoToWorldGraph([greenlandItem()], { now: NOW })
  assert.equal(snapshot.entities[0].subtype, 'country')
  assert.equal(snapshot.anchors[0].precision, 'region')
})

test('没有坐标的条目仍产出 Entity 与 Membership，但不产出 Anchor（D06）', () => {
  const item: WantToGoItem = {
    id: 'wtg_2026-09-18_greenland',
    place: { kind: 'country', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'GL' },
    addedAt: '2026-09-18',
    hidden: false,
  }
  const snapshot = wantToGoToWorldGraph([item], { now: NOW })
  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.memberships.length, 1)
  assert.deepEqual(snapshot.anchors, [])
})

test('隐藏条目仍在快照里，只在 membership.metadata.hidden 上打标记（FR-WTG-5）', () => {
  const snapshot = wantToGoToWorldGraph([greenlandItem()], { now: NOW })
  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.memberships[0].metadata?.hidden, true)
})

test('没有备注时 membership.metadata 里不出现 note 键', () => {
  const snapshot = wantToGoToWorldGraph([greenlandItem()], { now: NOW })
  assert.deepEqual(snapshot.memberships[0].metadata, { hidden: true, source: 'want-to-go' })
})

test('不产出任何 Relation（FR-WTG-1）', () => {
  const snapshot = wantToGoToWorldGraph([nuukItem(), greenlandItem()], { now: NOW })
  assert.deepEqual(snapshot.relations, [])
})

test('同一个 entityId 出现两次时第一条胜出，后续跳过', () => {
  const duplicate: WantToGoItem = {
    ...nuukItem(),
    id: 'wtg_2026-09-19_nuuk-2',
    place: { kind: 'city', nameZh: '另一个努克', nameEn: 'nuuk', countryCode: 'gl'.toUpperCase() },
    addedAt: '2026-09-19',
  }
  const snapshot = wantToGoToWorldGraph([nuukItem(), duplicate], { now: NOW })
  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.memberships.length, 1)
  assert.equal(snapshot.anchors.length, 1)
  assert.equal(snapshot.entities[0].title.zh, '努克')
  assert.equal(snapshot.entities[0].createdAt, '2026-09-17')
})

test('纯函数：不修改输入，相同输入产出逐字段相同的快照', () => {
  const items = deepFreeze([nuukItem(), greenlandItem()])
  const first = wantToGoToWorldGraph(items, { now: NOW })
  const second = wantToGoToWorldGraph(items, { now: NOW })
  assert.deepEqual(first, second)
  assert.deepEqual(items, [nuukItem(), greenlandItem()])
})

test('ID 规则遵循 PRD §8.2：place:wtg:<CC>:<slug>', () => {
  assert.equal(wantToGoEntityId('GL', 'Nuuk'), 'place:wtg:GL:nuuk')
  assert.equal(wantToGoEntityId('gl', 'Nuuk'), 'place:wtg:GL:nuuk')
  assert.equal(wantToGoEntityId('JP', 'Kyoto (Kansai)'), 'place:wtg:JP:kyoto-kansai')
})

test('每条 membership 的 recordId 是它背后想去条目的 id（Core 方案 C3）', () => {
  const snapshot = wantToGoToWorldGraph([nuukItem(), greenlandItem()], { now: NOW })
  assert.deepEqual(
    snapshot.memberships.map((membership) => [membership.entityId, membership.recordId]),
    [
      [wantToGoEntityId('GL', 'Nuuk'), 'wtg_2026-09-17_nuuk'],
      [wantToGoEntityId('GL', 'Greenland'), 'wtg_2026-09-18_greenland'],
    ],
  )
})
