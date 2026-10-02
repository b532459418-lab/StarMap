/**
 * mergeWorldGraphSnapshots 的单元测试（PRD §8.1 数据流）。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict。
 * 下面这行 reference 不能删，理由见 adapters/travel.test.ts 的同一段说明。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Anchor, Entity, LayerMembership, Relation, WorldGraphSnapshot } from './types.ts'
import { emptyWorldGraphSnapshot, mergeWorldGraphSnapshots } from './snapshot.ts'

const NOW = '2026-09-22T00:00:00.000Z'

const entity = (id: string, zh: string): Entity => ({
  id,
  type: 'place',
  subtype: 'city',
  title: { names: { 'zh-Hans': zh } },
  metadata: {},
  visibility: 'private',
  createdAt: NOW,
  updatedAt: NOW,
})

const membership = (
  entityId: string,
  layerId: LayerMembership['layerId'],
  addedBy: LayerMembership['addedBy'] = 'user',
): LayerMembership => ({ entityId, layerId, addedBy, addedAt: NOW })

const anchor = (id: string, entityId: string): Anchor => ({
  id,
  entityId,
  kind: 'location',
  lat: 1,
  lng: 2,
  precision: 'exact',
})

const relation = (id: string, from: string, to: string): Relation => ({
  id,
  fromEntityId: from,
  toEntityId: to,
  type: 'part_of',
  provenance: 'rule',
})

const snapshotOf = (partial: Partial<WorldGraphSnapshot>): WorldGraphSnapshot => ({
  ...emptyWorldGraphSnapshot(),
  ...partial,
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

test('emptyWorldGraphSnapshot 每次返回一份新的空快照', () => {
  const first = emptyWorldGraphSnapshot()
  assert.equal(first.entities.length, 0)
  assert.equal(first.memberships.length, 0)
  assert.equal(first.anchors.length, 0)
  assert.equal(first.relations.length, 0)
  // 改动其中一份不能影响下一次调用：工厂函数每次都要新建数组。
  first.entities.push(entity('p-a', 'A'))
  assert.deepEqual(emptyWorldGraphSnapshot(), {
    entities: [],
    memberships: [],
    anchors: [],
    relations: [],
  })
})

test('没有输入、或只有空快照时产出空快照', () => {
  assert.deepEqual(mergeWorldGraphSnapshots(), emptyWorldGraphSnapshot())
  assert.deepEqual(
    mergeWorldGraphSnapshots(emptyWorldGraphSnapshot(), emptyWorldGraphSnapshot()),
    emptyWorldGraphSnapshot(),
  )
})

test('多份快照按输入顺序拼接，顺序稳定', () => {
  const merged = mergeWorldGraphSnapshots(
    snapshotOf({ entities: [entity('p-a', 'A'), entity('p-b', 'B')] }),
    snapshotOf({ entities: [entity('p-c', 'C')] }),
  )
  assert.deepEqual(merged.entities.map((item) => item.id), [
    'p-a',
    'p-b',
    'p-c',
  ])
})

test('entities / anchors / relations 按 id 去重，先到先得', () => {
  const merged = mergeWorldGraphSnapshots(
    snapshotOf({
      entities: [entity('p-a', '先到')],
      anchors: [anchor('anchor:location:p-a', 'p-a')],
      relations: [relation('rel:part_of:a:b', 'p-a', 'p-b')],
    }),
    snapshotOf({
      entities: [entity('p-a', '后到')],
      anchors: [{ ...anchor('anchor:location:p-a', 'p-a'), lat: 99 }],
      relations: [{ ...relation('rel:part_of:a:b', 'p-a', 'p-b'), provenance: 'user' }],
    }),
  )
  assert.equal(merged.entities.length, 1)
  assert.equal(merged.entities[0].title.names['zh-Hans'], '先到')
  assert.equal(merged.anchors.length, 1)
  assert.equal(merged.anchors[0].lat, 1)
  assert.equal(merged.relations.length, 1)
  assert.equal(merged.relations[0].provenance, 'rule')
})

test('没有 recordId 的 memberships 按 (entityId, layerId) 去重，先到先得（D14）', () => {
  const merged = mergeWorldGraphSnapshots(
    snapshotOf({ memberships: [membership('p-a', 'want_to_go', 'user')] }),
    snapshotOf({
      memberships: [
        // 同一个 (entityId, layerId)：被丢弃
        membership('p-a', 'want_to_go', 'rule'),
        // 同一个 entityId、不同 layerId：保留
        membership('p-a', 'travel', 'rule'),
      ],
    }),
  )
  assert.equal(merged.memberships.length, 2)
  assert.equal(merged.memberships[0].addedBy, 'user')
  assert.deepEqual(merged.memberships.map((item) => item.layerId), ['want_to_go', 'travel'])
})

test('memberships 的去重键含 recordId：同一 (entityId, layerId) 的不同记录各留一条（Core 方案 C3）', () => {
  const withRecord = (recordId: string | undefined, addedBy: LayerMembership['addedBy']): LayerMembership => (
    recordId === undefined
      ? membership('p-a', 'want_to_go', addedBy)
      : { ...membership('p-a', 'want_to_go', addedBy), recordId }
  )
  const merged = mergeWorldGraphSnapshots(
    snapshotOf({ memberships: [withRecord('wtg_1', 'user'), withRecord(undefined, 'user')] }),
    snapshotOf({
      memberships: [
        // 同一条记录：被丢弃，先到先得
        withRecord('wtg_1', 'rule'),
        // 同一实体、同一图层的另一条记录：保留
        withRecord('planned_1', 'rule'),
        // 没有 recordId 按空串算：与第一份里没有 recordId 的那条同键，被丢弃
        withRecord(undefined, 'rule'),
      ],
    }),
  )
  assert.deepEqual(
    merged.memberships.map((item) => [item.recordId, item.addedBy]),
    [['wtg_1', 'user'], [undefined, 'user'], ['planned_1', 'rule']],
  )
})

test('不修改输入快照，也不与输出共享数组', () => {
  const left = deepFreeze(snapshotOf({ entities: [entity('p-a', 'A')] }))
  const right = deepFreeze(snapshotOf({ entities: [entity('p-b', 'B')] }))
  const merged = mergeWorldGraphSnapshots(left, right)

  assert.equal(merged.entities.length, 2)
  assert.equal(left.entities.length, 1)
  assert.equal(right.entities.length, 1)

  merged.entities.push(entity('p-c', 'C'))
  assert.equal(left.entities.length, 1)
})

test('按 App 的顺序合并地点、足迹、想去、planned 四份快照：同一地点只有一个实体，各记录的 membership 都保留', () => {
  // RFC-LOC-1 Core-A：地点实体只由地点快照提供；其余三份只按地点 id 引用它（Core 方案 C1、C2、C3）。
  const places = snapshotOf({ entities: [entity('p-reykjavik', '雷克雅未克'), entity('p-nuuk', '努克')] })
  const travel = snapshotOf({ memberships: [membership('p-reykjavik', 'travel', 'rule')] })
  const wantToGo = snapshotOf({ memberships: [{ ...membership('p-nuuk', 'want_to_go', 'user'), recordId: 'w-nuuk' }] })
  const planned = snapshotOf({ memberships: [{ ...membership('p-nuuk', 'want_to_go', 'rule'), recordId: 'pl-nuuk' }] })

  const merged = mergeWorldGraphSnapshots(places, travel, wantToGo, planned)
  assert.deepEqual(merged.entities.map((item) => item.id), ['p-reykjavik', 'p-nuuk'])
  assert.deepEqual(
    merged.memberships.map((item) => [item.entityId, item.layerId, item.recordId]),
    [['p-reykjavik', 'travel', undefined], ['p-nuuk', 'want_to_go', 'w-nuuk'], ['p-nuuk', 'want_to_go', 'pl-nuuk']],
  )
})
