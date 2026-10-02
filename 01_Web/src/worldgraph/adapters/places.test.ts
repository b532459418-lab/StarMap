/**
 * placesToWorldGraph 的单元测试（RFC-LOC-1 Core 方案 C1、C2）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * fixture 全部手写；地点 id 故意写成不透明的字符串（RFC ID-1：代码不解析 id 的结构）。
 *
 * 下面这行 reference 不能删，理由见 travel.test.ts 的同一段说明：
 * tsconfig.app.json 的 types 是 ["vite/client"]，不含 "node"。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { placeEntity, placeLocationAnchor, placesToWorldGraph, type PlaceInput } from './places.ts'

/** 固定时间戳：不传它输出就不可 deepEqual。 */
const NOW = '2026-10-01T00:00:00.000Z'

const iceland = (): PlaceInput => ({
  id: 'p-iceland',
  subtype: 'country',
  title: { names: { 'zh-Hans': '冰岛', en: 'Iceland' } },
  countryCode: 'IS',
  location: { lat: 64.9, lng: -18.6 },
})

const reykjavik = (): PlaceInput => ({
  id: 'p-reykjavik',
  subtype: 'city',
  title: { names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' } },
  countryCode: 'IS',
  partOf: 'p-iceland',
  location: { lat: 64.1466, lng: -21.9426 },
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
  assert.deepEqual(placesToWorldGraph([], { now: NOW }), { entities: [], memberships: [], anchors: [], relations: [] })
})

test('国家与城市：Entity / Anchor / part_of 逐字段正确，实体 id 就是地点 id', () => {
  const snapshot = placesToWorldGraph([iceland(), reykjavik()], { now: NOW })

  assert.deepEqual(snapshot.entities, [
    {
      id: 'p-iceland',
      type: 'place',
      subtype: 'country',
      title: { names: { 'zh-Hans': '冰岛', en: 'Iceland' } },
      metadata: { countryCode: 'IS' },
      visibility: 'private',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'p-reykjavik',
      type: 'place',
      subtype: 'city',
      title: { names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' } },
      metadata: { countryCode: 'IS' },
      visibility: 'private',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ])
  assert.deepEqual(snapshot.anchors, [
    { id: 'anchor:location:p-iceland', entityId: 'p-iceland', kind: 'location', lat: 64.9, lng: -18.6, precision: 'region' },
    { id: 'anchor:location:p-reykjavik', entityId: 'p-reykjavik', kind: 'location', lat: 64.1466, lng: -21.9426, precision: 'exact' },
  ])
  assert.deepEqual(snapshot.relations, [{
    id: 'rel:part_of:p-reykjavik:p-iceland',
    fromEntityId: 'p-reykjavik',
    toEntityId: 'p-iceland',
    type: 'part_of',
    provenance: 'rule',
  }])
  assert.deepEqual(snapshot.memberships, [], '地点本身不属于任何图层')
})

test('没有国家代码时 metadata 为空对象；没有英文名时 title 不出现 en 键', () => {
  const entity = placeEntity({ id: 'p-x', subtype: 'city', title: { names: { 'zh-Hans': '某地' } } }, NOW)
  assert.deepEqual(entity.metadata, {})
  assert.deepEqual(entity.title, { names: { 'zh-Hans': '某地' } })
  assert.equal(Object.hasOwn(entity.title.names, 'en'), false)
})

test('没有坐标、或坐标不是有限数时不产出 Anchor（D06）；0 是合法坐标', () => {
  assert.equal(placeLocationAnchor({ ...reykjavik(), location: undefined }), undefined)
  assert.equal(placeLocationAnchor({ ...reykjavik(), location: { lat: Number.NaN, lng: 1 } }), undefined)
  assert.equal(placeLocationAnchor({ ...reykjavik(), location: { lat: 1, lng: Number.POSITIVE_INFINITY } }), undefined)
  assert.deepEqual(placeLocationAnchor({ ...reykjavik(), location: { lat: 0, lng: 0 } }), {
    id: 'anchor:location:p-reykjavik',
    entityId: 'p-reykjavik',
    kind: 'location',
    lat: 0,
    lng: 0,
    precision: 'exact',
  })

  const snapshot = placesToWorldGraph([{ ...reykjavik(), location: undefined }], { now: NOW })
  assert.equal(snapshot.entities.length, 1)
  assert.deepEqual(snapshot.anchors, [])
})

test('part_of 不悬空：所属地点不在输入里、或指向自己时不产出；目标排在后面也照样产出', () => {
  const orphan: PlaceInput = { ...reykjavik(), partOf: 'p-missing' }
  assert.deepEqual(placesToWorldGraph([orphan], { now: NOW }).relations, [])
  const self: PlaceInput = { ...reykjavik(), partOf: 'p-reykjavik' }
  assert.deepEqual(placesToWorldGraph([self], { now: NOW }).relations, [])
  // 城市在国家之前：part_of 在全部地点接受之后才派生。
  assert.deepEqual(
    placesToWorldGraph([reykjavik(), iceland()], { now: NOW }).relations.map((relation) => relation.id),
    ['rel:part_of:p-reykjavik:p-iceland'],
  )
})

test('同一个 id 出现两次时第一条胜出，后续跳过（实体、锚点、关系各一份）', () => {
  const duplicate: PlaceInput = { ...reykjavik(), title: { names: { 'zh-Hans': '另一个写法' } }, location: { lat: 1, lng: 2 } }
  const snapshot = placesToWorldGraph([iceland(), reykjavik(), duplicate], { now: NOW })
  assert.deepEqual(snapshot.entities.map((entity) => [entity.id, entity.title.names['zh-Hans']]), [['p-iceland', '冰岛'], ['p-reykjavik', '雷克雅未克']])
  assert.deepEqual(snapshot.anchors.map((anchor) => [anchor.entityId, anchor.lat]), [['p-iceland', 64.9], ['p-reykjavik', 64.1466]])
  assert.equal(snapshot.relations.length, 1)
})

test('纯函数：不修改输入，返回的对象不与输入共享引用，相同输入产出逐字段相同的快照', () => {
  const places = deepFreeze([iceland(), reykjavik()])
  const first = placesToWorldGraph(places, { now: NOW })
  const second = placesToWorldGraph(places, { now: NOW })
  assert.deepEqual(first, second)
  assert.deepEqual(places, [iceland(), reykjavik()])
  assert.notEqual(first.entities[1].title, places[1].title)
  assert.notEqual(first.entities[1].title.names, places[1].title.names)
})
