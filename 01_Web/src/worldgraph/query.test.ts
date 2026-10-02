/**
 * queryVisiblePlaces 的单元测试（PRD FR-LR-3 / FR-MR-1..FR-MR-5；RFC-LOC-1 Core 方案 C1、C4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 本文件的快照全部是手写的最小快照——目的是把查询规则本身钉死，而不是重复验证适配器
 * （那是 adapters/*.test.ts 的职责）。地点的实体 id 就是地点 id（C1），这里故意写成不透明的短字符串。
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
import type { City, Country } from '../types/travel.ts'
import { placeEntity, placesToWorldGraph, type PlaceInput } from './adapters/places.ts'
import { plannedRecordsToWorldGraph, type PlannedRecordInput } from './adapters/plannedRecords.ts'
import { journeyEntityId, travelToWorldGraph } from './adapters/travel.ts'
import { wantToGoToWorldGraph, type WantToGoInput } from './adapters/wantToGo.ts'
import { queryCollection } from './collection.ts'
import { queryVisiblePlaces } from './query.ts'
import { mergeWorldGraphSnapshots } from './snapshot.ts'

const UI = 'zh-Hans'

const NOW = '2026-09-20T00:00:00.000Z'

// ---------------------------------------------------------------------------
// 手写快照的小工具
// ---------------------------------------------------------------------------

const place = (
  id: EntityId,
  subtype: 'region' | 'country' | 'city',
  title: Entity['title'],
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
  title: { names: { 'zh-Hans': id } },
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
  recordId?: string,
): LayerMembership => {
  const membership: LayerMembership = { entityId, layerId, addedBy: 'rule', addedAt: NOW }
  if (recordId !== undefined) membership.recordId = recordId
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
 * 一份覆盖大部分规则的小快照（地点实体与 part_of 来自地点，足迹信息在足迹成员关系上）：
 * - 国家 c1（足迹成员关系 accent #111111、cityIds 顺序 a → b），国家 c2（#222222，cityIds z）
 * - 城市 a / b 属于 c1，都在 travel 层；a 另外还有一条想去记录 w-a
 * - 城市 z 属于国家 c2，用来造跨国段
 * - 行程 d1 / d2 到访 a，d3 到访 b，d4 到访 z（journeyId 都是 j1）
 */
const demoSnapshot = (): WorldGraphSnapshot => ({
  entities: [
    place('c1', 'country', { names: { 'zh-Hans': '国一' } }, { countryCode: 'AA' }),
    place('c2', 'country', { names: { 'zh-Hans': '国二' } }, { countryCode: 'BB' }),
    place('a', 'city', { names: { 'zh-Hans': '甲', en: 'Alpha' } }, { countryCode: 'AA' }),
    place('b', 'city', { names: { 'zh-Hans': '乙', en: 'Beta' } }, { countryCode: 'AA' }),
    place('z', 'city', { names: { 'zh-Hans': '丙', en: 'Zeta' } }, { countryCode: 'BB' }),
    journey(journeyEntityId('d1'), 'j1'),
    journey(journeyEntityId('d2'), 'j1'),
    journey(journeyEntityId('d3'), 'j1'),
    journey(journeyEntityId('d4'), 'j1'),
  ],
  memberships: [
    member('c1', 'travel', { accent: '#111111', cityIds: ['a', 'b'] }),
    member('c2', 'travel', { accent: '#222222', cityIds: ['z'] }),
    member('a', 'travel'),
    member('b', 'travel'),
    member('z', 'travel'),
    member(journeyEntityId('d1'), 'travel'),
    member(journeyEntityId('d2'), 'travel'),
    member(journeyEntityId('d3'), 'travel'),
    member(journeyEntityId('d4'), 'travel'),
    member('a', 'want_to_go', { note: '还想再去' }, 'w-a'),
  ],
  anchors: [
    location('c1', 10, 20),
    location('a', 1, 2),
    location('b', 3, 4),
    location('z', 5, 6),
  ],
  relations: [
    relation('rel:part_of:a', 'part_of', 'a', 'c1'),
    relation('rel:part_of:b', 'part_of', 'b', 'c1'),
    relation('rel:part_of:z', 'part_of', 'z', 'c2'),
    relation('rel:visited:d1', 'visited', journeyEntityId('d1'), 'a'),
    relation('rel:visited:d2', 'visited', journeyEntityId('d2'), 'a'),
    relation('rel:visited:d3', 'visited', journeyEntityId('d3'), 'b'),
    relation('rel:visited:d4', 'visited', journeyEntityId('d4'), 'z'),
    relation('rel:related_to:b__z', 'related_to', 'b', 'z', {
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

const entityIds = (result: { places: { entityId: EntityId }[] }): EntityId[] =>
  result.places.map((item) => item.entityId)

const placeByEntityId = (result: ReturnType<typeof queryVisiblePlaces>, entityId: EntityId) =>
  result.places.find((item) => item.entityId === entityId)

/** 把某个实体在某层的成员关系换成新的（测试里改 metadata 用）。 */
const withMembership = (
  snapshot: WorldGraphSnapshot,
  entityId: EntityId,
  layerId: LayerId,
  change: (membership: LayerMembership) => LayerMembership,
): WorldGraphSnapshot => ({
  ...snapshot,
  memberships: snapshot.memberships.map((item) => (item.entityId === entityId && item.layerId === layerId ? change(item) : item)),
})

// ---------------------------------------------------------------------------
// 1. 空快照与图层可见性
// ---------------------------------------------------------------------------

test('空快照产出空结果，visibleLayerIds 原样带出', () => {
  assert.deepEqual(queryVisiblePlaces(emptySnapshot(), ['travel']), { visibleLayerIds: ['travel'], places: [], routes: [] })
  assert.deepEqual(queryVisiblePlaces(emptySnapshot(), []), { visibleLayerIds: [], places: [], routes: [] })
})

test('没有任何图层可见时，places 与 routes 都为空', () => {
  const result = queryVisiblePlaces(demoSnapshot(), [])
  assert.deepEqual(result.places, [])
  assert.deepEqual(result.routes, [])
})

test('只开 travel：三个城市都在，layerIds 只有 travel', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(entityIds(result), ['a', 'b', 'z'])
  assert.deepEqual(result.places.map((item) => item.layerIds), [['travel'], ['travel'], ['travel']])
})

test('只开 want_to_go：只剩下有 want_to_go 成员关系的城市，且 routes 为空', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['want_to_go'])
  assert.deepEqual(entityIds(result), ['a'])
  assert.deepEqual(result.places[0].layerIds, ['want_to_go'])
  assert.deepEqual(result.routes, [], 'travel 不可见时不计算任何路线（FR-LR-3）')
})

test('两层都开：同一个 Entity 只出现一次，layerIds 合并并按 officialLayers.order 排序', () => {
  // 故意把 want_to_go 放在参数的前面，证明排序依据是 Registry 的 order 而不是参数顺序。
  const result = queryVisiblePlaces(demoSnapshot(), ['want_to_go', 'travel'])
  assert.deepEqual(entityIds(result), ['a', 'b', 'z'])
  assert.deepEqual(result.places[0].layerIds, ['travel', 'want_to_go'])
  assert.deepEqual(result.places[1].layerIds, ['travel'])
})

test('membership.metadata 按图层分别带出；没有 metadata 的层不出现', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go'])
  assert.deepEqual(result.places[0].membershipMetadata, { want_to_go: { note: '还想再去' } })
  assert.deepEqual(result.places[1].membershipMetadata, {}, '城市 b 的足迹成员关系没有 metadata')
})

test('metadata.hidden === true 的成员关系被排除（FR-TA-4）；hidden 为 false 或其他值不算隐藏', () => {
  const hidden = withMembership(demoSnapshot(), 'b', 'travel', (item) => ({ ...item, metadata: { hidden: true } }))
  assert.deepEqual(entityIds(queryVisiblePlaces(hidden, ['travel'])), ['a', 'z'])
  const shown = withMembership(demoSnapshot(), 'b', 'travel', (item) => ({ ...item, metadata: { hidden: false } }))
  assert.deepEqual(entityIds(queryVisiblePlaces(shown, ['travel'])), ['a', 'b', 'z'])
})

// ---------------------------------------------------------------------------
// 2. 哪些 Entity 能进 places
// ---------------------------------------------------------------------------

test('没有 location Anchor 的 place 不进结果（D06：Entity 本身合法，只是地图画不出）', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors = snapshot.anchors.filter((anchor) => anchor.entityId !== 'b')
  assert.deepEqual(entityIds(queryVisiblePlaces(snapshot, ['travel'])), ['a', 'z'])
})

test('坐标不是有限数（NaN / 缺一半）的 Anchor 不算有坐标；经纬度恰好为 0 是合法坐标', () => {
  const snapshot = demoSnapshot()
  snapshot.anchors = snapshot.anchors.map((anchor) => {
    if (anchor.entityId === 'a') return { ...anchor, lat: Number.NaN }
    if (anchor.entityId === 'b') return { ...anchor, lng: undefined }
    return anchor
  })
  assert.deepEqual(entityIds(queryVisiblePlaces(snapshot, ['travel'])), ['z'])

  const zero = demoSnapshot()
  zero.anchors = zero.anchors.map((anchor) => (anchor.entityId === 'a' ? { ...anchor, lat: 0, lng: 0 } : anchor))
  const [first] = queryVisiblePlaces(zero, ['travel']).places
  assert.deepEqual([first.lat, first.lng], [0, 0])
})

test('足迹图层里 country / region 的 place 不进 places（足迹只画城市标记）；journey 不进 places', () => {
  const snapshot = demoSnapshot()
  snapshot.entities.push(place('r1', 'region', { names: { 'zh-Hans': '某区' } }))
  snapshot.memberships.push(member('r1', 'travel'))
  snapshot.anchors.push(location('r1', 7, 8), location(journeyEntityId('d1'), 9, 9))

  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(entityIds(result), ['a', 'b', 'z'])
  assert.ok(result.places.every((item) => item.subtype === 'city'), 'places 里只能有 subtype === city')
})

test('没有任何可见成员关系的地点实体被排除（例如注册表里没被任何记录引用的地点）', () => {
  const snapshot = demoSnapshot()
  snapshot.memberships = snapshot.memberships.filter((membership) => membership.entityId !== 'z')
  assert.deepEqual(entityIds(queryVisiblePlaces(snapshot, ['travel'])), ['a', 'b'])
})

test('places 的顺序等于 Entity 在 snapshot.entities 里的顺序', () => {
  const snapshot = demoSnapshot()
  const cities = snapshot.entities.filter((entity) => entity.subtype === 'city')
  snapshot.entities = [...snapshot.entities.filter((entity) => entity.subtype !== 'city'), ...cities.reverse()]
  assert.deepEqual(entityIds(queryVisiblePlaces(snapshot, ['travel'])), ['z', 'b', 'a'])
})

// ---------------------------------------------------------------------------
// 3. 字段：title / sourceId / countryCode / recordIds / 足迹字段
// ---------------------------------------------------------------------------

test('逐字段投影一个 place：sourceId 等于 entityId，countryId 等于 countryEntityId（都是地点 id）', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go'])
  assert.deepEqual(result.places[0], {
    entityId: 'a',
    sourceId: 'a',
    subtype: 'city',
    title: { names: { 'zh-Hans': '甲', en: 'Alpha' } },
    lat: 1,
    lng: 2,
    layerIds: ['travel', 'want_to_go'],
    countryEntityId: 'c1',
    countryId: 'c1',
    countryCode: 'AA',
    recordIds: { want_to_go: ['w-a'] },
    accent: '#111111',
    visitCount: 2,
    membershipMetadata: { want_to_go: { note: '还想再去' } },
  })
})

test('title 没有英文名时不产出 en 键', () => {
  const snapshot = emptySnapshot()
  snapshot.entities.push(place('solo', 'city', { names: { 'zh-Hans': '只有中文' } }))
  snapshot.memberships.push(member('solo', 'travel'))
  snapshot.anchors.push(location('solo', 1, 1))
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel']).places[0].title, { names: { 'zh-Hans': '只有中文' } })
})

test('countryCode 取地点实体的 metadata.countryCode，转大写；不是两位字母时不产出该键', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) => {
    if (entity.id === 'b') return { ...entity, metadata: { countryCode: 'aa' } }
    if (entity.id === 'z') return { ...entity, metadata: { countryCode: 'BBB' } }
    return entity
  })
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.deepEqual(result.places.map((item) => item.countryCode), ['AA', 'AA', undefined])
  assert.equal('countryCode' in result.places[2], false)
})

test('visitCount 数的是指向本地点的 visited Relation 条数，没有则 0', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(result.places.map((item) => [item.entityId, item.visitCount]), [['a', 2], ['b', 1], ['z', 1]])

  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.filter((item) => item.type !== 'visited')
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel']).places.map((item) => item.visitCount), [0, 0, 0])
})

test('accent 优先取地点自己足迹成员关系的 accent，其次取所属国家足迹成员关系的；实体上的 accent 不读', () => {
  const snapshot = withMembership(demoSnapshot(), 'a', 'travel', (item) => ({ ...item, metadata: { accent: '#abcdef' } }))
  const result = queryVisiblePlaces(snapshot, ['travel'])
  assert.equal(result.places[0].accent, '#abcdef', '自身 accent 优先')
  assert.equal(result.places[1].accent, '#111111', '没有自身 accent 时取国家的')

  const onEntity = demoSnapshot()
  onEntity.entities = onEntity.entities.map((entity) => (entity.id === 'b' ? { ...entity, metadata: { accent: '#000000' } } : entity))
  assert.equal(queryVisiblePlaces(onEntity, ['travel']).places[1].accent, '#111111')
})

test('没有 part_of 时不产出 countryEntityId / countryId / accent', () => {
  const snapshot = demoSnapshot()
  snapshot.relations = snapshot.relations.filter((item) => item.type !== 'part_of')
  const [first] = queryVisiblePlaces(snapshot, ['travel']).places
  assert.equal(first.countryEntityId, undefined)
  assert.equal(first.countryId, undefined)
  assert.equal(first.accent, undefined)
})

test('足迹字段只在地点出现在足迹层时给出：只开想去时同一个实体 visitCount 为 0，没有 countryEntityId / countryId / accent', () => {
  const [onlyWantToGo] = queryVisiblePlaces(demoSnapshot(), ['want_to_go']).places
  assert.deepEqual(onlyWantToGo, {
    entityId: 'a',
    sourceId: 'a',
    subtype: 'city',
    title: { names: { 'zh-Hans': '甲', en: 'Alpha' } },
    lat: 1,
    lng: 2,
    layerIds: ['want_to_go'],
    countryCode: 'AA',
    recordIds: { want_to_go: ['w-a'] },
    visitCount: 0,
    membershipMetadata: { want_to_go: { note: '还想再去' } },
  })
})

// ---------------------------------------------------------------------------
// 4. routes
// ---------------------------------------------------------------------------

/** 改国家 c1 足迹成员关系上的 cityIds。 */
const withCountryCityIds = (snapshot: WorldGraphSnapshot, cityIds: string[]): WorldGraphSnapshot =>
  withMembership(snapshot, 'c1', 'travel', (item) => ({ ...item, metadata: { ...item.metadata, cityIds } }))

test('travel 不可见时 routes 恒为空（FR-LR-3）', () => {
  assert.deepEqual(queryVisiblePlaces(demoSnapshot(), ['want_to_go']).routes, [])
  assert.deepEqual(queryVisiblePlaces(demoSnapshot(), []).routes, [])
  assert.ok(queryVisiblePlaces(demoSnapshot(), ['travel']).routes.length > 0)
})

test('国家内顺序段：没有 related_to 时用 country-order id + 两端共享的 journeyId', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(result.routes[0], {
    id: 'country-order__c1__a__b',
    fromEntityId: 'a',
    toEntityId: 'b',
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
  snapshot.relations.push(relation('rel:related_to:a__b', 'related_to', 'a', 'b', { kind: 'ferry', routeId: 'r-a-b', journeyId: 'j9' }))
  const [first] = queryVisiblePlaces(snapshot, ['travel']).routes
  assert.deepEqual([first.id, first.journeyId, first.kind], ['r-a-b', 'j9', 'ferry'])
})

test('国家内顺序段：related_to 缺 journeyId 时退回两端共享的 journeyId', () => {
  const snapshot = demoSnapshot()
  snapshot.relations.push(relation('rel:related_to:a__b', 'related_to', 'a', 'b', { kind: 'drive', routeId: 'r-a-b' }))
  const [first] = queryVisiblePlaces(snapshot, ['travel']).routes
  assert.deepEqual([first.id, first.kind], ['r-a-b', 'drive'])
  assert.equal(first.journeyId, 'j1', '共享 journeyId 由两端的 visited 关系推断')
})

test('国家内顺序段：两端没有共享 journeyId 时整段被丢弃', () => {
  const snapshot = demoSnapshot()
  snapshot.entities = snapshot.entities.map((entity) =>
    entity.id === journeyEntityId('d3') ? { ...entity, metadata: { journeyId: 'j2' } } : entity,
  )
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel']).routes.map((route) => route.id), ['r-b-z'], 'a→b 段没有共享 journeyId，只剩跨国段')
})

test('国家内顺序段：cityIds 里有一端不在快照里时跳过该段', () => {
  const snapshot = withCountryCityIds(demoSnapshot(), ['a', 'missing', 'b'])
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel']).routes.map((route) => route.id), ['r-b-z'])
})

test('国家内顺序段只取相邻两两，三个城市产出两段', () => {
  const snapshot = withCountryCityIds(demoSnapshot(), ['a', 'b', 'z'])
  assert.deepEqual(
    queryVisiblePlaces(snapshot, ['travel']).routes.map((route) => [route.fromSourceId, route.toSourceId]),
    [['a', 'b'], ['b', 'z'], ['b', 'z']],
    '顺序段两条在前，跨国段在后（b→z 同时满足两种规则，与 PR3 之前的行为一致）',
  )
})

test('国家内顺序段按国家足迹成员关系的顺序遍历，不看实体顺序；实体上的 cityIds 不读', () => {
  const snapshot = withCountryCityIds(demoSnapshot(), ['a', 'b', 'z'])
  // 把 c2 的足迹成员关系挪到 c1 前面：c2 只有一个城市，不出段；c1 的段仍在跨国段之前。
  snapshot.memberships = [...snapshot.memberships.filter((item) => item.entityId === 'c2'), ...snapshot.memberships.filter((item) => item.entityId !== 'c2')]
  snapshot.entities = snapshot.entities.map((entity) => (entity.id === 'c2' ? { ...entity, metadata: { cityIds: ['z', 'a'] } } : entity))
  assert.deepEqual(
    queryVisiblePlaces(snapshot, ['travel']).routes.map((route) => route.id),
    ['country-order__c1__a__b', 'r-b-z', 'r-b-z'],
  )
})

test('跨国段：两端国家不同的 related_to 直接成段', () => {
  const result = queryVisiblePlaces(demoSnapshot(), ['travel'])
  assert.deepEqual(result.routes[1], {
    id: 'r-b-z',
    fromEntityId: 'b',
    toEntityId: 'z',
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
    item.id === 'rel:related_to:b__z' ? relation(item.id, 'related_to', 'a', 'b', item.metadata) : item,
  )
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel']).routes.map((route) => route.id), ['r-b-z'], '只剩被它覆盖过的顺序段')
})

test('缺 journeyId 的段、任一端没有 location Anchor 的段被丢弃；未知的 kind 回落成 main', () => {
  const noJourney = demoSnapshot()
  noJourney.relations = noJourney.relations.map((item) =>
    item.id === 'rel:related_to:b__z' ? relation(item.id, 'related_to', item.fromEntityId, item.toEntityId, { kind: 'flight', routeId: 'r-b-z' }) : item,
  )
  assert.deepEqual(queryVisiblePlaces(noJourney, ['travel']).routes.map((route) => route.id), ['country-order__c1__a__b'])

  const noAnchor = demoSnapshot()
  noAnchor.anchors = noAnchor.anchors.filter((anchor) => anchor.entityId !== 'z')
  assert.deepEqual(queryVisiblePlaces(noAnchor, ['travel']).routes.map((route) => route.id), ['country-order__c1__a__b'])

  const unknownKind = demoSnapshot()
  unknownKind.relations = unknownKind.relations.map((item) =>
    item.id === 'rel:related_to:b__z' ? relation(item.id, 'related_to', item.fromEntityId, item.toEntityId, { kind: 'teleport', routeId: 'r-b-z', journeyId: 'j1' }) : item,
  )
  assert.equal(queryVisiblePlaces(unknownKind, ['travel']).routes[1].kind, 'main')
})

// ---------------------------------------------------------------------------
// 5. 纯函数
// ---------------------------------------------------------------------------

test('不修改输入快照；相同输入两次调用产出 deepEqual 的结果', () => {
  const snapshot = deepFreeze(demoSnapshot())
  assert.doesNotThrow(() => queryVisiblePlaces(snapshot, ['travel', 'want_to_go']))
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel', 'want_to_go']), queryVisiblePlaces(demoSnapshot(), ['travel', 'want_to_go']))
})

test('visibleLayerIds 与 recordIds 是副本，改结果不会回写调用方', () => {
  const visible: LayerId[] = ['travel', 'want_to_go']
  const snapshot = demoSnapshot()
  const result = queryVisiblePlaces(snapshot, visible)
  result.visibleLayerIds.push('travel')
  result.places[0].recordIds?.want_to_go?.push('mutated')
  assert.deepEqual(visible, ['travel', 'want_to_go'])
  assert.deepEqual(queryVisiblePlaces(snapshot, visible).places[0].recordIds, { want_to_go: ['w-a'] })
})

// ---------------------------------------------------------------------------
// 6. FR-MR-5 按身份合并（Core 方案 C4），用真实的四个适配器拼快照
// ---------------------------------------------------------------------------

/**
 * 按 App 的真实合并顺序（places → travel → want-to-go → planned）拼一份小快照：
 * - 注册表：国家 冰岛 p-is、格陵兰 p-gl、挪威 p-no；城市 雷克雅未克 p-rvk（属 p-is）、努克 p-nuuk（属 p-gl）
 * - 足迹：国家 p-is（accent、cityIds）、城市 p-rvk
 * - 想去：w-rvk → p-rvk（与足迹同一地点）、w-nuuk → p-nuuk、w-no → p-no（整个国家）
 * - planned：pl-nuuk → p-nuuk（与想去同一地点）
 */
const PLACES: PlaceInput[] = [
  { id: 'p-is', subtype: 'country', title: { names: { 'zh-Hans': '冰岛', en: 'Iceland' } }, countryCode: 'IS', location: { lat: 64.9, lng: -18.6 } },
  { id: 'p-gl', subtype: 'country', title: { names: { 'zh-Hans': '格陵兰', en: 'Greenland' } }, countryCode: 'GL', location: { lat: 71.7, lng: -42.6 } },
  { id: 'p-no', subtype: 'country', title: { names: { 'zh-Hans': '挪威', en: 'Norway' } }, countryCode: 'NO', location: { lat: 62, lng: 10 } },
  { id: 'p-rvk', subtype: 'city', title: { names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' } }, countryCode: 'IS', partOf: 'p-is', location: { lat: 64.1466, lng: -21.9426 } },
  { id: 'p-nuuk', subtype: 'city', title: { names: { 'zh-Hans': '努克', en: 'Nuuk' } }, countryCode: 'GL', partOf: 'p-gl', location: { lat: 64.18, lng: -51.72 } },
]

const ICELAND: Country = {
  id: 'p-is', nameZh: '冰岛', nameEn: 'Iceland', centerLat: 64.9, centerLng: -18.6, visitedDateRange: '', summary: '', memory: '',
  cityIds: ['p-rvk'], accent: '#66c7a8',
}
const REYKJAVIK: City = { id: 'p-rvk', nameZh: '雷克雅未克', nameEn: 'Reykjavik', countryId: 'p-is', lat: 64.1466, lng: -21.9426 }

const WANT_TO_GO: WantToGoInput[] = [
  { id: 'w-rvk', placeId: 'p-rvk', addedAt: '2026-08-01', hidden: false, note: '再去一次' },
  { id: 'w-nuuk', placeId: 'p-nuuk', addedAt: '2026-08-02', hidden: false, note: '格陵兰首府' },
  { id: 'w-no', placeId: 'p-no', addedAt: '2026-08-03', hidden: false },
]
const PLANNED: PlannedRecordInput[] = [{ id: 'pl-nuuk', placeId: 'p-nuuk', start_date: '2027-06-01' }]

const layeredSnapshot = (
  wantToGo: WantToGoInput[] = WANT_TO_GO,
  planned: PlannedRecordInput[] = PLANNED,
  places: PlaceInput[] = PLACES,
): WorldGraphSnapshot => mergeWorldGraphSnapshots(
  placesToWorldGraph(places, { now: NOW }),
  travelToWorldGraph({ countries: [ICELAND], cities: [REYKJAVIK] }, { now: NOW }),
  wantToGoToWorldGraph(wantToGo),
  plannedRecordsToWorldGraph(planned),
)

test('Core 方案 C2：同一地点被足迹、想去、planned 三个适配器引用时，快照里只有一个实体，就是 places 适配器构造的那个', () => {
  const snapshot = layeredSnapshot(WANT_TO_GO, [...PLANNED, { id: 'pl-rvk', placeId: 'p-rvk', start_date: '2027-07-01' }])
  const reykjavik = snapshot.entities.filter((entity) => entity.id === 'p-rvk')
  assert.deepEqual(reykjavik, [placeEntity(PLACES[3], NOW)])
  assert.deepEqual(
    snapshot.memberships.filter((membership) => membership.entityId === 'p-rvk').map((membership) => [membership.layerId, membership.recordId]),
    [['travel', undefined], ['want_to_go', 'w-rvk'], ['want_to_go', 'pl-rvk']],
  )
  assert.equal(new Set(snapshot.entities.map((entity) => entity.id)).size, snapshot.entities.length, '实体 id 唯一')
})

test('FR-MR-5：同一地点的足迹与想去是同一个实体的两条成员关系，两层都开时画一个标记，带心形徽标（layerIds 两层）', () => {
  const result = queryVisiblePlaces(layeredSnapshot(), ['travel', 'want_to_go'])
  assert.deepEqual(entityIds(result), ['p-no', 'p-rvk', 'p-nuuk'], '国家 p-is 只在足迹层，不画；其余按快照顺序')
  assert.deepEqual(placeByEntityId(result, 'p-rvk'), {
    entityId: 'p-rvk',
    sourceId: 'p-rvk',
    subtype: 'city',
    title: { names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' } },
    lat: 64.1466,
    lng: -21.9426,
    layerIds: ['travel', 'want_to_go'],
    countryEntityId: 'p-is',
    countryId: 'p-is',
    countryCode: 'IS',
    recordIds: { want_to_go: ['w-rvk'] },
    accent: '#66c7a8',
    visitCount: 0,
    membershipMetadata: { want_to_go: { hidden: false, source: 'want-to-go', note: '再去一次' } },
  })
})

test('FR-MR-5：关掉足迹，同一个实体按想去样式出现（实体 id 不变）；关掉想去，只剩足迹样式', () => {
  const wantToGoOnly = placeByEntityId(queryVisiblePlaces(layeredSnapshot(), ['want_to_go']), 'p-rvk')
  assert.deepEqual(wantToGoOnly?.layerIds, ['want_to_go'])
  assert.equal(wantToGoOnly?.accent, undefined)
  assert.equal(wantToGoOnly?.countryEntityId, undefined)

  const travelOnly = placeByEntityId(queryVisiblePlaces(layeredSnapshot(), ['travel']), 'p-rvk')
  assert.deepEqual(travelOnly?.layerIds, ['travel'])
  assert.equal(travelOnly?.recordIds, undefined, '足迹层没有记录 id')
  assert.deepEqual(travelOnly?.membershipMetadata, {})
})

test('隐藏的想去记录不进结果：足迹地点不会因此带上徽标', () => {
  const hidden = WANT_TO_GO.map((item) => (item.id === 'w-rvk' ? { ...item, hidden: true } : item))
  const rvk = placeByEntityId(queryVisiblePlaces(layeredSnapshot(hidden), ['travel', 'want_to_go']), 'p-rvk')
  assert.deepEqual(rvk?.layerIds, ['travel'])
  assert.equal(rvk?.recordIds, undefined)
})

test('已接受的差异 1：同一地点有多条想去 / planned 记录时地图只画一个标记，recordIds 按快照顺序列出可见记录；Collection 仍逐条列出', () => {
  const wantToGo = [...WANT_TO_GO, { id: 'w-nuuk-2', placeId: 'p-nuuk', addedAt: '2026-08-04', hidden: false }]
  const snapshot = layeredSnapshot(wantToGo)
  const result = queryVisiblePlaces(snapshot, ['travel', 'want_to_go'])
  assert.equal(result.places.filter((item) => item.entityId === 'p-nuuk').length, 1)
  const nuuk = placeByEntityId(result, 'p-nuuk')
  assert.deepEqual(nuuk?.recordIds, { want_to_go: ['w-nuuk', 'w-nuuk-2', 'pl-nuuk'] }, '想去在前（快照顺序），planned 在后')
  assert.deepEqual(nuuk?.membershipMetadata, { want_to_go: { hidden: false, source: 'want-to-go', note: '格陵兰首府' } }, '取第一条可见记录的 metadata')

  const rows = queryCollection(snapshot, 'want_to_go', UI).filter((entry) => entry.entityId === 'p-nuuk')
  assert.deepEqual(rows.map((entry) => entry.recordId).sort(), ['pl-nuuk', 'w-nuuk', 'w-nuuk-2'])
})

test('同一地点的第一条想去记录被隐藏时，membershipMetadata 取下一条可见记录（想去优先于 planned）', () => {
  const wantToGo = WANT_TO_GO.map((item) => (item.id === 'w-nuuk' ? { ...item, hidden: true } : item))
  const nuuk = placeByEntityId(queryVisiblePlaces(layeredSnapshot(wantToGo), ['want_to_go']), 'p-nuuk')
  assert.deepEqual(nuuk?.recordIds, { want_to_go: ['pl-nuuk'] })
  assert.deepEqual(nuuk?.membershipMetadata, { want_to_go: { source: 'travel-map:planned', readOnly: true } })
})

test('已接受的差异 2：名字相同但不是同一地点的城市不再合并，各自一个标记', () => {
  const places: PlaceInput[] = [
    ...PLACES,
    { id: 'p-rvk-other', subtype: 'city', title: { names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' } }, countryCode: 'IS', partOf: 'p-is', location: { lat: 64.15, lng: -21.95 } },
  ]
  const wantToGo = WANT_TO_GO.map((item) => (item.id === 'w-rvk' ? { ...item, placeId: 'p-rvk-other' } : item))
  const result = queryVisiblePlaces(layeredSnapshot(wantToGo, PLANNED, places), ['travel', 'want_to_go'])
  assert.deepEqual(placeByEntityId(result, 'p-rvk')?.layerIds, ['travel'])
  assert.deepEqual(placeByEntityId(result, 'p-rvk-other')?.layerIds, ['want_to_go'])
})

test('planned 记录的标记画在地点的规范坐标上（记录自带的坐标是记录级数据，地图不使用，RFC §3.2）', () => {
  // planned 适配器的输入里根本没有坐标：标记位置只能来自地点 p-nuuk 的锚点。
  const nuuk = placeByEntityId(queryVisiblePlaces(layeredSnapshot([]), ['want_to_go']), 'p-nuuk')
  assert.deepEqual([nuuk?.lat, nuuk?.lng, nuuk?.recordIds], [64.18, -51.72, { want_to_go: ['pl-nuuk'] }])
})

test('想去的国家地点进入 places；同一国家同时是足迹国家时，足迹层不画国家，layerIds 只有 want_to_go', () => {
  const wantToGo = [...WANT_TO_GO, { id: 'w-is', placeId: 'p-is', addedAt: '2026-08-05', hidden: false, note: '整个冰岛' }]
  const result = queryVisiblePlaces(layeredSnapshot(wantToGo), ['travel', 'want_to_go'])
  assert.deepEqual(placeByEntityId(result, 'p-no')?.layerIds, ['want_to_go'])
  const iceland = placeByEntityId(result, 'p-is')
  assert.deepEqual(iceland?.layerIds, ['want_to_go'])
  assert.deepEqual(iceland?.membershipMetadata, { want_to_go: { hidden: false, source: 'want-to-go', note: '整个冰岛' } })
  assert.equal(iceland?.accent, undefined, '不在足迹层：足迹字段不给出')
  assert.equal(queryVisiblePlaces(layeredSnapshot(wantToGo), ['travel']).places.some((item) => item.subtype === 'country'), false)
})

test('按身份合并不修改输入快照，不影响路线（路线只来自足迹）', () => {
  const snapshot = deepFreeze(layeredSnapshot())
  assert.doesNotThrow(() => queryVisiblePlaces(snapshot, ['travel', 'want_to_go']))
  assert.deepEqual(queryVisiblePlaces(snapshot, ['travel', 'want_to_go']).routes, queryVisiblePlaces(snapshot, ['travel']).routes)
})
