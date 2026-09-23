/**
 * Travel Adapter —— 把现有 travelAtlas 的领域对象投影成 World Graph 快照。
 *
 * 【待《World Graph Core Model RFC》定稿】映射规则来自 StarMap V0.4 Layer Engine PRD v0.1
 * §6 FR-TA-1..FR-TA-5 与 §8.2 ID 规则。
 *
 * 设计约束（都有具体原因，改之前先读完）：
 *
 * 1. 输入是【已经加载好的领域对象】（Country[] / City[] / JourneyDay[] / Route[]），
 *    不是原始 TravelMapRecord[]。FR-TA-1 如此要求，为的是不复制 travelAtlas.ts 的解析逻辑。
 *    另一个同样重要的后果：本模块【不能】 import src/data/travelAtlas.ts。
 *    travelAtlas.ts 依赖 Vite 虚拟模块 'virtual:starmap-private-data' 与 import.meta.env，
 *    在 Vite 之外（例如 node --test）无法解析，一旦 import 进来本适配器就不可测了。
 *
 * 2. 纯函数：不读写文件、不修改输入对象、不依赖模块级单例、不读取当前时间。
 *    时间戳是唯一可能的非确定性来源，因此 options.now 是【必填】的——没有缺省值，
 *    也不会回落到 new Date()。相同的 (input, options) 永远产出相同的快照。
 *
 * 3. FR-TA-5：travelAtlas.ts 的 `status === 'planned'` 过滤【保持不变】，本适配器不碰。
 *    planned 记录由 FR-WTG-7 的另一个 Adapter 消费。
 *
 * 4. 隐藏项（FR-TA-4）：travelAtlas 的 editor 隐藏机制发生在记录层，被隐藏的国家/城市
 *    根本不会出现在它导出的 countries/cities 里。所以"隐藏但仍产出 Entity"这件事
 *    本适配器无法自己推断，必须由调用方把这些对象【连同】 hiddenCountryIds / hiddenCityIds
 *    一起传进来；本适配器只负责给它们的 membership 打上 metadata.hidden = true，
 *    自己不做任何过滤。
 *
 *    ⚠️ 这条路径【目前没有真实调用方】：travelAtlas.ts 在记录层（:129-137）就把隐藏的
 *    国家/城市过滤掉了，`standaloneCountries`（:274）又二次过滤，它导出的
 *    countries / cities / journeyDays / routes 没有一份是未过滤的全集。
 *    所以今天没人能同时拿到「被隐藏的 Country 对象」和它的 id，传 hiddenCountryIds
 *    进来只会给一个不在 input 里的 id 打标记，什么也不会发生。
 *    本段逻辑目前【只由单元测试覆盖】。要真正接通，需要 travelAtlas 额外导出未过滤集合
 *    （超出 PR1 范围，见 PRD §15 Q8），或由 PRD 改写 FR-TA-4 的调用契约。
 */

import type { City, CityId, Country, CountryId, JourneyDay, Route } from '../../types/travel.ts'
import type {
  Anchor,
  AnchorKind,
  Entity,
  EntityId,
  EntityMetadata,
  LayerMembership,
  Relation,
  RelationMetadata,
  RelationType,
  WorldGraphSnapshot,
} from '../types.ts'
// Travel 官方图层的 id 只在 Layer Registry 里声明一次。
import { TRAVEL_LAYER_ID } from '../layers.ts'

export interface TravelWorldGraphInput {
  countries?: readonly Country[]
  cities?: readonly City[]
  journeyDays?: readonly JourneyDay[]
  routes?: readonly Route[]
}

export interface TravelWorldGraphOptions {
  /**
   * 注入 Entity.createdAt / updatedAt 与 LayerMembership.addedAt 的时间戳（ISO 8601）。
   * 【必填】：FR-TA-1 要求本函数是纯函数，所以这里不提供 new Date() 缺省值。
   * 生产调用方（PR2 起）自己决定这个时间从哪来。
   */
  now: string
  /** 被 editor 隐藏的国家 id（travelAtlas 的 CountryId，不是 EntityId）。 */
  hiddenCountryIds?: Iterable<CountryId>
  /** 被 editor 隐藏的城市 id（travelAtlas 的 CityId，不是 EntityId）。 */
  hiddenCityIds?: Iterable<CityId>
}

// ---- ID 规则（PRD §8.2）----

export const countryEntityId = (countryId: CountryId): EntityId => `place:country:${countryId}`

export const cityEntityId = (cityId: CityId): EntityId => `place:city:${cityId}`

export const journeyEntityId = (journeyDayId: string): EntityId => `journey:${journeyDayId}`

export const relationId = (type: RelationType, from: EntityId, to: EntityId): string =>
  `rel:${type}:${from}:${to}`

/**
 * 多重边专用的 Relation id。
 *
 * PRD §8.2 的 `rel:<type>:<from>:<to>` 只能表达「同一对端点之间至多一条边」，
 * 对 part_of / visited 成立，对 Route 不成立：travelAtlas 的 Route 是按 journey 逐段
 * 生成的（travelAtlas.ts:341-360），同一对城市在不同 journey、或同一 journey 内往返，
 * 都会生成多条 Route。若沿用端点式 id，第二条起会被静默去重吞掉。
 * 因此 Route 派生的 Relation 改用来源 id 作为区分键。PRD §8.2 已相应修订（"多重边"一行）。
 */
export const sourcedRelationId = (type: RelationType, sourceId: string): string =>
  `rel:${type}:${sourceId}`

/**
 * PRD §8.2 没有规定 Anchor 的 id 格式，这是本适配器自己的约定。
 * 对外请把 Anchor.id 当作不透明字符串，不要反解。
 */
export const anchorId = (kind: AnchorKind, entityId: EntityId): string =>
  `anchor:${kind}:${entityId}`

// ---- 内部工具 ----

/**
 * 只写入"有内容"的 metadata 键：undefined / null / 空串 / 空数组一律跳过。
 * 这样快照里不会出现一堆值为 undefined 的键，deepEqual 断言才写得干净。
 * 注意 false 与 0 会被保留——它们是有意义的值。
 */
const putIfPresent = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (value === undefined || value === null || value === '') return
  if (Array.isArray(value) && value.length === 0) return
  target[key] = value
}

/**
 * title.zh 在中文名缺失时回落到英文名，而不是回落到空串——空串会在 PR3 渲染成
 * 一个没有标签的地图标记。用 `||` 而非 `??`：travelAtlas 对无名记录产出的是空串，不是 undefined。
 * 真实数据踩不到这条回落（travelAtlas.ts:303 `nameZh: first.city` 恒为字符串），
 * 它只是给手写 / 外部输入兜底。两者都为空时才保留 `{ zh: '' }`。
 */
const buildTitle = (zh: string | undefined, en: string | undefined): Entity['title'] => {
  const title: Entity['title'] = { zh: zh || en || '' }
  if (en) title.en = en
  return title
}

/** 坐标必须是有限数字才算数：null / undefined / NaN 都判为"没有坐标"（FR-TA-3）。 */
const hasCoordinate = (lat: number | null | undefined, lng: number | null | undefined): boolean =>
  typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng)

/**
 * 把 travelAtlas 的领域对象投影成一个 World Graph 快照。
 *
 * 映射规则（PRD FR-TA-2，已按实际数据删掉 Region 一行，理由见下方 part_of 段落）：
 *
 * - Country    → Entity place/country + location Anchor（precision 'region'）+ travel membership
 * - City       → Entity place/city    + location Anchor（precision 'exact'） + travel membership
 *                + part_of Relation → country
 * - JourneyDay → Entity journey       + time Anchor（precision 'exact'）     + travel membership
 *                + visited Relation → city
 * - Route      → related_to Relation（from city → to city，
 *                metadata = { kind: Route.type, routeId, journeyId? }）
 *
 * 输出的四个数组内部按 id 去重（先到先得），且 Anchor / Membership / Relation 只会引用
 * 真实存在于 entities 里的 Entity——两端找不齐的 Relation 直接不产出，不留悬空边。
 *
 * 去重的一个重要后果：Relation 只从【实际被接受的】 Entity 派生，不从原始输入数组派生。
 * 否则两个 id 相同但 countryId 不同的 City 会产出一个 Entity + 两条 part_of，
 * 即「一个城市属于两个国家」的自相矛盾快照。
 */
export const travelToWorldGraph = (
  input: TravelWorldGraphInput,
  options: TravelWorldGraphOptions,
): WorldGraphSnapshot => {
  const now = options.now
  const hiddenCountryIds = new Set<CountryId>(options.hiddenCountryIds ?? [])
  const hiddenCityIds = new Set<CityId>(options.hiddenCityIds ?? [])

  const countries = input.countries ?? []
  const cities = input.cities ?? []
  const journeyDays = input.journeyDays ?? []
  const routes = input.routes ?? []

  const entities: Entity[] = []
  const memberships: LayerMembership[] = []
  const anchors: Anchor[] = []
  const relations: Relation[] = []

  const seenEntityIds = new Set<EntityId>()
  const seenAnchorIds = new Set<string>()
  const seenRelationIds = new Set<string>()

  /**
   * 实际被接受（没有被 id 去重丢掉）的输入对象。下面的 Relation 循环只遍历这两个数组，
   * 保证 Relation 与 Entity 出自同一份事实——细节见函数注释里的去重说明。
   */
  const acceptedCities: City[] = []
  const acceptedJourneyDays: JourneyDay[] = []

  /** 城市 → 所属国家 id，用来判断 JourneyDay 是否因为国家被隐藏而隐藏。 */
  const countryIdByCityId = new Map<CityId, CountryId>()
  for (const city of cities) {
    if (city.countryId !== undefined && !countryIdByCityId.has(city.id)) {
      countryIdByCityId.set(city.id, city.countryId)
    }
  }

  const isCountryHidden = (countryId: CountryId | undefined): boolean =>
    countryId !== undefined && hiddenCountryIds.has(countryId)

  const isCityHidden = (cityId: CityId | undefined, countryId: CountryId | undefined): boolean =>
    (cityId !== undefined && hiddenCityIds.has(cityId)) || isCountryHidden(countryId)

  const addEntity = (entity: Entity, hidden: boolean): boolean => {
    if (seenEntityIds.has(entity.id)) return false
    seenEntityIds.add(entity.id)
    entities.push(entity)

    const membership: LayerMembership = {
      entityId: entity.id,
      layerId: TRAVEL_LAYER_ID,
      addedBy: 'rule',
      addedAt: now,
    }
    // 隐藏项仍然产出 Entity 与 membership，只是打上标记（FR-TA-4）。
    if (hidden) membership.metadata = { hidden: true }
    memberships.push(membership)
    return true
  }

  const addAnchor = (anchor: Anchor): void => {
    if (seenAnchorIds.has(anchor.id)) return
    seenAnchorIds.add(anchor.id)
    anchors.push(anchor)
  }

  const addRelation = (
    type: RelationType,
    fromEntityId: EntityId,
    toEntityId: EntityId,
    metadata?: RelationMetadata,
    /** 多重边（Route）用来源 id 覆盖端点式 id，见 sourcedRelationId。 */
    idOverride?: string,
  ): void => {
    // 不产出悬空边：两端都必须是本快照里真实存在的 Entity。
    if (!seenEntityIds.has(fromEntityId) || !seenEntityIds.has(toEntityId)) return
    if (fromEntityId === toEntityId) return
    const id = idOverride ?? relationId(type, fromEntityId, toEntityId)
    if (seenRelationIds.has(id)) return
    seenRelationIds.add(id)
    const relation: Relation = { id, fromEntityId, toEntityId, type, provenance: 'rule' }
    if (metadata !== undefined) relation.metadata = metadata
    relations.push(relation)
  }

  // ---- Country → place/country ----
  for (const country of countries) {
    const entityId = countryEntityId(country.id)
    const metadata: EntityMetadata = {}
    putIfPresent(metadata, 'sourceId', country.id)
    putIfPresent(metadata, 'accent', country.accent)
    putIfPresent(metadata, 'visitedDateRange', country.visitedDateRange)
    putIfPresent(metadata, 'memory', country.memory)
    putIfPresent(metadata, 'keywords', country.keywords ? [...country.keywords] : undefined)
    putIfPresent(metadata, 'flag', country.flag)
    putIfPresent(metadata, 'flagCode', country.flagCode)
    putIfPresent(metadata, 'cityIds', [...country.cityIds])

    const entity: Entity = {
      id: entityId,
      type: 'place',
      subtype: 'country',
      title: buildTitle(country.nameZh, country.nameEn),
      metadata,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    }
    if (country.summary) entity.summary = country.summary

    if (!addEntity(entity, isCountryHidden(country.id))) continue

    // FR-TA-3：没有坐标的 Country 仍有 Entity，只是不产出 Anchor。
    if (hasCoordinate(country.centerLat, country.centerLng)) {
      addAnchor({
        id: anchorId('location', entityId),
        entityId,
        kind: 'location',
        lat: country.centerLat as number,
        lng: country.centerLng as number,
        // 'region' 来自 PRD FR-TA-2。与战略基线 v0.2 §8.1「Travel 的国家/城市为 exact」
        // 冲突，已登记为 PRD §15 Q9；国家中心点本就是若干城市坐标的算术平均
        // （travelAtlas.ts:234-245），不是 exact 坐标。V0.4 不消费 precision，
        // 影响落在 0.8 分享的自动降精度分支。Q9 定案前不要改这里。
        precision: 'region',
      })
    }
  }

  // ---- City → place/city ----
  for (const city of cities) {
    const entityId = cityEntityId(city.id)
    const metadata: EntityMetadata = {}
    putIfPresent(metadata, 'sourceId', city.id)
    putIfPresent(metadata, 'countryId', city.countryId)
    putIfPresent(metadata, 'visitedDateRange', city.visitedDateRange)
    putIfPresent(metadata, 'memory', city.memory)
    putIfPresent(metadata, 'keywords', city.keywords ? [...city.keywords] : undefined)
    putIfPresent(metadata, 'accent', city.accent)

    const entity: Entity = {
      id: entityId,
      type: 'place',
      subtype: 'city',
      title: buildTitle(city.nameZh, city.nameEn),
      metadata,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    }
    if (city.summary) entity.summary = city.summary

    if (!addEntity(entity, isCityHidden(city.id, city.countryId))) continue
    acceptedCities.push(city)

    if (hasCoordinate(city.lat, city.lng)) {
      addAnchor({
        id: anchorId('location', entityId),
        entityId,
        kind: 'location',
        lat: city.lat as number,
        lng: city.lng as number,
        precision: 'exact',
      })
    }
  }

  // ---- JourneyDay → journey ----
  for (const day of journeyDays) {
    const entityId = journeyEntityId(day.id)
    const metadata: EntityMetadata = {}
    putIfPresent(metadata, 'sourceId', day.id)
    putIfPresent(metadata, 'journeyId', day.journeyId)
    putIfPresent(metadata, 'countryId', day.countryId)
    putIfPresent(metadata, 'cityId', day.cityId)
    putIfPresent(metadata, 'date', day.date)
    putIfPresent(metadata, 'isHighlight', day.isHighlight)

    // JourneyDay.title 是一个未区分语种的单字符串，只能落在 title.zh 上。
    const entity: Entity = {
      id: entityId,
      type: 'journey',
      title: buildTitle(day.title, undefined),
      metadata,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    }
    if (day.summary) entity.summary = day.summary

    const hidden = isCityHidden(day.cityId, day.countryId ?? countryIdByCityId.get(day.cityId))
    if (!addEntity(entity, hidden)) continue
    acceptedJourneyDays.push(day)

    if (day.date) {
      addAnchor({
        id: anchorId('time', entityId),
        entityId,
        kind: 'time',
        occurredAt: day.date,
        // PRD 未规定 time Anchor 的 precision；'exact' 是 union 里唯一说得通的取值。
        precision: 'exact',
      })
    }
  }

  // ---- Relation：part_of（city → country）----
  // FR-TA-2 原表里还有一行 "Region 分组 → place/region"，已删除：
  // travelAtlas 不产出任何 region 分组，region 只是记录上的字符串字段，
  // 被用作 Country/City 的 keywords。所以 part_of 到 city → country 为止。
  for (const city of acceptedCities) {
    if (city.countryId === undefined) continue
    addRelation('part_of', cityEntityId(city.id), countryEntityId(city.countryId))
  }

  // ---- Relation：visited（journey → city）----
  for (const day of acceptedJourneyDays) {
    addRelation('visited', journeyEntityId(day.id), cityEntityId(day.cityId))
  }

  // ---- Relation：related_to（route from city → to city）----
  // Route 是多重边：同一对城市可能出现在多条 Route 上，所以 id 用 Route.id 而不是端点，
  // 并把 routeId / journeyId 写进 metadata，让 PR2/PR3 能把路线归属回具体 journey。
  for (const route of routes) {
    const metadata: RelationMetadata = {}
    putIfPresent(metadata, 'kind', route.type)
    putIfPresent(metadata, 'routeId', route.id)
    putIfPresent(metadata, 'journeyId', route.journeyId)
    addRelation(
      'related_to',
      cityEntityId(route.fromCityId),
      cityEntityId(route.toCityId),
      metadata,
      sourcedRelationId('related_to', route.id),
    )
  }

  return { entities, memberships, anchors, relations }
}
