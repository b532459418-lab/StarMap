/**
 * queryVisiblePlaces 的单元测试（PRD FR-LR-3 / FR-MR-1..FR-MR-5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 本文件的快照全部是手写的最小快照——目的是把查询规则本身钉死，
 * 而不是重复验证 travel 适配器（那是 adapters/travel.test.ts 的职责）。
 * "查询与现有 Globe 逻辑在样例数据上逐条相等"由 query.parity.test.ts 负责。
 *
 * 下面这行 reference 不能删，理由同 adapters/travel.test.ts：
 * tsconfig.app.json 的 types 是 ["vite/client"]，不含 "node"。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type {
  Anchor,
  Entity,
  EntityId,
  LayerId,
  LayerMembership,
  Relation,
  RelationType,
  WorldGraphSnapshot,
} from './types.ts'
import { cityEntityId, countryEntityId, journeyEntityId } from './adapters/travel.ts'
import { queryVisiblePlaces } from './query.ts'

const NOW = '2026-09-20T00:00:00.000Z'

// ---------------------------------------------------------------------------
// 手写快照的小工具
// ---------------------------------------------------------------------------

const place = (
  id: EntityId,
  subtype: 'region' | 'country' | 'city',
  title: { zh: string; en?: string },
  metadata: Record<string, unknown> = {},
): Entity => ({
  id,
  type: 'place',
  subtype,
  title,
  metadata,
  visibility: 'private',
  createdAt: NOW,
  updatedAt: NOW,
})

const journey = (id: EntityId, journeyId?: string): Entity => ({
  id,
  type: 'journey',
  title: { zh: id },
  metadata: journeyId === undefined ? {} : { journeyId },
  visibility: 'private',
  createdAt: NOW,
  updatedAt: NOW,
})

const location = (entityId: EntityId, lat: number, lng: number): Anchor => ({
  id: `anchor:location:${entityId}`,
  entityId,
  kind: 'location',
  lat,
  lng,
  precision: 'exact',
})

const member = (
  entityId: EntityId,
  layerId: LayerId,
  metadata?: Record<string, unknown>,
): LayerMembership => {
  const membership: LayerMembership = { entityId, layerId, addedBy: 'rule', addedAt: NOW }
  if (metadata !== undefined) membership.metadata = metadata
  return membership
}

const relation = (
  id: string,
  type: RelationType,
  fromEntityId: EntityId,
  toEntityId: EntityId,
  metadata?: Record<string, unknown>,
): Relation => {
  const value: Relation = { id, fromEntityId, toEntityId, type, provenance: 'rule' }
  if (metadata !== undefined) value.metadata = metadata
  return value
}

const emptySnapshot = (): WorldGraphSnapshot => ({
  entities: [],
  memberships: [],
  anchors: [],
  relations: [],
})

/**
 * 一份覆盖大部分规则的小快照：
 * - 国家 c1（accent #111111，cityIds 顺序 a → b）
 * - 城市 a / b 属于 c1，都在 travel 层；a 另外还在 want_to_go 层
 * - 城市 z 属于国家 c2，用来造跨国段
 * - 行程 d1 / d2 到访 a，d3 到访 b，d4 到访 z（journeyId 都是 j1）
 */
const demoSnapshot = (): WorldGraphSnapshot => ({
  entities: [
    place(countryEntityId('c1'), 'country', { zh: '国一' }, { sourceId: 'c1', accent: '#111111', cityIds: ['a', 'b'] }),
    place(countryEntityId('c2'), 'country', { zh: '国二' }, { sourceId: 'c2', accent: '#222222', cityIds: ['z'] }),
    place(cityEntityId('a'), 'city', { zh: '甲', en: 'Alpha' }, { sourceId: 'a', countryId: 'c1' }),
    place(cityEntityId('b'), 'city', { zh: '乙', en: 'Beta' }, { sourceId: 'b', countryId: 'c1' }),
    place(cityEntityId('z'), 'city', { zh: '丙', en: 'Zeta' }, { sourceId: 'z', countryId: 'c2' }),
    journey(journeyEntityId('d1'), 'j1'),
    journey(journeyEntityId('d2'), 'j1'),
    journey(journeyEntityId('d3'), 'j1'),
    journey(journeyEntityId('d4'), 'j1'),
  ],
  memberships: [
    member(countryEntityId('c1'), 'travel'),
    member(countryEntityId('c2'), 'travel'),
    member(cityEntityId('a'), 'travel'),
    member(cityEntityId('a'), 'want_to_go', { note: '还想再去' }),
    member(cityEntityId('b'), 'travel'),
    member(cityEntityId('z'), 'travel'),
    member(journeyEntityId('d1'), 'travel'),
    member(journeyEntityId('d2'), 'travel'),
    member(journeyEntityId('d3'), 'travel'),
    member(journeyEntityId('d4'), 'travel'),
  ],
  anchors: [
    location(countryEntityId('c1'), 10, 20),
    location(cityEntityId('a'), 1, 2),
    location(cityEntityId('b'), 3, 4),
    location(cityEntityId('z'), 5, 6),
  ],
  relations: [
    relation('rel:part_of:a', 'part_of', cityEntityId('a'), countryEntityId('c1')),
    relation('rel:part_of:b', 'part_of', cityEntityId('b'), countryEntityId('c1')),
    relation('rel:part_of:z', 'part_of', cityEntityId('z'), countryEntityId('c2')),
    relation('rel:visited:d1', 'visited', journeyEntityId('d1'), cityEntityId('a')),
    relation('rel:visited:d2', 'visited', journeyEntityId('d2'), cityEntityId('a')),
    relation('rel:visited:d3', 'visited', journeyEntityId('d3'), cityEntityId('b')),
    relation('rel:visited:d4', 'visited', journeyEntityId('d4'), cityEntityId('z')),
    relation('rel:related_to:b__z', 'related_to', cityEntityId('b'), cityEntityId('z'), {
      kind: 'flight',
      routeId: 'r-b-z',
      journeyId: 'j1',
    }),
  ],
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

const sourceIds = (result: { places: { sourceId: string }[] }): string[] =>
  result.places.map((item) => item.sourceId)

// ---------------------------------------------------------------------------
// 1. 空快照与图层可见性
// ---------------------------------------------------------------------------

test('空快照产出空结果，visibleLayerIds 原样带出', () => {
  assert.deepEqual(queryVisiblePlaces(emptySnapshot(), ['travel']), {
    visibleLayerIds: ['travel'],
    places: [],
    routes: [],
  })
  assert.deepEqual(queryVisiblePlaces(emptySnapshot(), []), {
    visibleLayerIds: [],
    places: [],
    routes: [],
  })
})

test('没有任何图层可见时，places 与 routes 都为空', () => {
  const result = queryVisiblePlaces(demoSnapshot(), [])
  assert.deepEqual(result.places, [])
  assert.deepEqual(result.routes, [])
})

test('只开 travel：三个城市都在，layerIds 只有 travel', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(sourceIds(result), ['a', 'b', 'z'])
  assert.deepEqual(
    result.places.map((item) => item.layerIds),
    [['travel'], ['travel'], ['travel']],
  )
})

test('只开 want_to_go：只剩下有 want_to_go 成员关系的城市，且 routes 为空', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['want_to_go'])
  assert.deepEqual(sourceIds(result), ['a'])
  assert.deepEqual(result.places[0].layerIds, ['want_to_go'])
  assert.deepEqual(result.routes, [], 'travel 不可见时不计算任何路线（FR-LR-3）')
})

test('两层都开：同一个 Entity 只出现一次，layerIds 合并并按 officialLayers.order 排序', () => {
  // 故意把 want_to_go 放在参数的前面，证明排序依据是 Registry 的 order 而不是参数顺序。
  const result = queryVisiblePlaces(demoSnapshot(), ['want_to_go', 'travel'])
  assert.deepEqual(sourceIds(result), ['a', 'b', 'z'])
  assert.deepEqual(result.places[0].layerIds, ['travel', 'want_to_go'])
  assert.deepEqual(result.places[1].layerIds, ['travel'])
})

test('membership.metadata 按图层分别带出', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go'])
  assert.deepEqual(result.places[0].membershipMetadata, { want_to_go: { note: '还想再去' } })
  assert.deepEqual(result.places[1].membershipMetadata, {}, 'travel 的 membership 没有 metadata')
})

test('metadata.hidden === true 的成员关系被排除（FR-TA-4）', () => {
  const snapshot = demoSnapshot()
  snapshot.memberships = snapshot.memberships.map((membership) =>
    membership.entityId === cityEntityId('b') ? { ...membership, metadata: { hidden: true } } : membership,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(sourceIds(result), ['a', 'z'])
})

test('hidden 为 false 或其他值不算隐藏', () => {
  const snapshot = demoSnapshot()
  snapshot.memberships = snapshot.memberships.map((membership) =>
    membership.entityId === cityEntityId('b') ? { ...membership, metadata: { hidden: false } } : membership,
  )
  assert.deepEqual(sourceIds(queryVisiblePlaces(snapshot, ['travel'])), ['a', 'b', 'z'])
})

// ---------------------------------------------------------------------------
// 2. 哪些 Entity 能进 places
// ---------------------------------------------------------------------------

test('没有 location Anchor 的 place 不进结果（D06：Entity 本身合法，只是地图画不出）', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors = snapshot.anchors.filter((anchor) => anchor.entityId !== cityEntityId('b'))
  assert.deepEqual(sourceIds(queryVisiblePlaces(snapshot, ['travel'])), ['a', 'z'])
})

test('坐标不是有限数（NaN / 缺一半）的 Anchor 不算有坐标', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors = snapshot.anchors.map((anchor) => {
    if (anchor.entityId === cityEntityId('a')) return { ...anchor, lat: Number.NaN }
    if (anchor.entityId === cityEntityId('b')) return { ...anchor, lng: undefined }
    return anchor
  })
  assert.deepEqual(sourceIds(queryVisiblePlaces(snapshot, ['travel'])), ['z'])
})

test('经纬度恰好为 0 是合法坐标', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors = snapshot.anchors.map((anchor) =>
    anchor.entityId === cityEntityId('a') ? { ...anchor, lat: 0, lng: 0 } : anchor,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.equal(result.places[0].lat, 0)
  assert.equal(result.places[0].lng, 0)
})

test('足迹图层里 country / region 的 place 不进 places（足迹只画城市标记）', () => {
  const snapshot = demoSnapshot()
  snapshot.entities.push(place('place:region:r1', 'region', { zh: '某区' }, { sourceId: 'r1' }))
  snapshot.memberships.push(member('place:region:r1', 'travel'))
  snapshot.anchors.push(location('place:region:r1', 7, 8))

  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(sourceIds(result), ['a', 'b', 'z'])
  assert.ok(
    result.places.every((item) => item.subtype === 'city'),
    'places 里只能有 subtype === city',
  )
})

test('journey / media 类型的 Entity 不进 places', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors.push(location(journeyEntityId('d1'), 9, 9))
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(sourceIds(result), ['a', 'b', 'z'])
})

test('只有没有任何可见成员关系的 Entity 被排除', () => {
  const snapshot = demoSnapshot()
  snapshot.memberships = snapshot.memberships.filter(
    (membership) => membership.entityId !== cityEntityId('z'),
  )
  assert.deepEqual(sourceIds(queryVisiblePlaces(snapshot, ['travel'])), ['a', 'b'])
})

test('places 的顺序等于 Entity 在 snapshot.entities 里的顺序', () => {
  const snapshot = demoSnapshot()
  const cities = snapshot.entities.filter((entity) => entity.subtype === 'city')
  snapshot.entities = [...snapshot.entities.filter((entity) => entity.subtype !== 'city'), ...cities.reverse()]
  assert.deepEqual(sourceIds(queryVisiblePlaces(snapshot, ['travel'])), ['z', 'b', 'a'])
})

// ---------------------------------------------------------------------------
// 3. 字段：title / sourceId / countryId / visitCount / accent
// ---------------------------------------------------------------------------

test('逐字段投影一个 place', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go'])
  assert.deepEqual(result.places[0], {
    entityId: cityEntityId('a'),
    sourceId: 'a',
    subtype: 'city',
    title: { zh: '甲', en: 'Alpha' },
    lat: 1,
    lng: 2,
    layerIds: ['travel', 'want_to_go'],
    countryEntityId: countryEntityId('c1'),
    countryId: 'c1',
    accent: '#111111',
    visitCount: 2,
    membershipMetadata: { want_to_go: { note: '还想再去' } },
  })
})

test('没有 metadata.sourceId 时 sourceId 回落到 EntityId', () => {
  const snapshot = emptySnapshot()
  snapshot.entities.push(place('freeform-place', 'city', { zh: '无源' }))
  snapshot.memberships.push(member('freeform-place', 'travel'))
  snapshot.anchors.push(location('freeform-place', 1, 1))
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.equal(result.places[0].sourceId, 'freeform-place')
})

test('title 没有英文名时不产出 en 键', () => {
  const snapshot = emptySnapshot()
  snapshot.entities.push(place('place:city:solo', 'city', { zh: '只有中文' }, { sourceId: 'solo' }))
  snapshot.memberships.push(member('place:city:solo', 'travel'))
  snapshot.anchors.push(location('place:city:solo', 1, 1))
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel']).places[0].title, { zh: '只有中文' })
})

test('visitCount 数的是指向本地点的 visited Relation 条数，没有则 0', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(
    result.places.map((item) => [item.sourceId, item.visitCount]),
    [['a', 2], ['b', 1], ['z', 1]],
  )

  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.filter((item) => item.type !== 'visited')
  assert.deepEqual(
    queryVisiblePlaces(snapshot, ['travel']).places.map((item) => item.visitCount),
    [0, 0, 0],
  )
})

test('accent 优先取自身 metadata.accent，其次取所属国家', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === cityEntityId('a')
      ? { ...entity, metadata: { ...entity.metadata, accent: '#abcdef' } }
      : entity,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.equal(result.places[0].accent, '#abcdef', '自身 accent 优先')
  assert.equal(result.places[1].accent, '#111111', '没有自身 accent 时取国家的')
})

test('没有 part_of 时不产出 countryEntityId / countryId / accent', () => {
  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.filter((item) => item.type !== 'part_of')
  const [first] = queryVisiblePlaces(snapshot, ['travel']).places
  assert.equal(first.countryEntityId, undefined)
  assert.equal(first.countryId, undefined)
  assert.equal(first.accent, undefined)
})

test('countryId 在国家没有 sourceId 时回落到 metadata.countryId', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === countryEntityId('c1')
      ? { ...entity, metadata: { accent: '#111111', cityIds: ['a', 'b'], countryId: 'fallback' } }
      : entity,
  )
  assert.equal(queryVisiblePlaces(snapshot, ['travel']).places[0].countryId, 'fallback')
})

// ---------------------------------------------------------------------------
// 4. routes
// ---------------------------------------------------------------------------

test('travel 不可见时 routes 恒为空（FR-LR-3）', () => {
  assert.deepEqual(queryVisiblePlaces(demoSnapshot(), ['want_to_go']).routes, [])
  assert.deepEqual(queryVisiblePlaces(demoSnapshot(), []).routes, [])
  assert.ok(queryVisiblePlaces(demoSnapshot(), ['travel']).routes.length > 0)
})

test('国家内顺序段：没有 related_to 时用 country-order id + 两端共享的 journeyId', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(result.routes[0], {
    id: 'country-order__c1__a__b',
    fromEntityId: cityEntityId('a'),
    toEntityId: cityEntityId('b'),
    fromSourceId: 'a',
    toSourceId: 'b',
    fromLat: 1,
    fromLng: 2,
    toLat: 3,
    toLng: 4,
    journeyId: 'j1',
    kind: 'main',
    fromCountryId: 'c1',
    toCountryId: 'c1',
  })
})

test('国家内顺序段：有同端点的 related_to 时，routeId / journeyId / kind 被它覆盖', () => {
  const snapshot = demoSnapshot()
  snapshot.relations.push(
    relation('rel:related_to:a__b', 'related_to', cityEntityId('a'), cityEntityId('b'), {
      kind: 'ferry',
      routeId: 'r-a-b',
      journeyId: 'j9',
    }),
  )
  const [first] = queryVisiblePlaces(snapshot, ['travel']).routes
  assert.equal(first.id, 'r-a-b')
  assert.equal(first.journeyId, 'j9')
  assert.equal(first.kind, 'ferry')
})

test('国家内顺序段：related_to 缺 journeyId 时退回两端共享的 journeyId', () => {
  const snapshot = demoSnapshot()
  snapshot.relations.push(
    relation('rel:related_to:a__b', 'related_to', cityEntityId('a'), cityEntityId('b'), {
      kind: 'drive',
      routeId: 'r-a-b',
    }),
  )
  const [first] = queryVisiblePlaces(snapshot, ['travel']).routes
  assert.equal(first.id, 'r-a-b')
  assert.equal(first.kind, 'drive')
  assert.equal(first.journeyId, 'j1', '共享 journeyId 由两端的 visited 关系推断')
})

test('国家内顺序段：两端没有共享 journeyId 时整段被丢弃', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === journeyEntityId('d3') ? { ...entity, metadata: { journeyId: 'j2' } } : entity,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(
    result.routes.map((route) => route.id),
    ['r-b-z'],
    'a→b 段没有共享 journeyId，只剩跨国段',
  )
})

test('国家内顺序段：cityIds 里有一端不在快照里时跳过该段', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === countryEntityId('c1')
      ? { ...entity, metadata: { ...entity.metadata, cityIds: ['a', 'missing', 'b'] } }
      : entity,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(result.routes.map((route) => route.id), ['r-b-z'])
})

test('国家内顺序段只取相邻两两，三个城市产出两段', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) => {
    if (entity.id === countryEntityId('c1')) {
      return { ...entity, metadata: { ...entity.metadata, cityIds: ['a', 'b', 'z'] } }
    }
    return entity
  })
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(
    result.routes.map((route) => [route.fromSourceId, route.toSourceId]),
    [['a', 'b'], ['b', 'z'], ['b', 'z']],
    '顺序段两条在前，跨国段在后（b→z 同时满足两种规则，与 PR3 之前的行为一致）',
  )
})

test('跨国段：两端国家不同的 related_to 直接成段', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(result.routes[1], {
    id: 'r-b-z',
    fromEntityId: cityEntityId('b'),
    toEntityId: cityEntityId('z'),
    fromSourceId: 'b',
    toSourceId: 'z',
    fromLat: 3,
    fromLng: 4,
    toLat: 5,
    toLng: 6,
    journeyId: 'j1',
    kind: 'flight',
    fromCountryId: 'c1',
    toCountryId: 'c2',
  })
})

test('跨国段：两端国家相同的 related_to 不产出跨国段', () => {
  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.map((item) =>
    item.id === 'rel:related_to:b__z'
      ? relation(item.id, 'related_to', cityEntityId('a'), cityEntityId('b'), item.metadata)
      : item,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(result.routes.map((route) => route.id), ['r-b-z'], '只剩被它覆盖过的顺序段')
})

test('缺 journeyId 的段被丢弃', () => {
  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.map((item) =>
    item.id === 'rel:related_to:b__z' ? relation(item.id, 'related_to', item.fromEntityId, item.toEntityId, { kind: 'flight', routeId: 'r-b-z' }) : item,
  )
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(result.routes.map((route) => route.id), ['country-order__c1__a__b'])
})

test('任一端没有 location Anchor 的段被丢弃', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors = snapshot.anchors.filter((anchor) => anchor.entityId !== cityEntityId('z'))
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(result.routes.map((route) => route.id), ['country-order__c1__a__b'])
})

test('未知的 kind 回落成 main', () => {
  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.map((item) =>
    item.id === 'rel:related_to:b__z'
      ? relation(item.id, 'related_to', item.fromEntityId, item.toEntityId, { kind: 'teleport', routeId: 'r-b-z', journeyId: 'j1' })
      : item,
  )
  assert.equal(queryVisiblePlaces(snapshot, ['travel']).routes[1].kind, 'main')
})

// ---------------------------------------------------------------------------
// 5. 纯函数
// ---------------------------------------------------------------------------

test('不修改输入快照', () => {
  const snapshot = deepFreeze(demoSnapshot())
  assert.doesNotThrow(() => queryVisiblePlaces(snapshot, ['travel', 'want_to_go']))
})

test('相同输入两次调用产出 deepEqual 的结果', () => {
  assert.deepEqual(
    queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go']),
    queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go']),
  )
})

test('visibleLayerIds 是副本，改结果不会回写调用方的数组', () => {
  const visible: LayerId[] = ['travel']
  const result = queryVisiblePlaces(demoSnapshot(), visible)
  result.visibleLayerIds.push('want_to_go')
  assert.deepEqual(visible, ['travel'])
})

// ---------------------------------------------------------------------------
// 6. PR5：mapSubtypes、countryCode 与 FR-MR-5 合并
// ---------------------------------------------------------------------------

const wtgRvk = 'place:wtg:IS:reykjavik'
const wtgNuuk = 'place:wtg:GL:nuuk'
const wtgNorway = 'place:wtg:NO:norway'
const plannedNuuk = 'place:planned:p-nuuk'

/**
 * 按 app 的真实合并顺序（travel → want-to-go → planned）手写的一份小快照：
 * - 足迹：国家 is（flagCode 'is'）+ 城市 rvk（Reykjavik）
 * - 想去：城市 Reykjavik（IS，与足迹同键）、城市 Nuuk（GL）、国家 Norway（NO）
 * - planned：城市 Nuuk（GL，与想去同键）
 */
const layeredSnapshot = (): WorldGraphSnapshot => ({
  entities: [
    place(countryEntityId('is'), 'country', { zh: '冰岛', en: 'Iceland' }, { sourceId: 'is', accent: '#66c7a8', flagCode: 'is', cityIds: ['rvk'] }),
    place(cityEntityId('rvk'), 'city', { zh: '雷克雅未克', en: 'Reykjavik' }, { sourceId: 'rvk', countryId: 'is' }),
    place(wtgRvk, 'city', { zh: '雷克雅未克', en: 'Reykjavik' }, { countryCode: 'IS', source: 'want-to-go' }),
    place(wtgNuuk, 'city', { zh: '努克', en: 'Nuuk' }, { countryCode: 'GL', source: 'want-to-go' }),
    place(wtgNorway, 'country', { zh: '挪威', en: 'Norway' }, { countryCode: 'NO', source: 'want-to-go' }),
    place(plannedNuuk, 'city', { zh: '努克', en: 'Nuuk' }, { countryCode: 'gl', source: 'travel-map:planned', readOnly: true }),
  ],
  memberships: [
    member(countryEntityId('is'), 'travel'),
    member(cityEntityId('rvk'), 'travel'),
    member(wtgRvk, 'want_to_go', { hidden: false, source: 'want-to-go', note: '再去一次' }),
    member(wtgNuuk, 'want_to_go', { hidden: false, source: 'want-to-go', note: '格陵兰首府' }),
    member(wtgNorway, 'want_to_go', { hidden: false, source: 'want-to-go' }),
    member(plannedNuuk, 'want_to_go', { source: 'travel-map:planned', readOnly: true }),
  ],
  anchors: [
    location(countryEntityId('is'), 64.9, -18.6),
    location(cityEntityId('rvk'), 64.1466, -21.9426),
    location(wtgRvk, 64.1466, -21.9426),
    location(wtgNuuk, 64.18, -51.72),
    location(wtgNorway, 62, 10),
    location(plannedNuuk, 64.2, -51.7),
  ],
  relations: [
    relation('rel:part_of:rvk', 'part_of', cityEntityId('rvk'), countryEntityId('is')),
  ],
})

const entityIds = (result: { places: { entityId: EntityId }[] }): EntityId[] =>
  result.places.map((item) => item.entityId)

const placeByEntityId = (result: ReturnType<typeof queryVisiblePlaces>, entityId: EntityId) =>
  result.places.find((item) => item.entityId === entityId)

test('mapSubtypes：想去的国家地点进入 places，足迹的国家地点仍被排除', () => {
  const result = queryVisiblePlaces(layeredSnapshot(), ['travel', 'want_to_go'])
  assert.ok(entityIds(result).includes(wtgNorway), '想去允许 country（PRD Q5）')
  assert.equal(placeByEntityId(result, wtgNorway)?.subtype, 'country')
  assert.deepEqual(placeByEntityId(result, wtgNorway)?.layerIds, ['want_to_go'])
  assert.ok(!entityIds(result).includes(countryEntityId('is')), '足迹只画城市，国家中心点不画')
})

test('mapSubtypes：layerIds 只保留允许该 subtype 的图层', () => {
  // 一个同时在两层的国家 Entity：足迹不画国家，所以 layerIds 里只剩 want_to_go。
  const snapshot = layeredSnapshot()
  snapshot.memberships.push(member(countryEntityId('is'), 'want_to_go', { note: '整个冰岛' }))
  const result = queryVisiblePlaces(snapshot, ['travel', 'want_to_go'])
  const iceland = placeByEntityId(result, countryEntityId('is'))
  assert.deepEqual(iceland?.layerIds, ['want_to_go'])
  assert.deepEqual(iceland?.membershipMetadata, { want_to_go: { note: '整个冰岛' } })
  assert.equal(queryVisiblePlaces(snapshot, ['travel']).places.some((item) => item.subtype === 'country'), false)
})

test('countryCode：足迹城市取所属国家的 flagCode，其他地点取自身 countryCode，都转大写', () => {
  const result = queryVisiblePlaces(layeredSnapshot(), ['travel', 'want_to_go'])
  assert.equal(placeByEntityId(result, cityEntityId('rvk'))?.countryCode, 'IS', '来自国家 Entity 的 flagCode "is"')
  assert.equal(placeByEntityId(result, wtgNuuk)?.countryCode, 'GL', '来自自身 metadata.countryCode')
  assert.equal(placeByEntityId(result, wtgNorway)?.countryCode, 'NO')

  // planned 的 'gl' 被转大写后与想去 Nuuk 同键，已被合并掉；只开 planned 的来源时单独看它。
  const snapshot = layeredSnapshot()
  snapshot.memberships = snapshot.memberships.filter((item) => item.entityId !== wtgNuuk)
  assert.equal(placeByEntityId(queryVisiblePlaces(snapshot, ['want_to_go']), plannedNuuk)?.countryCode, 'GL')
})

test('countryCode：不是两位字母时不产出该键', () => {
  const snapshot = layeredSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === wtgNuuk ? { ...entity, metadata: { ...entity.metadata, countryCode: 'GRL' } } : entity,
  )
  const result = queryVisiblePlaces(snapshot, ['want_to_go'])
  assert.equal(placeByEntityId(result, wtgNuuk)?.countryCode, undefined)
  assert.equal('countryCode' in (placeByEntityId(result, wtgNuuk) ?? {}), false)
})

test('FR-MR-5：足迹可见时，同键的想去城市并入足迹地点', () => {
  const result = queryVisiblePlaces(layeredSnapshot(), ['travel', 'want_to_go'])
  assert.ok(!entityIds(result).includes(wtgRvk), '想去 Reykjavik 不再单独出现')

  const rvk = placeByEntityId(result, cityEntityId('rvk'))
  assert.deepEqual(rvk?.layerIds, ['travel', 'want_to_go'])
  assert.deepEqual(rvk?.mergedEntityIds, [wtgRvk])
  assert.deepEqual(rvk?.membershipMetadata, {
    want_to_go: { hidden: false, source: 'want-to-go', note: '再去一次' },
  })
  // 足迹那一侧的字段不变：sourceId 仍是城市 id（点击仍进入城市）、主色仍来自国家。
  assert.equal(rvk?.sourceId, 'rvk')
  assert.equal(rvk?.accent, '#66c7a8')
})

test('FR-MR-5：两层都有 membershipMetadata 时逐层合并，足迹已有的层不被覆盖', () => {
  const snapshot = layeredSnapshot()
  snapshot.memberships = snapshot.memberships.map((item) =>
    item.entityId === cityEntityId('rvk') ? { ...item, metadata: { hidden: false, source: 'travel' } } : item,
  )
  const rvk = placeByEntityId(queryVisiblePlaces(snapshot, ['travel', 'want_to_go']), cityEntityId('rvk'))
  assert.deepEqual(rvk?.membershipMetadata, {
    travel: { hidden: false, source: 'travel' },
    want_to_go: { hidden: false, source: 'want-to-go', note: '再去一次' },
  })
})

test('FR-MR-5：足迹不可见时不合并，想去地点单独出现且只有 want_to_go', () => {
  const result = queryVisiblePlaces(layeredSnapshot(), ['want_to_go'])
  const rvk = placeByEntityId(result, wtgRvk)
  assert.ok(rvk, '想去 Reykjavik 单独出现')
  assert.deepEqual(rvk?.layerIds, ['want_to_go'])
  assert.equal(rvk?.sourceId, wtgRvk, '没有 metadata.sourceId，sourceId 回落到 entityId')
  assert.equal(rvk?.mergedEntityIds, undefined)
  assert.ok(!entityIds(result).includes(cityEntityId('rvk')))
})

test('FR-MR-5：想去与 planned 同键时只留想去，planned 记进 mergedEntityIds', () => {
  const result = queryVisiblePlaces(layeredSnapshot(), ['travel', 'want_to_go'])
  assert.ok(!entityIds(result).includes(plannedNuuk))
  const nuuk = placeByEntityId(result, wtgNuuk)
  assert.deepEqual(nuuk?.mergedEntityIds, [plannedNuuk])
  assert.deepEqual(nuuk?.layerIds, ['want_to_go'])
  assert.deepEqual(
    entityIds(result),
    [cityEntityId('rvk'), wtgNuuk, wtgNorway],
    '合并后其余地点保持快照顺序',
  )
})

test('FR-MR-5：没有 countryCode 的地点不参与合并', () => {
  const snapshot = layeredSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === wtgRvk || entity.id === plannedNuuk
      ? { ...entity, metadata: { source: 'want-to-go' } }
      : entity,
  )
  const result = queryVisiblePlaces(snapshot, ['travel', 'want_to_go'])
  assert.ok(entityIds(result).includes(wtgRvk), '缺 countryCode 的想去 Reykjavik 仍单独出现')
  assert.ok(entityIds(result).includes(plannedNuuk), '缺 countryCode 的 planned Nuuk 仍单独出现')
  assert.deepEqual(placeByEntityId(result, cityEntityId('rvk'))?.layerIds, ['travel'])
  assert.equal(placeByEntityId(result, cityEntityId('rvk'))?.mergedEntityIds, undefined)
})

test('FR-MR-5：足迹城市的国家没有 flagCode 时也不合并', () => {
  const snapshot = layeredSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === countryEntityId('is')
      ? { ...entity, metadata: { sourceId: 'is', accent: '#66c7a8', cityIds: ['rvk'] } }
      : entity,
  )
  const result = queryVisiblePlaces(snapshot, ['travel', 'want_to_go'])
  assert.ok(entityIds(result).includes(wtgRvk))
  assert.deepEqual(placeByEntityId(result, cityEntityId('rvk'))?.layerIds, ['travel'])
})

test('FR-MR-5：隐藏的想去 membership 不进结果，也不参与合并', () => {
  const snapshot = layeredSnapshot()
  snapshot.memberships = snapshot.memberships.map((item) =>
    item.entityId === wtgRvk || item.entityId === wtgNuuk
      ? { ...item, metadata: { ...item.metadata, hidden: true } }
      : item,
  )
  const result = queryVisiblePlaces(snapshot, ['travel', 'want_to_go'])
  assert.ok(!entityIds(result).includes(wtgRvk))
  const rvk = placeByEntityId(result, cityEntityId('rvk'))
  assert.deepEqual(rvk?.layerIds, ['travel'], '隐藏的想去不会给足迹地点带上徽标')
  assert.equal(rvk?.mergedEntityIds, undefined)
  // 想去 Nuuk 隐藏后，同键的 planned Nuuk 不再被它吞掉，自己出现。
  assert.ok(!entityIds(result).includes(wtgNuuk))
  assert.ok(entityIds(result).includes(plannedNuuk))
})

test('FR-MR-5：国家地点不参与合并', () => {
  const snapshot = layeredSnapshot()
  // 一个与想去 Norway 同键的 planned 国家级地点：国家不合并，两个都在。
  snapshot.entities.push(place('place:planned:p-norway', 'country', { zh: '挪威', en: 'Norway' }, { countryCode: 'NO' }))
  snapshot.memberships.push(member('place:planned:p-norway', 'want_to_go', { readOnly: true }))
  snapshot.anchors.push(location('place:planned:p-norway', 61, 9))
  const result = queryVisiblePlaces(snapshot, ['want_to_go'])
  assert.ok(entityIds(result).includes(wtgNorway))
  assert.ok(entityIds(result).includes('place:planned:p-norway'))
})

test('FR-MR-5：合并不修改输入快照，两次调用结果 deepEqual', () => {
  const snapshot = deepFreeze(layeredSnapshot())
  assert.doesNotThrow(() => queryVisiblePlaces(snapshot, ['travel', 'want_to_go']))
  assert.deepEqual(
    queryVisiblePlaces(snapshot, ['travel', 'want_to_go']),
    queryVisiblePlaces(layeredSnapshot(), ['travel', 'want_to_go']),
  )
})

test('FR-MR-5：合并不影响路线（路线只来自足迹）', () => {
  const snapshot = layeredSnapshot()
  assert.deepEqual(
    queryVisiblePlaces(snapshot, ['travel', 'want_to_go']).routes,
    queryVisiblePlaces(snapshot, ['travel']).routes,
  )
})
