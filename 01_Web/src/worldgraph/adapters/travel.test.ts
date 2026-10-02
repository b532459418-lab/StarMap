/**
 * travelToWorldGraph 的单元测试（PRD FR-TA-4；RFC-LOC-1 Core 方案 C1、C2）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 为什么 fixture 是手写的、而不是 import travelAtlas.ts：
 * travelAtlas.ts import 了 Vite 虚拟模块 'virtual:starmap-private-data'，并读 import.meta.env。
 * 这两样在 Vite 之外都无法解析，node --test 直接崩。所以 fixture 是手写的足迹领域对象（./travel.fixture.ts，
 * 原是旧格式样例的已知派生结果；RFC-LOC-1 Core-A 退役了那份旧格式样例与钉住它的测试，fixture 冻结为静态数据）。
 *
 * Core-A 起地点实体、位置锚点与 part_of 由 ./places.ts 构造（./places.test.ts），本适配器只产出足迹层的成员关系、
 * 行程日与关系；本文件的「与地点快照合并」一节核对两者拼起来自洽。
 *
 * 下面这行 reference 不能删：tsconfig.app.json 的 types 是 ["vite/client"]，不含 "node"。
 * 没有它，node:test / node:assert/strict 的类型只能靠一条脆弱的传递链解析
 * （src/data/droneMetadata.ts import 的 exifr，其 index.d.ts 第一行有 /// <reference types="node" />）。
 * 那条链一断，TS2307 会报在【本文件】上，而真因在别处，极难排查。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Country, Route } from '../../types/travel.ts'
import type { Entity, LayerMembership, Relation } from '../types.ts'
import { mergeWorldGraphSnapshots } from '../snapshot.ts'
import { placesToWorldGraph } from './places.ts'
import {
  anchorId,
  journeyEntityId,
  relationId,
  sourcedRelationId,
  travelToWorldGraph,
} from './travel.ts'
import {
  JOURNEY_ID,
  sampleCities,
  sampleCountries,
  sampleInput,
  samplePlaces,
  sampleRoutes,
} from './travel.fixture.ts'

/** 固定时间戳：不传它输出就不可 deepEqual。 */
const NOW = '2026-09-20T00:00:00.000Z'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const entityById = (entities: Entity[], id: string): Entity => {
  const found = entities.find((entity) => entity.id === id)
  assert.ok(found, `找不到 Entity ${id}`)
  return found
}

const membershipOf = (memberships: LayerMembership[], entityId: string): LayerMembership => {
  const found = memberships.find((membership) => membership.entityId === entityId)
  assert.ok(found, `找不到 ${entityId} 的 membership`)
  return found
}

const relationById = (relations: Relation[], id: string): Relation => {
  const found = relations.find((relation) => relation.id === id)
  assert.ok(found, `找不到 Relation ${id}`)
  return found
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

const ICELAND_CITY_IDS = ['iceland__reykjavik', 'iceland__vik', 'iceland__akureyri']

// ---------------------------------------------------------------------------
// 1. 空输入
// ---------------------------------------------------------------------------

test('空输入产出一个四个数组都为空的快照', () => {
  assert.deepEqual(travelToWorldGraph({}, { now: NOW }), {
    entities: [],
    memberships: [],
    anchors: [],
    relations: [],
  })

  assert.deepEqual(
    travelToWorldGraph({ countries: [], cities: [], journeyDays: [], routes: [] }, { now: NOW }),
    { entities: [], memberships: [], anchors: [], relations: [] },
  )
})

test('只有 routes 没有 cities 时不产出悬空 Relation', () => {
  const snapshot = travelToWorldGraph({ routes: sampleRoutes() }, { now: NOW })
  assert.deepEqual(snapshot.entities, [])
  assert.deepEqual(snapshot.relations, [])
})

// ---------------------------------------------------------------------------
// 2. 样例数据的真实断言
// ---------------------------------------------------------------------------

test('样例数据产出 5 个 Entity（行程日）/ 12 个 Membership / 5 个 Anchor（时间）/ 9 个 Relation', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })

  assert.equal(snapshot.entities.length, 5)
  assert.equal(snapshot.memberships.length, 12)
  assert.equal(snapshot.anchors.length, 5)
  assert.equal(snapshot.relations.length, 9)

  assert.ok(snapshot.entities.every((entity) => entity.type === 'journey'))
  assert.ok(snapshot.anchors.every((anchor) => anchor.kind === 'time'))
  assert.equal(snapshot.relations.filter((relation) => relation.type === 'visited').length, 5)
  assert.equal(snapshot.relations.filter((relation) => relation.type === 'related_to').length, 4)
})

test('Core 方案 C2：不产出地点实体、地点的位置锚点与 part_of（它们由 places 适配器构造）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  assert.equal(snapshot.entities.filter((entity) => entity.type === 'place').length, 0)
  assert.equal(snapshot.anchors.filter((anchor) => anchor.kind === 'location').length, 0)
  assert.equal(snapshot.relations.filter((relation) => relation.type === 'part_of').length, 0)
})

test('样例数据：国家与城市的成员关系以地点 id 为 entityId；查询要读的 accent 与 cityIds 在国家的成员关系上', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })

  assert.deepEqual(
    snapshot.memberships.slice(0, 7).map((membership) => membership.entityId),
    ['iceland', 'faroe-islands', ...ICELAND_CITY_IDS, 'faroe-islands__torshavn', 'faroe-islands__gjogv'],
  )
  assert.deepEqual(membershipOf(snapshot.memberships, 'iceland'), {
    entityId: 'iceland',
    layerId: 'travel',
    addedBy: 'rule',
    addedAt: NOW,
    metadata: { accent: '#66c7a8', cityIds: ICELAND_CITY_IDS },
  })
  // 样例城市没有自己的 accent：成员关系上没有 metadata 这个键。
  assert.deepEqual(membershipOf(snapshot.memberships, 'iceland__reykjavik'), {
    entityId: 'iceland__reykjavik',
    layerId: 'travel',
    addedBy: 'rule',
    addedAt: NOW,
  })
})

test('样例数据：sample_gjogv 的 journey Entity / time Anchor / visited Relation 逐字段正确', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const id = journeyEntityId('sample_gjogv')
  assert.equal(id, 'journey:sample_gjogv')

  assert.deepEqual(entityById(snapshot.entities, id), {
    id: 'journey:sample_gjogv',
    type: 'journey',
    // journey 没有 subtype——subtype 是 place 专用。
    title: { zh: '2025 North Atlantic Demo' },
    metadata: {
      sourceId: 'sample_gjogv',
      journeyId: '2025-north-atlantic-demo',
      countryId: 'faroe-islands',
      cityId: 'faroe-islands__gjogv',
      date: '2025-06-08',
      isHighlight: true,
    },
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
    summary: 'Gjogv, 2025-06-08',
  })

  assert.deepEqual(snapshot.anchors.filter((anchor) => anchor.entityId === id), [
    {
      id: 'anchor:time:journey:sample_gjogv',
      entityId: 'journey:sample_gjogv',
      kind: 'time',
      occurredAt: '2025-06-08',
      precision: 'exact',
    },
  ])

  assert.deepEqual(relationById(snapshot.relations, 'rel:visited:journey:sample_gjogv:faroe-islands__gjogv'), {
    id: 'rel:visited:journey:sample_gjogv:faroe-islands__gjogv',
    fromEntityId: 'journey:sample_gjogv',
    toEntityId: 'faroe-islands__gjogv',
    type: 'visited',
    provenance: 'rule',
  })
})

test('样例数据：Route 变成 related_to，两端是城市的地点 id，metadata 保留 kind / routeId / journeyId', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const related = snapshot.relations.filter((relation) => relation.type === 'related_to')

  assert.deepEqual(
    related.map((relation) => relation.metadata?.kind),
    ['main', 'main', 'flight', 'main'],
  )

  // 跨国那一段（Akureyri → Torshavn）是唯一的 flight。
  const flightRouteId = `${JOURNEY_ID}__sample_akureyri__sample_torshavn`
  assert.deepEqual(
    relationById(snapshot.relations, `rel:related_to:${flightRouteId}`),
    {
      id: `rel:related_to:${flightRouteId}`,
      fromEntityId: 'iceland__akureyri',
      toEntityId: 'faroe-islands__torshavn',
      type: 'related_to',
      provenance: 'rule',
      metadata: { kind: 'flight', routeId: flightRouteId, journeyId: JOURNEY_ID },
    },
  )
})

test('同一对城市之间的多条 Route 各自产出一条 Relation，不会被去重吞掉', () => {
  // Route 是按 journey 逐段生成的，同一对城市在两次旅行里各走一遍是完全正常的。若 Relation id 只由端点拼成，
  // 第二条会被静默丢弃且无法恢复——这正是本测试要挡住的回归。
  const snapshot = travelToWorldGraph(
    {
      cities: sampleCities().slice(0, 2),
      routes: [
        { id: 'trip-a__leg-1', fromCityId: 'iceland__reykjavik', toCityId: 'iceland__vik', journeyId: 'trip-a', type: 'main' },
        { id: 'trip-b__leg-1', fromCityId: 'iceland__reykjavik', toCityId: 'iceland__vik', journeyId: 'trip-b', type: 'drive' },
      ],
    },
    { now: NOW },
  )

  const related = snapshot.relations.filter((relation) => relation.type === 'related_to')
  assert.deepEqual(related.map((relation) => relation.id), ['rel:related_to:trip-a__leg-1', 'rel:related_to:trip-b__leg-1'])
  assert.deepEqual(related.map((relation) => relation.metadata?.journeyId), ['trip-a', 'trip-b'])
})

test('Route.id 相同的两条 Route 仍然只产出一条 Relation（按来源 id 去重，先到先得）', () => {
  const route: Route = { id: 'trip-a__leg-1', fromCityId: 'iceland__reykjavik', toCityId: 'iceland__vik', journeyId: 'trip-a', type: 'main' }
  const snapshot = travelToWorldGraph({ cities: sampleCities().slice(0, 2), routes: [route, { ...route, type: 'ferry' }] }, { now: NOW })

  const related = snapshot.relations.filter((relation) => relation.type === 'related_to')
  assert.equal(related.length, 1)
  assert.equal(related[0].metadata?.kind, 'main')
})

test('缺少 journeyId 的 Route 不会在 metadata 里留下 undefined 键', () => {
  const snapshot = travelToWorldGraph(
    { cities: sampleCities().slice(0, 2), routes: [{ id: 'loose-leg', fromCityId: 'iceland__reykjavik', toCityId: 'iceland__vik', type: 'main' }] },
    { now: NOW },
  )
  assert.deepEqual(snapshot.relations.map((relation) => relation.metadata), [{ kind: 'main', routeId: 'loose-leg' }])
})

test('Route 或行程日的城市端不在输入的城市里（包括写成了国家 id）时不产出关系；自环 Route 不产出', () => {
  const snapshot = travelToWorldGraph(
    {
      countries: sampleCountries(),
      cities: sampleCities().slice(0, 1),
      journeyDays: [
        { id: 'orphan-day', date: '2025-06-01', cityId: 'nowhere__city', title: '孤儿行程', journeyId: 'trip-a' },
        { id: 'country-day', date: '2025-06-02', cityId: 'iceland', title: '国家', journeyId: 'trip-a' },
      ],
      routes: [
        { id: 'self-loop', fromCityId: 'iceland__reykjavik', toCityId: 'iceland__reykjavik', journeyId: 'trip-a', type: 'main' },
        { id: 'to-country', fromCityId: 'iceland__reykjavik', toCityId: 'iceland', journeyId: 'trip-a', type: 'main' },
      ],
    },
    { now: NOW },
  )

  assert.deepEqual(snapshot.relations, [])
  // 行程日实体与时间锚点仍在。
  assert.deepEqual(snapshot.entities.map((entity) => entity.id), [journeyEntityId('orphan-day'), journeyEntityId('country-day')])
  assert.equal(snapshot.anchors.length, 2)
})

// ---------------------------------------------------------------------------
// 3. 隐藏项（FR-TA-4）与成员关系的 metadata
// ---------------------------------------------------------------------------

test('隐藏的国家仍产出成员关系，metadata.hidden = true；它的城市与行程一并标记（FR-TA-4）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW, hiddenCountryIds: ['iceland'] })

  // 数量不变——隐藏不是过滤。
  assert.equal(snapshot.memberships.length, 12)
  assert.equal(snapshot.entities.length, 5)

  const hidden = membershipOf(snapshot.memberships, 'iceland')
  assert.deepEqual(hidden.metadata, { accent: '#66c7a8', cityIds: ICELAND_CITY_IDS, hidden: true })
  assert.equal(hidden.addedBy, 'rule')
  assert.equal(hidden.layerId, 'travel')

  assert.equal(membershipOf(snapshot.memberships, 'faroe-islands').metadata?.hidden, undefined)
  assert.deepEqual(membershipOf(snapshot.memberships, 'iceland__vik').metadata, { hidden: true })
  assert.deepEqual(membershipOf(snapshot.memberships, journeyEntityId('sample_vik')).metadata, { hidden: true })
  assert.equal(membershipOf(snapshot.memberships, 'faroe-islands__gjogv').metadata, undefined)
})

test('隐藏单个城市只影响该城市与它的行程，不影响所属国家；被隐藏的城市仍有关系', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW, hiddenCityIds: ['faroe-islands__gjogv'] })

  assert.deepEqual(membershipOf(snapshot.memberships, 'faroe-islands__gjogv').metadata, { hidden: true })
  assert.deepEqual(membershipOf(snapshot.memberships, journeyEntityId('sample_gjogv')).metadata, { hidden: true })
  assert.equal(membershipOf(snapshot.memberships, 'faroe-islands').metadata?.hidden, undefined)
  assert.equal(membershipOf(snapshot.memberships, 'faroe-islands__torshavn').metadata, undefined)
  assert.ok(relationById(snapshot.relations, 'rel:visited:journey:sample_gjogv:faroe-islands__gjogv'))
})

test('城市自己的 accent 写在它的成员关系上；空串 accent 与空 cityIds 不写进 metadata', () => {
  const [iceland] = sampleCountries()
  const snapshot = travelToWorldGraph(
    {
      countries: [{ ...iceland, accent: '', cityIds: [] }],
      cities: [{ ...sampleCities()[0], accent: '#123456' }],
    },
    { now: NOW },
  )
  assert.equal(membershipOf(snapshot.memberships, 'iceland').metadata, undefined)
  assert.deepEqual(membershipOf(snapshot.memberships, 'iceland__reykjavik').metadata, { accent: '#123456' })
})

// ---------------------------------------------------------------------------
// 4. 模型约束、纯函数性质与快照自洽
// ---------------------------------------------------------------------------

test('Anchor 不含任何指向另一个 Entity 的字段（D15）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const allowed = new Set(['id', 'entityId', 'kind', 'lat', 'lng', 'occurredAt', 'occurredUntil', 'precision', 'visibility', 'metadata'])
  for (const anchor of snapshot.anchors) {
    for (const key of Object.keys(anchor)) assert.ok(allowed.has(key), `Anchor 上出现了未预期的字段 ${key}`)
    assert.equal(typeof anchor.precision, 'string', 'D16：precision 首版即必填')
  }
})

test('Entity 上没有 layerId（D14）；成员关系一律 travel / rule / now，没有 recordId（Core 方案 C3）；Relation 一律 rule（D17）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  for (const entity of snapshot.entities) {
    assert.ok(!('layerId' in entity), `${entity.id} 上不该有 layerId`)
    assert.equal(entity.visibility, 'private', 'V0.4 所有 Entity 的 visibility 恒为 private')
  }
  for (const membership of snapshot.memberships) {
    assert.equal(membership.layerId, 'travel')
    assert.equal(membership.addedBy, 'rule')
    assert.equal(membership.addedAt, NOW)
    assert.ok(!('recordId' in membership), `${membership.entityId} 的足迹成员关系不该有 recordId`)
  }
  for (const relation of snapshot.relations) assert.equal(relation.provenance, 'rule')
})

test('不修改输入对象（纯函数）；成员关系里的 cityIds 是副本；相同的 now 产出逐字节相同的快照', () => {
  const input = sampleInput()
  const before = structuredClone(input)
  deepFreeze(input)
  const snapshot = travelToWorldGraph(input, { now: NOW })
  assert.deepEqual(input, before)

  const unfrozen = sampleInput()
  const cityIds = membershipOf(travelToWorldGraph(unfrozen, { now: NOW }).memberships, 'iceland').metadata?.cityIds as string[]
  cityIds.push('mutated')
  assert.deepEqual(unfrozen.countries[0].cityIds, ICELAND_CITY_IDS)

  assert.deepEqual(snapshot, travelToWorldGraph(sampleInput(), { now: NOW }))
})

test('重复的国家 / 城市按 id 去重，先到先得；重复 id 的 JourneyDay 只产出一条 visited', () => {
  const [iceland] = sampleCountries()
  const duplicate: Country = { ...iceland, accent: '#000000' }
  const countries = travelToWorldGraph({ countries: [iceland, duplicate] }, { now: NOW })
  assert.equal(countries.memberships.length, 1)
  assert.equal(countries.memberships[0].metadata?.accent, '#66c7a8')

  const [reykjavik] = sampleCities()
  const cities = travelToWorldGraph({ cities: [reykjavik, { ...reykjavik, countryId: 'faroe-islands', accent: '#000000' }] }, { now: NOW })
  assert.deepEqual(cities.memberships.map((membership) => [membership.entityId, membership.metadata]), [['iceland__reykjavik', undefined]])

  const days = travelToWorldGraph(
    {
      cities: sampleCities().slice(0, 2),
      journeyDays: [
        { id: 'day-1', date: '2025-06-01', cityId: 'iceland__reykjavik', title: 'A' },
        { id: 'day-1', date: '2025-06-01', cityId: 'iceland__vik', title: 'B' },
      ],
    },
    { now: NOW },
  )
  const visited = days.relations.filter((relation) => relation.type === 'visited')
  assert.deepEqual(visited.map((relation) => relation.toEntityId), ['iceland__reykjavik'])
})

test('与地点快照合并（App 的顺序：places 在 travel 之前）：id 唯一、引用不悬空，城市的 part_of 来自地点', () => {
  const snapshot = mergeWorldGraphSnapshots(
    placesToWorldGraph(samplePlaces(), { now: NOW }),
    travelToWorldGraph(sampleInput(), { now: NOW }),
  )
  const entityIds = new Set(snapshot.entities.map((entity) => entity.id))

  assert.equal(entityIds.size, snapshot.entities.length, 'Entity id 必须唯一')
  assert.equal(snapshot.entities.length, 12)
  assert.equal(new Set(snapshot.anchors.map((anchor) => anchor.id)).size, snapshot.anchors.length, 'Anchor id 必须唯一')
  assert.equal(new Set(snapshot.relations.map((relation) => relation.id)).size, snapshot.relations.length, 'Relation id 必须唯一')
  assert.equal(
    new Set(snapshot.memberships.map((membership) => JSON.stringify([membership.entityId, membership.layerId, membership.recordId ?? '']))).size,
    snapshot.memberships.length,
    '(entityId, layerId, recordId) 复合键必须唯一',
  )
  for (const anchor of snapshot.anchors) assert.ok(entityIds.has(anchor.entityId), `Anchor ${anchor.id} 指向了不存在的 Entity`)
  for (const membership of snapshot.memberships) assert.ok(entityIds.has(membership.entityId), `Membership ${membership.entityId} 悬空`)
  for (const relation of snapshot.relations) {
    assert.ok(entityIds.has(relation.fromEntityId), `Relation ${relation.id} 的 from 悬空`)
    assert.ok(entityIds.has(relation.toEntityId), `Relation ${relation.id} 的 to 悬空`)
  }
  assert.deepEqual(
    snapshot.relations.filter((relation) => relation.type === 'part_of').map((relation) => [relation.fromEntityId, relation.toEntityId]),
    [...ICELAND_CITY_IDS.map((id) => [id, 'iceland']), ['faroe-islands__torshavn', 'faroe-islands'], ['faroe-islands__gjogv', 'faroe-islands']],
  )
})

test('ID 规则：行程日 journey:<id>；端点式与来源式两套 Relation id；Anchor id', () => {
  assert.equal(journeyEntityId('sample_vik'), 'journey:sample_vik')
  assert.equal(relationId('visited', 'journey:sample_vik', 'iceland__vik'), 'rel:visited:journey:sample_vik:iceland__vik')
  assert.equal(sourcedRelationId('related_to', 'trip__a__b'), 'rel:related_to:trip__a__b')
  assert.equal(anchorId('time', 'journey:sample_vik'), 'anchor:time:journey:sample_vik')
})
