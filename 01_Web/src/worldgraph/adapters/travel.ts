/**
 * Travel Adapter —— 把足迹的领域对象投影成 World Graph 快照里的足迹层。
 *
 * 【待《World Graph Core Model RFC》定稿】映射规则来自 StarMap V0.4 Layer Engine PRD v0.1
 * §6 FR-TA-1..FR-TA-5 与 §8.2 ID 规则；RFC-LOC-1 Core 方案 C1、C2 起地点实体不再由本适配器构造。
 *
 * 设计约束（都有具体原因，改之前先读完）：
 *
 * 1. 输入是【已经加载好的领域对象】（Country[] / City[] / JourneyDay[] / Route[]），
 *    不是原始 TravelMapRecord[]。FR-TA-1 如此要求，为的是不复制 App 派生层的逻辑。
 *    另一个同样重要的后果：本模块【不能】 import src/data/travelAtlas.ts。
 *    travelAtlas.ts 依赖 Vite 虚拟模块 'virtual:starmap-private-data' 与 import.meta.env，
 *    在 Vite 之外（例如 node --test）无法解析，一旦 import 进来本适配器就不可测了。
 *
 * 2. 纯函数：不读写文件、不修改输入对象、不依赖模块级单例、不读取当前时间。
 *    时间戳是唯一可能的非确定性来源，因此 options.now 是【必填】的——没有缺省值，
 *    也不会回落到 new Date()。相同的 (input, options) 永远产出相同的快照。
 *
 * 3. 国家与城市的地点实体、位置锚点与 part_of 由 ./places.ts 从注册表构造（C2）。本适配器只产出：
 *    足迹层的国家 / 城市成员关系（entityId 就是 Country.id / City.id，即地点 id）、行程日实体与时间锚点、
 *    visited 与路线关系。查询层要读的足迹信息（`accent`、国家的 `cityIds`）写在对应的足迹成员关系上。
 *
 * 4. FR-TA-5：`status === 'planned'` 的记录不进足迹，由 ./plannedRecords.ts 进入想去图层。
 *
 * 5. 隐藏项（FR-TA-4）：App 在派生层就把被 editor 隐藏的国家 / 城市过滤掉了，它们根本不会出现在输入里。
 *    所以「隐藏但仍产出成员关系」这件事本适配器无法自己推断，必须由调用方把这些对象【连同】
 *    hiddenCountryIds / hiddenCityIds 一起传进来；本适配器只负责给它们的成员关系打上 metadata.hidden = true，
 *    自己不做任何过滤。这条路径【目前没有真实调用方】（App 只传 now，见 src/data/derive/worldGraph.ts），
 *    只由单元测试覆盖（PRD §15 Q8）。
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
   * 注入行程日 Entity.createdAt / updatedAt 与 LayerMembership.addedAt 的时间戳（ISO 8601）。
   * 【必填】：FR-TA-1 要求本函数是纯函数，所以这里不提供 new Date() 缺省值。
   */
  now: string
  /** 被 editor 隐藏的国家 id（地点 id）。 */
  hiddenCountryIds?: Iterable<CountryId>
  /** 被 editor 隐藏的城市 id（地点 id）。 */
  hiddenCityIds?: Iterable<CityId>
}

// ---- ID 规则（PRD §8.2；地点的实体 id 就是地点 id，见 ./places.ts）----

export const journeyEntityId = (journeyDayId: string): EntityId => `journey:${journeyDayId}`

export const relationId = (type: RelationType, from: EntityId, to: EntityId): string =>
  `rel:${type}:${from}:${to}`

/**
 * 多重边专用的 Relation id。
 *
 * PRD §8.2 的 `rel:<type>:<from>:<to>` 只能表达「同一对端点之间至多一条边」，
 * 对 part_of / visited 成立，对 Route 不成立：Route 是按 journey 逐段生成的，
 * 同一对城市在不同 journey、或同一 journey 内往返，都会生成多条 Route。
 * 若沿用端点式 id，第二条起会被静默去重吞掉。
 * 因此 Route 派生的 Relation 改用来源 id 作为区分键。PRD §8.2 已相应修订（"多重边"一行）。
 */
export const sourcedRelationId = (type: RelationType, sourceId: string): string =>
  `rel:${type}:${sourceId}`

/**
 * PRD §8.2 没有规定 Anchor 的 id 格式，这是 Core 适配器共用的约定。
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
 * 行程日的 title：JourneyDay.title 是一个未区分语种的单字符串，只能落在 title.zh 上。
 * 为空时保留 `{ zh: '' }`（真实数据踩不到：派生层总会给行程日一个标题）。
 */
const journeyTitle = (title: string | undefined): Entity['title'] => ({ zh: title || '' })

/**
 * 把足迹的领域对象投影成一个 World Graph 快照（足迹层）。
 *
 * 映射规则（PRD FR-TA-2；地点实体、位置锚点与 part_of 见 ./places.ts）：
 *
 * - Country    → travel membership（entityId = Country.id），metadata = { accent?, cityIds?, hidden? }
 * - City       → travel membership（entityId = City.id），metadata = { accent?, hidden? }
 * - JourneyDay → Entity journey + time Anchor（precision 'exact'）+ travel membership
 *                + visited Relation → city
 * - Route      → related_to Relation（from city → to city，
 *                metadata = { kind: Route.type, routeId, journeyId? }）
 *
 * 成员关系里没有 recordId：足迹层的国家 / 城市背后不是一条记录（Core 方案 C3）。
 *
 * 国家 / 城市按 id 去重、行程日按 Entity id 去重（先到先得）；Relation 只连接【实际被接受的】行程日与城市，
 * 两端找不齐的不产出，不留悬空边。去重的一个重要后果：Relation 只从被接受的对象派生，不从原始输入数组派生。
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

  /** 已产出足迹成员关系的地点 id（国家与城市共用一个 id 空间：都是注册表的地点 id）。 */
  const seenPlaceIds = new Set<EntityId>()
  /** 被接受的城市：visited 与 related_to 的城市端只能是它们。 */
  const acceptedCityIds = new Set<CityId>()
  const seenJourneyEntityIds = new Set<EntityId>()
  const seenRelationIds = new Set<string>()
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

  const addMembership = (entityId: EntityId, metadata: Record<string, unknown>, hidden: boolean): void => {
    const membership: LayerMembership = {
      entityId,
      layerId: TRAVEL_LAYER_ID,
      addedBy: 'rule',
      addedAt: now,
    }
    // 隐藏项仍然产出成员关系，只是打上标记（FR-TA-4）。
    if (hidden) metadata.hidden = true
    if (Object.keys(metadata).length > 0) membership.metadata = metadata
    memberships.push(membership)
  }

  const addRelation = (
    type: RelationType,
    fromEntityId: EntityId,
    toEntityId: EntityId,
    metadata?: RelationMetadata,
    /** 多重边（Route）用来源 id 覆盖端点式 id，见 sourcedRelationId。 */
    idOverride?: string,
  ): void => {
    if (fromEntityId === toEntityId) return
    const id = idOverride ?? relationId(type, fromEntityId, toEntityId)
    if (seenRelationIds.has(id)) return
    seenRelationIds.add(id)
    const relation: Relation = { id, fromEntityId, toEntityId, type, provenance: 'rule' }
    if (metadata !== undefined) relation.metadata = metadata
    relations.push(relation)
  }

  // ---- Country → travel membership ----
  // 查询层读 accent（标记主色的回落）与 cityIds（国家内的顺序段），见 ../query.ts。
  for (const country of countries) {
    if (seenPlaceIds.has(country.id)) continue
    seenPlaceIds.add(country.id)
    const metadata: Record<string, unknown> = {}
    putIfPresent(metadata, 'accent', country.accent)
    putIfPresent(metadata, 'cityIds', [...country.cityIds])
    addMembership(country.id, metadata, isCountryHidden(country.id))
  }

  // ---- City → travel membership ----
  for (const city of cities) {
    if (seenPlaceIds.has(city.id)) continue
    seenPlaceIds.add(city.id)
    acceptedCityIds.add(city.id)
    const metadata: Record<string, unknown> = {}
    putIfPresent(metadata, 'accent', city.accent)
    addMembership(city.id, metadata, isCityHidden(city.id, city.countryId))
  }

  // ---- JourneyDay → journey ----
  for (const day of journeyDays) {
    const entityId = journeyEntityId(day.id)
    if (seenJourneyEntityIds.has(entityId)) continue
    seenJourneyEntityIds.add(entityId)
    acceptedJourneyDays.push(day)

    const metadata: EntityMetadata = {}
    putIfPresent(metadata, 'sourceId', day.id)
    putIfPresent(metadata, 'journeyId', day.journeyId)
    putIfPresent(metadata, 'countryId', day.countryId)
    putIfPresent(metadata, 'cityId', day.cityId)
    putIfPresent(metadata, 'date', day.date)
    putIfPresent(metadata, 'isHighlight', day.isHighlight)

    const entity: Entity = {
      id: entityId,
      type: 'journey',
      title: journeyTitle(day.title),
      metadata,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    }
    if (day.summary) entity.summary = day.summary
    entities.push(entity)
    addMembership(entityId, {}, isCityHidden(day.cityId, day.countryId ?? countryIdByCityId.get(day.cityId)))

    if (day.date) {
      anchors.push({
        id: anchorId('time', entityId),
        entityId,
        kind: 'time',
        occurredAt: day.date,
        // PRD 未规定 time Anchor 的 precision；'exact' 是 union 里唯一说得通的取值。
        precision: 'exact',
      })
    }
  }

  // ---- Relation：visited（journey → city）----
  for (const day of acceptedJourneyDays) {
    if (!acceptedCityIds.has(day.cityId)) continue
    addRelation('visited', journeyEntityId(day.id), day.cityId)
  }

  // ---- Relation：related_to（route from city → to city）----
  // Route 是多重边：同一对城市可能出现在多条 Route 上，所以 id 用 Route.id 而不是端点，
  // 并把 routeId / journeyId 写进 metadata，让查询层能把路线归属回具体 journey。
  for (const route of routes) {
    if (!acceptedCityIds.has(route.fromCityId) || !acceptedCityIds.has(route.toCityId)) continue
    const metadata: RelationMetadata = {}
    putIfPresent(metadata, 'kind', route.type)
    putIfPresent(metadata, 'routeId', route.id)
    putIfPresent(metadata, 'journeyId', route.journeyId)
    addRelation('related_to', route.fromCityId, route.toCityId, metadata, sourcedRelationId('related_to', route.id))
  }

  return { entities, memberships, anchors, relations }
}
