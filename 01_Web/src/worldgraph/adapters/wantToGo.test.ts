/**
 * wantToGoToWorldGraph 的单元测试（PRD FR-WTG-1 / FR-WTG-2；RFC-LOC-1 Core 方案 C1–C3）。
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

import { wantToGoToWorldGraph, type WantToGoInput } from './wantToGo.ts'

const nuukItem = (): WantToGoInput => ({
  id: 'wtg_2026-09-17_nuuk',
  placeId: 'p-nuuk',
  note: '格陵兰首府',
  addedAt: '2026-09-17',
  hidden: false,
  source: 'local-editor',
})

const greenlandItem = (): WantToGoInput => ({
  id: 'wtg_2026-09-18_greenland',
  placeId: 'p-greenland',
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

test('空输入产出一个四个数组都为空的快照', () => {
  assert.deepEqual(wantToGoToWorldGraph([]), { entities: [], memberships: [], anchors: [], relations: [] })
})

test('条目只产出成员关系：entityId 是地点 id，recordId 是条目 id，逐字段正确（条目自己的 source 不进快照）', () => {
  assert.deepEqual(wantToGoToWorldGraph([nuukItem()]), {
    entities: [],
    memberships: [{
      entityId: 'p-nuuk',
      layerId: 'want_to_go',
      recordId: 'wtg_2026-09-17_nuuk',
      addedBy: 'user',
      addedAt: '2026-09-17',
      metadata: { hidden: false, source: 'want-to-go', note: '格陵兰首府' },
    }],
    anchors: [],
    relations: [],
  })
})

test('隐藏条目仍在快照里，只在 membership.metadata.hidden 上打标记（FR-WTG-5）；没有备注时不出现 note 键', () => {
  const snapshot = wantToGoToWorldGraph([greenlandItem()])
  assert.equal(snapshot.memberships.length, 1)
  assert.deepEqual(snapshot.memberships[0].metadata, { hidden: true, source: 'want-to-go' })
})

test('同一地点的多条想去记录各自产出一条成员关系（按记录，不按地点去重）', () => {
  const second: WantToGoInput = { ...nuukItem(), id: 'wtg_2026-09-19_nuuk-again', note: undefined, addedAt: '2026-09-19', hidden: true }
  const snapshot = wantToGoToWorldGraph([nuukItem(), second])
  assert.deepEqual(
    snapshot.memberships.map((membership) => [membership.entityId, membership.recordId, membership.metadata?.hidden]),
    [['p-nuuk', 'wtg_2026-09-17_nuuk', false], ['p-nuuk', 'wtg_2026-09-19_nuuk-again', true]],
  )
})

test('同一个条目 id 出现两次时第一条胜出，后续跳过', () => {
  const duplicate: WantToGoInput = { ...nuukItem(), placeId: 'p-elsewhere', addedAt: '2026-09-20' }
  const snapshot = wantToGoToWorldGraph([nuukItem(), duplicate])
  assert.deepEqual(snapshot.memberships.map((membership) => [membership.entityId, membership.addedAt]), [['p-nuuk', '2026-09-17']])
})

test('纯函数：不修改输入，相同输入产出逐字段相同的快照', () => {
  const items = deepFreeze([nuukItem(), greenlandItem()])
  const first = wantToGoToWorldGraph(items)
  assert.deepEqual(first, wantToGoToWorldGraph(items))
  assert.deepEqual(items, [nuukItem(), greenlandItem()])
})
