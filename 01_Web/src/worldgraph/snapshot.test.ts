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
  title: { zh },
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
  first.entities.push(entity('place:city:a', 'A'))
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
    snapshotOf({ entities: [entity('place:city:a', 'A'), entity('place:city:b', 'B')] }),
    snapshotOf({ entities: [entity('place:city:c', 'C')] }),
  )
  assert.deepEqual(merged.entities.map((item) => item.id), [
    'place:city:a',
    'place:city:b',
    'place:city:c',
  ])
})

test('entities / anchors / relations 按 id 去重，先到先得', () => {
  const merged = mergeWorldGraphSnapshots(
    snapshotOf({
      entities: [entity('place:city:a', '先到')],
      anchors: [anchor('anchor:location:place:city:a', 'place:city:a')],
      relations: [relation('rel:part_of:a:b', 'place:city:a', 'place:country:b')],
    }),
    snapshotOf({
      entities: [entity('place:city:a', '后到')],
      anchors: [{ ...anchor('anchor:location:place:city:a', 'place:city:a'), lat: 99 }],
      relations: [{ ...relation('rel:part_of:a:b', 'place:city:a', 'place:country:b'), provenance: 'user' }],
    }),
  )
  assert.equal(merged.entities.length, 1)
  assert.equal(merged.entities[0].title.zh, '先到')
  assert.equal(merged.anchors.length, 1)
  assert.equal(merged.anchors[0].lat, 1)
  assert.equal(merged.relations.length, 1)
  assert.equal(merged.relations[0].provenance, 'rule')
})

test('memberships 按复合键 (entityId, layerId) 去重，先到先得（D14）', () => {
  const merged = mergeWorldGraphSnapshots(
    snapshotOf({ memberships: [membership('place:city:a', 'want_to_go', 'user')] }),
    snapshotOf({
      memberships: [
        // 同一个 (entityId, layerId)：被丢弃
        membership('place:city:a', 'want_to_go', 'rule'),
        // 同一个 entityId、不同 layerId：保留
        membership('place:city:a', 'travel', 'rule'),
      ],
    }),
  )
  assert.equal(merged.memberships.length, 2)
  assert.equal(merged.memberships[0].addedBy, 'user')
  assert.deepEqual(merged.memberships.map((item) => item.layerId), ['want_to_go', 'travel'])
})

test('不修改输入快照，也不与输出共享数组', () => {
  const left = deepFreeze(snapshotOf({ entities: [entity('place:city:a', 'A')] }))
  const right = deepFreeze(snapshotOf({ entities: [entity('place:city:b', 'B')] }))
  const merged = mergeWorldGraphSnapshots(left, right)

  assert.equal(merged.entities.length, 2)
  assert.equal(left.entities.length, 1)
  assert.equal(right.entities.length, 1)

  merged.entities.push(entity('place:city:c', 'C'))
  assert.equal(left.entities.length, 1)
})

test('合并 travel / planned / want-to-go 三份快照时各自的 membership 都保留', () => {
  const travel = snapshotOf({
    entities: [entity('place:city:iceland__reykjavik', '雷克雅未克')],
    memberships: [membership('place:city:iceland__reykjavik', 'travel', 'rule')],
  })
  const planned = snapshotOf({
    entities: [entity('place:planned:planned-nuuk', '努克')],
    memberships: [membership('place:planned:planned-nuuk', 'want_to_go', 'rule')],
  })
  const wantToGo = snapshotOf({
    entities: [entity('place:wtg:GL:nuuk', '努克')],
    memberships: [membership('place:wtg:GL:nuuk', 'want_to_go', 'user')],
  })

  const merged = mergeWorldGraphSnapshots(travel, planned, wantToGo)
  assert.equal(merged.entities.length, 3)
  assert.equal(merged.memberships.length, 3)
  // planned 与 want-to-go 的 id 空间刻意不同，同一个真实地点允许两个 Entity 并存（§8.2）。
  assert.notEqual(merged.entities[1].id, merged.entities[2].id)
})
