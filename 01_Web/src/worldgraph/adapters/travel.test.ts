/**
 * travelToWorldGraph 的单元测试（PRD FR-TA-4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 为什么 fixture 是手写的、而不是 import travelAtlas.ts：
 * travelAtlas.ts 第 2 行 import 了 Vite 虚拟模块 'virtual:starmap-private-data'，
 * 并在第 44-47 行读 import.meta.env。这两样在 Vite 之外都无法解析，node --test 直接崩。
 * 所以 fixture 是手写的 travelAtlas 对 src/data/travel-map.sample.json 的【已知输出】。
 * 手写 fixture 的风险是会跟真实数据漂移，因此下面有一个专门的测试
 * （"fixture 与 tracked 的样例数据保持一致"）把 fixture 逐字段钉回那份 JSON。
 * PR3 起 fixture 本身移到 ./travel.fixture.ts（内容逐字未变），与 query.parity.test.ts 共用；
 * 上面那个"钉回 JSON"的测试仍然留在本文件里，仍然是 fixture 的唯一防漂移网。
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
import type { Anchor, Entity, LayerMembership, Relation } from '../types.ts'
import { cityCoordinates, countryCoordinates } from '../../data/geoCoordinates.ts'
import {
  anchorId,
  cityEntityId,
  countryEntityId,
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
  sampleJourneyDays,
  sampleRoutes,
} from './travel.fixture.ts'

import sample from '../../data/travel-map.sample.json' with { type: 'json' }

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

const anchorsOf = (anchors: Anchor[], entityId: string): Anchor[] =>
  anchors.filter((anchor) => anchor.entityId === entityId)

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
// 2. null 坐标（FR-TA-3 / D06）
// ---------------------------------------------------------------------------

test('lat/lng 为 null 的 Country 与 City 仍产出 Entity，但不产出 Anchor（FR-TA-3）', () => {
  const snapshot = travelToWorldGraph(
    {
      countries: [
        {
          id: 'japan',
          nameZh: '日本',
          nameEn: 'Japan',
          centerLat: null,
          centerLng: null,
          visitedDateRange: 'Date unknown',
          summary: '0 visited cities collected from Archive export.',
          memory: 'Travel memory imported from Archive export.',
          cityIds: ['japan__r6'],
          accent: '#66c7a8',
          missingCoordinates: true,
        },
      ],
      cities: [
        {
          id: 'japan__r6',
          nameZh: '',
          nameEn: '',
          countryId: 'japan',
          lat: null,
          lng: null,
          missingCoordinates: true,
        },
      ],
    },
    { now: NOW },
  )

  assert.equal(snapshot.entities.length, 2)
  assert.deepEqual(snapshot.anchors, [], '没有坐标就不该有任何 Anchor')
  assert.equal(snapshot.memberships.length, 2, 'Entity 没坐标不影响它的图层归属')

  // 名字为空串时 title.zh 保留空串，title.en 整个键不出现。
  assert.deepEqual(entityById(snapshot.entities, cityEntityId('japan__r6')).title, { zh: '' })

  // part_of 仍然成立——关系不依赖坐标。
  assert.equal(snapshot.relations.length, 1)
  assert.equal(snapshot.relations[0].type, 'part_of')
})

test('Entity 可以完全没有 Anchor 地存在（D06）', () => {
  const snapshot = travelToWorldGraph(
    {
      countries: [
        {
          id: 'nowhere',
          nameZh: '无处',
          nameEn: 'Nowhere',
          centerLat: null,
          centerLng: null,
          visitedDateRange: 'Date unknown',
          summary: '',
          memory: '',
          cityIds: [],
          accent: '#000000',
        },
      ],
    },
    { now: NOW },
  )

  const entity = entityById(snapshot.entities, countryEntityId('nowhere'))
  assert.equal(anchorsOf(snapshot.anchors, entity.id).length, 0)
  assert.equal(entity.summary, undefined, '空串 summary 不写进 Entity')
  // 空数组（cityIds: []）与空串（memory: ''）不会污染 metadata，
  // 但 travelAtlas 的 'Date unknown' 是一个真实的哨兵字符串，要原样保留。
  assert.deepEqual(entity.metadata, {
    sourceId: 'nowhere',
    accent: '#000000',
    visitedDateRange: 'Date unknown',
  })
})

test('只有一半坐标（lat 有值、lng 为 null）也不产出 Anchor', () => {
  const snapshot = travelToWorldGraph(
    {
      cities: [
        { id: 'spain__half', countryId: 'spain', nameZh: '半个', lat: 43.3, lng: null },
      ],
    },
    { now: NOW },
  )
  assert.equal(snapshot.entities.length, 1)
  assert.deepEqual(snapshot.anchors, [])
})

// ---------------------------------------------------------------------------
// 3. 隐藏项（FR-TA-4）
// ---------------------------------------------------------------------------

test('隐藏的国家仍产出 Entity，membership.metadata.hidden = true（FR-TA-4）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), {
    now: NOW,
    hiddenCountryIds: ['iceland'],
  })

  // Entity 数量不变——隐藏不是过滤。
  assert.equal(snapshot.entities.length, 12)
  assert.ok(entityById(snapshot.entities, countryEntityId('iceland')))

  const hidden = membershipOf(snapshot.memberships, countryEntityId('iceland'))
  assert.deepEqual(hidden.metadata, { hidden: true })
  assert.equal(hidden.addedBy, 'rule')
  assert.equal(hidden.layerId, 'travel')

  // 没被隐藏的国家完全没有 metadata 这个键。
  const visible = membershipOf(snapshot.memberships, countryEntityId('faroe-islands'))
  assert.equal(visible.metadata, undefined)

  // 国家被隐藏时，它的城市与行程一并标记为 hidden。
  assert.deepEqual(membershipOf(snapshot.memberships, cityEntityId('iceland__vik')).metadata, {
    hidden: true,
  })
  assert.deepEqual(membershipOf(snapshot.memberships, journeyEntityId('sample_vik')).metadata, {
    hidden: true,
  })
  assert.equal(
    membershipOf(snapshot.memberships, cityEntityId('faroe-islands__gjogv')).metadata,
    undefined,
  )
})

test('隐藏单个城市只影响该城市与它的行程，不影响所属国家', () => {
  const snapshot = travelToWorldGraph(sampleInput(), {
    now: NOW,
    hiddenCityIds: ['faroe-islands__gjogv'],
  })

  assert.deepEqual(
    membershipOf(snapshot.memberships, cityEntityId('faroe-islands__gjogv')).metadata,
    { hidden: true },
  )
  assert.deepEqual(
    membershipOf(snapshot.memberships, journeyEntityId('sample_gjogv')).metadata,
    { hidden: true },
  )
  assert.equal(
    membershipOf(snapshot.memberships, countryEntityId('faroe-islands')).metadata,
    undefined,
  )
  assert.equal(
    membershipOf(snapshot.memberships, cityEntityId('faroe-islands__torshavn')).metadata,
    undefined,
  )

  // 被隐藏的城市仍然有 Entity、Anchor 与 Relation。
  assert.ok(entityById(snapshot.entities, cityEntityId('faroe-islands__gjogv')))
  assert.equal(anchorsOf(snapshot.anchors, cityEntityId('faroe-islands__gjogv')).length, 1)
})

// ---------------------------------------------------------------------------
// 4. 样例数据的真实断言
// ---------------------------------------------------------------------------

test('样例数据产出 12 个 Entity / 12 个 Membership / 12 个 Anchor / 14 个 Relation', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })

  assert.equal(snapshot.entities.length, 12)
  assert.equal(snapshot.memberships.length, 12)
  assert.equal(snapshot.anchors.length, 12)
  assert.equal(snapshot.relations.length, 14)

  const countByType = (type: Entity['type'], subtype?: Entity['subtype']) =>
    snapshot.entities.filter(
      (entity) => entity.type === type && (subtype === undefined || entity.subtype === subtype),
    ).length

  assert.equal(countByType('place', 'country'), 2)
  assert.equal(countByType('place', 'city'), 5)
  assert.equal(countByType('journey'), 5)
  assert.equal(countByType('media'), 0)

  assert.equal(snapshot.anchors.filter((anchor) => anchor.kind === 'location').length, 7)
  assert.equal(snapshot.anchors.filter((anchor) => anchor.kind === 'time').length, 5)
  assert.equal(snapshot.anchors.filter((anchor) => anchor.kind === 'event').length, 0)

  assert.equal(snapshot.relations.filter((relation) => relation.type === 'part_of').length, 5)
  assert.equal(snapshot.relations.filter((relation) => relation.type === 'visited').length, 5)
  assert.equal(snapshot.relations.filter((relation) => relation.type === 'related_to').length, 4)
})

test('样例数据：Iceland 的 Entity / Anchor / Membership 逐字段正确', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const id = countryEntityId('iceland')
  assert.equal(id, 'place:country:iceland')

  assert.deepEqual(entityById(snapshot.entities, id), {
    id: 'place:country:iceland',
    type: 'place',
    subtype: 'country',
    title: { zh: '冰岛', en: 'Iceland' },
    metadata: {
      sourceId: 'iceland',
      accent: '#66c7a8',
      visitedDateRange: '2025-06-01 - 2025-06-05',
      memory: '2025 North Atlantic Demo',
      keywords: ['North Atlantic'],
      flag: '🇮🇸',
      flagCode: 'is',
      cityIds: ['iceland__reykjavik', 'iceland__vik', 'iceland__akureyri'],
    },
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
    summary: '3 visited cities collected from Archive export.',
  })

  assert.deepEqual(anchorsOf(snapshot.anchors, id), [
    {
      id: 'anchor:location:place:country:iceland',
      entityId: 'place:country:iceland',
      kind: 'location',
      lat: 64.4179,
      lng: -19.691599999999998,
      precision: 'region',
    },
  ])

  assert.deepEqual(membershipOf(snapshot.memberships, id), {
    entityId: 'place:country:iceland',
    layerId: 'travel',
    addedBy: 'rule',
    addedAt: NOW,
  })
})

test('样例数据：Reykjavik 的 Entity / Anchor / part_of Relation 逐字段正确', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const id = cityEntityId('iceland__reykjavik')
  assert.equal(id, 'place:city:iceland__reykjavik')

  assert.deepEqual(entityById(snapshot.entities, id), {
    id: 'place:city:iceland__reykjavik',
    type: 'place',
    subtype: 'city',
    title: { zh: '雷克雅未克', en: 'Reykjavik' },
    metadata: {
      sourceId: 'iceland__reykjavik',
      countryId: 'iceland',
      visitedDateRange: '2025-06-01 - 2025-06-02',
      memory: 'Sample city record.',
      keywords: ['North Atlantic'],
    },
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
    summary: '2025 North Atlantic Demo',
  })

  assert.deepEqual(anchorsOf(snapshot.anchors, id), [
    {
      id: 'anchor:location:place:city:iceland__reykjavik',
      entityId: 'place:city:iceland__reykjavik',
      kind: 'location',
      lat: 64.1466,
      lng: -21.9426,
      // City 是 exact，Country 是 region（FR-TA-2）。
      precision: 'exact',
    },
  ])

  assert.deepEqual(
    relationById(snapshot.relations, 'rel:part_of:place:city:iceland__reykjavik:place:country:iceland'),
    {
      id: 'rel:part_of:place:city:iceland__reykjavik:place:country:iceland',
      fromEntityId: 'place:city:iceland__reykjavik',
      toEntityId: 'place:country:iceland',
      type: 'part_of',
      provenance: 'rule',
    },
  )
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

  assert.deepEqual(anchorsOf(snapshot.anchors, id), [
    {
      id: 'anchor:time:journey:sample_gjogv',
      entityId: 'journey:sample_gjogv',
      kind: 'time',
      occurredAt: '2025-06-08',
      precision: 'exact',
    },
  ])

  assert.deepEqual(
    relationById(
      snapshot.relations,
      'rel:visited:journey:sample_gjogv:place:city:faroe-islands__gjogv',
    ),
    {
      id: 'rel:visited:journey:sample_gjogv:place:city:faroe-islands__gjogv',
      fromEntityId: 'journey:sample_gjogv',
      toEntityId: 'place:city:faroe-islands__gjogv',
      type: 'visited',
      provenance: 'rule',
    },
  )
})

test('样例数据：Route 变成 related_to，metadata 保留 kind / routeId / journeyId', () => {
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
      fromEntityId: 'place:city:iceland__akureyri',
      toEntityId: 'place:city:faroe-islands__torshavn',
      type: 'related_to',
      provenance: 'rule',
      metadata: { kind: 'flight', routeId: flightRouteId, journeyId: JOURNEY_ID },
    },
  )
})

test('同一对城市之间的多条 Route 各自产出一条 Relation，不会被去重吞掉', () => {
  // travelAtlas 的 Route 是按 journey 逐段生成的（travelAtlas.ts:341-360），
  // 同一对城市在两次旅行里各走一遍是完全正常的。若 Relation id 只由端点拼成，
  // 第二条会被静默丢弃且无法恢复——这正是本测试要挡住的回归。
  const cities = sampleCities().slice(0, 2)
  const snapshot = travelToWorldGraph(
    {
      cities,
      routes: [
        {
          id: 'trip-a__leg-1',
          fromCityId: 'iceland__reykjavik',
          toCityId: 'iceland__vik',
          journeyId: 'trip-a',
          type: 'main',
        },
        {
          id: 'trip-b__leg-1',
          fromCityId: 'iceland__reykjavik',
          toCityId: 'iceland__vik',
          journeyId: 'trip-b',
          type: 'drive',
        },
      ],
    },
    { now: NOW },
  )

  const related = snapshot.relations.filter((relation) => relation.type === 'related_to')
  assert.equal(related.length, 2, '同端点的两条 Route 必须产出两条 Relation')
  assert.deepEqual(
    related.map((relation) => relation.id),
    ['rel:related_to:trip-a__leg-1', 'rel:related_to:trip-b__leg-1'],
  )
  assert.deepEqual(
    related.map((relation) => relation.metadata?.journeyId),
    ['trip-a', 'trip-b'],
  )
})

test('Route.id 相同的两条 Route 仍然只产出一条 Relation（按来源 id 去重）', () => {
  const cities = sampleCities().slice(0, 2)
  const route: Route = {
    id: 'trip-a__leg-1',
    fromCityId: 'iceland__reykjavik',
    toCityId: 'iceland__vik',
    journeyId: 'trip-a',
    type: 'main',
  }
  const snapshot = travelToWorldGraph(
    { cities, routes: [route, { ...route, type: 'ferry' }] },
    { now: NOW },
  )

  const related = snapshot.relations.filter((relation) => relation.type === 'related_to')
  assert.equal(related.length, 1)
  assert.equal(related[0].metadata?.kind, 'main', '先到先得')
})

test('缺少 journeyId 的 Route 不会在 metadata 里留下 undefined 键', () => {
  const cities = sampleCities().slice(0, 2)
  const snapshot = travelToWorldGraph(
    {
      cities,
      routes: [
        {
          id: 'loose-leg',
          fromCityId: 'iceland__reykjavik',
          toCityId: 'iceland__vik',
          type: 'main',
        },
      ],
    },
    { now: NOW },
  )

  const related = snapshot.relations.filter((relation) => relation.type === 'related_to')
  assert.equal(related.length, 1)
  assert.deepEqual(related[0].metadata, { kind: 'main', routeId: 'loose-leg' })
})

test('fixture 与 tracked 的 travel-map.sample.json 保持一致', () => {
  // 这个测试的唯一职责：当有人改了 src/data/travel-map.sample.json 时，
  // 上面手写的 fixture 会立刻变红，而不是悄悄地和真实数据脱节。
  const records = sample.records
  assert.equal(records.length, 5)
  assert.ok(
    records.every((record) => record.status === 'visited'),
    '样例里若出现 planned 记录，下面按 5 条计算的期望值全部失效',
  )

  const cities = sampleCities()
  const days = sampleJourneyDays()
  assert.equal(cities.length, records.length)
  assert.equal(days.length, records.length)

  records.forEach((record, index) => {
    const city = cities[index]
    assert.equal(city.nameZh, record.city, `第 ${index} 条城市中文名不一致`)
    assert.equal(city.nameEn, record.city_en, `第 ${index} 条城市英文名不一致`)
    assert.equal(city.lat, record.lat, `第 ${index} 条纬度不一致`)
    assert.equal(city.lng, record.lng, `第 ${index} 条经度不一致`)
    assert.equal(city.memory, record.notes, `第 ${index} 条 memory 不一致`)
    assert.deepEqual(city.keywords, [record.region], `第 ${index} 条 keywords 不一致`)

    const day = days[index]
    assert.equal(day.id, record.id)
    assert.equal(day.date, record.start_date)
    assert.equal(day.title, record.trip_title)
  })

  // 国家中心点是"该国全部有坐标记录的算术平均"，但这只在查表为空时成立：
  // travelAtlas.ts 算的是 getCountryCoordinate(...) ?? mean(...)。
  // 一旦有人往 geoCoordinates.ts 里加一条冰岛，下面的 centerLng 期望值就会和真实数据脱节，
  // 所以先把"查表为空"这个前提本身钉住——它红了，说明该重算 fixture，而不是改这两行。
  assert.equal(
    Object.keys(countryCoordinates).length,
    0,
    'fixture 的国家中心点假设 countryCoordinates 查表为空；表非空时 travelAtlas 不再走算术平均',
  )
  assert.equal(
    Object.keys(cityCoordinates).length,
    0,
    'fixture 的城市坐标假设 cityCoordinates 查表为空',
  )

  for (const country of sampleCountries()) {
    const own = records.filter(
      (record) => record.country_en.toLowerCase().replace(/[^a-z0-9]+/g, '-') === country.id,
    )
    assert.ok(own.length > 0, `${country.id} 在样例里找不到记录`)
    const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length
    assert.equal(country.centerLat, mean(own.map((record) => record.lat)))
    assert.equal(country.centerLng, mean(own.map((record) => record.lng)))
    assert.equal(country.nameZh, own[0].country)
    assert.equal(country.nameEn, own[0].country_en)
    assert.equal(country.flagCode, own[0].country_code)
    assert.equal(country.cityIds.length, own.length)
  }
})

// ---------------------------------------------------------------------------
// 5. 模型能力：多 Anchor、无坐标、D15 边界
// ---------------------------------------------------------------------------

test('当前 FR-TA 规则下每个 City Entity 恰好一个 location Anchor', () => {
  // 模型本身不限制一个 Entity 挂几个 Anchor（Anchor 通过 entityId 指向 Entity，多对一，
  // 没有 1:1 约束），但 V0.4 的映射规则只产出一个。这里钉住的是【规则】，不是模型能力——
  // 用手写数组去"证明"模型允许 N 个是自证自明的，没有约束力，所以不写。
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const entityId = cityEntityId('iceland__reykjavik')

  const own = anchorsOf(snapshot.anchors, entityId)
  assert.equal(own.length, 1)
  assert.equal(own[0].kind, 'location')
  assert.equal(own[0].id, anchorId('location', entityId))
})

test('Anchor 不含任何指向另一个 Entity 的字段（D15）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const allowed = new Set([
    'id',
    'entityId',
    'kind',
    'lat',
    'lng',
    'occurredAt',
    'occurredUntil',
    'precision',
    'visibility',
    'metadata',
  ])
  for (const anchor of snapshot.anchors) {
    for (const key of Object.keys(anchor)) {
      assert.ok(allowed.has(key), `Anchor 上出现了未预期的字段 ${key}`)
    }
    assert.equal(typeof anchor.precision, 'string', 'D16：precision 首版即必填')
  }
})

test('Entity 上没有 layerId 字段，归属只记在 LayerMembership 上（D14）', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  for (const entity of snapshot.entities) {
    assert.ok(!('layerId' in entity), `${entity.id} 上不该有 layerId`)
    assert.equal(entity.visibility, 'private', 'V0.4 所有 Entity 的 visibility 恒为 private')
  }
  for (const membership of snapshot.memberships) {
    assert.equal(membership.layerId, 'travel')
    assert.equal(membership.addedBy, 'rule')
    assert.equal(membership.addedAt, NOW)
  }
  for (const relation of snapshot.relations) {
    assert.equal(relation.provenance, 'rule', 'D17：Adapter 产出的 Relation 一律 rule')
  }
})

test('模型里没有 region 实体，part_of 只有 city → country', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })

  assert.equal(
    snapshot.entities.filter((entity) => entity.subtype === 'region').length,
    0,
    'travelAtlas 不产出 region 分组，因此不该凭空造 region Entity',
  )

  for (const relation of snapshot.relations.filter((r) => r.type === 'part_of')) {
    assert.equal(entityById(snapshot.entities, relation.fromEntityId).subtype, 'city')
    assert.equal(entityById(snapshot.entities, relation.toEntityId).subtype, 'country')
  }
})

// ---------------------------------------------------------------------------
// 6. 纯函数性质与快照自洽
// ---------------------------------------------------------------------------

test('不修改输入对象（纯函数）', () => {
  const input = sampleInput()
  const before = structuredClone(input)
  deepFreeze(input)

  assert.doesNotThrow(() => travelToWorldGraph(input, { now: NOW }))
  assert.deepEqual(input, before)
})

test('快照持有的数组是副本，改它不会回写到输入', () => {
  const input = sampleInput()
  const snapshot = travelToWorldGraph(input, { now: NOW })
  const metadata = entityById(snapshot.entities, countryEntityId('iceland')).metadata
  const cityIds = metadata.cityIds as string[]

  cityIds.push('mutated')
  assert.deepEqual(input.countries[0].cityIds, [
    'iceland__reykjavik',
    'iceland__vik',
    'iceland__akureyri',
  ])
})

test('相同的 now 产出逐字节相同的快照（确定性）', () => {
  assert.deepEqual(
    travelToWorldGraph(sampleInput(), { now: NOW }),
    travelToWorldGraph(sampleInput(), { now: NOW }),
  )
})

test('快照自洽：id 唯一、引用不悬空', () => {
  const snapshot = travelToWorldGraph(sampleInput(), { now: NOW })
  const entityIds = new Set(snapshot.entities.map((entity) => entity.id))

  assert.equal(entityIds.size, snapshot.entities.length, 'Entity id 必须唯一')
  assert.equal(
    new Set(snapshot.anchors.map((anchor) => anchor.id)).size,
    snapshot.anchors.length,
    'Anchor id 必须唯一',
  )
  assert.equal(
    new Set(snapshot.relations.map((relation) => relation.id)).size,
    snapshot.relations.length,
    'Relation id 必须唯一',
  )
  assert.equal(
    new Set(snapshot.memberships.map((membership) => `${membership.entityId} ${membership.layerId}`)).size,
    snapshot.memberships.length,
    '(entityId, layerId) 复合键必须唯一',
  )

  for (const anchor of snapshot.anchors) {
    assert.ok(entityIds.has(anchor.entityId), `Anchor ${anchor.id} 指向了不存在的 Entity`)
  }
  for (const membership of snapshot.memberships) {
    assert.ok(entityIds.has(membership.entityId), `Membership 指向了不存在的 Entity`)
  }
  for (const relation of snapshot.relations) {
    assert.ok(entityIds.has(relation.fromEntityId), `Relation ${relation.id} 的 from 悬空`)
    assert.ok(entityIds.has(relation.toEntityId), `Relation ${relation.id} 的 to 悬空`)
  }
})

test('重复的输入对象按 id 去重，先到先得', () => {
  const [iceland] = sampleCountries()
  const duplicate: Country = { ...iceland, nameEn: 'Duplicate' }
  const snapshot = travelToWorldGraph({ countries: [iceland, duplicate] }, { now: NOW })

  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.memberships.length, 1)
  assert.equal(entityById(snapshot.entities, countryEntityId('iceland')).title.en, 'Iceland')
})

test('重复 id 但 countryId 冲突的 City 只产出一条 part_of', () => {
  // Relation 若从原始输入数组派生，这里会产出两条 part_of（→ iceland 与 → faroe-islands），
  // 即"一个城市同时属于两个国家"，和只留了一个 city Entity 的 entities 自相矛盾。
  const snapshot = travelToWorldGraph(
    {
      countries: sampleCountries(),
      cities: [
        { id: 'iceland__vik', nameZh: '维克', countryId: 'iceland', lat: 63.4186, lng: -19.006 },
        { id: 'iceland__vik', nameZh: '维克', countryId: 'faroe-islands', lat: 62.1, lng: -6.9 },
      ],
    },
    { now: NOW },
  )

  const partOf = snapshot.relations.filter((relation) => relation.type === 'part_of')
  assert.equal(partOf.length, 1)
  assert.equal(partOf[0].toEntityId, countryEntityId('iceland'), '先到先得的那条才算数')

  // 产出的 Relation 必须和留下来的那个 Entity 说同一件事。
  const city = entityById(snapshot.entities, cityEntityId('iceland__vik'))
  assert.equal(city.metadata.countryId, 'iceland')
  assert.equal(anchorsOf(snapshot.anchors, city.id).length, 1)
})

test('重复 id 的 JourneyDay 只产出一条 visited', () => {
  const snapshot = travelToWorldGraph(
    {
      cities: sampleCities().slice(0, 2),
      journeyDays: [
        { id: 'day-1', date: '2025-06-01', cityId: 'iceland__reykjavik', title: 'A' },
        { id: 'day-1', date: '2025-06-01', cityId: 'iceland__vik', title: 'B' },
      ],
    },
    { now: NOW },
  )

  const visited = snapshot.relations.filter((relation) => relation.type === 'visited')
  assert.equal(visited.length, 1)
  assert.equal(visited[0].toEntityId, cityEntityId('iceland__reykjavik'))
})

test('lat/lng 恰好为 0 是合法坐标，必须产出 Anchor（不能用真值判断守卫）', () => {
  // 把 hasCoordinate 简化成 `if (city.lat && city.lng)` 会让几内亚湾附近的地点静默丢 Anchor，
  // 而其余测试全绿。这条用例就是那个简化的红灯。
  const snapshot = travelToWorldGraph(
    {
      countries: [
        {
          id: 'null-island',
          nameZh: '零点',
          nameEn: 'Null Island',
          centerLat: 0,
          centerLng: 0,
          visitedDateRange: 'Date unknown',
          summary: '',
          memory: '',
          cityIds: ['null-island__origin'],
          accent: '#000000',
        },
      ],
      cities: [
        { id: 'null-island__origin', nameZh: '本初点', countryId: 'null-island', lat: 0, lng: 0 },
      ],
    },
    { now: NOW },
  )

  assert.equal(snapshot.anchors.length, 2)
  for (const anchor of snapshot.anchors) {
    assert.strictEqual(anchor.lat, 0)
    assert.strictEqual(anchor.lng, 0)
  }
})

test('NaN 坐标不产出 Anchor', () => {
  const snapshot = travelToWorldGraph(
    { cities: [{ id: 'nan__city', countryId: 'nan', nameZh: '坏坐标', lat: NaN, lng: NaN }] },
    { now: NOW },
  )
  assert.equal(snapshot.entities.length, 1)
  assert.deepEqual(snapshot.anchors, [], 'NaN 坐标会让 Cesium 直接炸，必须挡在 Anchor 之前')
})

test('from 与 to 是同一个城市的 Route 不产出自环 Relation', () => {
  const snapshot = travelToWorldGraph(
    {
      cities: sampleCities().slice(0, 1),
      routes: [
        {
          id: 'self-loop',
          fromCityId: 'iceland__reykjavik',
          toCityId: 'iceland__reykjavik',
          journeyId: 'trip-a',
          type: 'main',
        },
      ],
    },
    { now: NOW },
  )

  assert.equal(snapshot.entities.length, 1)
  assert.deepEqual(snapshot.relations, [])
})

test('JourneyDay.cityId 指向不存在的 City 时不产出悬空 visited，journey Entity 仍在', () => {
  const snapshot = travelToWorldGraph(
    {
      journeyDays: [
        {
          id: 'orphan-day',
          date: '2025-06-01',
          cityId: 'nowhere__city',
          title: '孤儿行程',
          journeyId: 'trip-a',
        },
      ],
    },
    { now: NOW },
  )

  assert.equal(snapshot.entities.length, 1)
  assert.equal(snapshot.entities[0].id, journeyEntityId('orphan-day'))
  assert.deepEqual(snapshot.relations, [])
  assert.equal(anchorsOf(snapshot.anchors, journeyEntityId('orphan-day')).length, 1)
})

test('中文名缺失时 title.zh 回落到英文名，而不是空串', () => {
  // 空 title.zh 在 PR3 会渲染成一个没有标签的地图标记。
  const snapshot = travelToWorldGraph(
    {
      cities: [
        { id: 'x__nameless', countryId: 'x', nameZh: '', nameEn: 'Nameless', lat: 1, lng: 2 },
        { id: 'x__void', countryId: 'x', nameZh: '', nameEn: '', lat: 1, lng: 2 },
      ],
    },
    { now: NOW },
  )

  assert.deepEqual(entityById(snapshot.entities, cityEntityId('x__nameless')).title, {
    zh: 'Nameless',
    en: 'Nameless',
  })
  // 中英文都为空时才保留空串——没有别的东西可回落。
  assert.deepEqual(entityById(snapshot.entities, cityEntityId('x__void')).title, { zh: '' })
})

test('sourcedRelationId 与 relationId 是两套 id 规则', () => {
  assert.equal(
    relationId('related_to', 'place:city:a', 'place:city:b'),
    'rel:related_to:place:city:a:place:city:b',
  )
  assert.equal(sourcedRelationId('related_to', 'trip__a__b'), 'rel:related_to:trip__a__b')
})

test('ID 规则遵循 PRD §8.2', () => {
  assert.equal(countryEntityId('iceland'), 'place:country:iceland')
  assert.equal(cityEntityId('iceland__reykjavik'), 'place:city:iceland__reykjavik')
  assert.equal(journeyEntityId('sample_vik'), 'journey:sample_vik')
  assert.equal(
    relationId('part_of', 'place:city:iceland__reykjavik', 'place:country:iceland'),
    'rel:part_of:place:city:iceland__reykjavik:place:country:iceland',
  )
})
