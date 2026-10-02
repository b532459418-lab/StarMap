/**
 * 图层查询 —— 把一份 World Graph 快照 + 一组【可见】图层 id，投影成地图可以直接渲染的集合。
 *
 * 【待《World Graph Core Model RFC》定稿】本文件是 PRD 级草案
 * （StarMap V0.4 Layer Engine PRD v0.1 FR-LR-3 / FR-MR-1..FR-MR-5）。
 *
 * 设计约束（都有具体原因，改之前先读完）：
 *
 * 1. 纯函数：不修改输入、不读时钟、不读环境、不用 import.meta。同样的输入两次调用
 *    产出 deepEqual 的结果。本文件属于 World Graph Core（`src/worldgraph/**`），
 *    受 eslint 的 FR-MOD 边界约束：不得 import `src/components/**` 或
 *    `src/data/travelAtlas.ts`。
 *
 * 2. 输出【只】描述"画什么"，不描述"怎么画"。Cesium 相关的东西（Cartesian3、
 *    弧线采样、颜色对象）一律留在 CesiumAtlasGlobe 里。所以这里只给经纬度，
 *    不给 positions。
 *
 * 3. 画哪些 subtype 由图层自己声明（`LayerDefinition.mapSubtypes`），查询里不写死 `city`：
 *    一个地点至少在一个【可见且允许它的 subtype】的图层里才进 places，`layerIds` 也只保留
 *    这些图层。足迹只画城市（国家中心点从来不画，与 PR3 一致）；想去画城市与国家（PRD Q5）。
 *
 * 4. 路线只在 travel 图层可见时才计算（FR-LR-3）。计算规则逐条复刻 PR3 之前
 *    CesiumAtlasGlobe 里 `mappedRoutes` 的行为，只是把数据源从领域对象换成快照
 *    （PR3 起由一份逐字复制旧逻辑的对等测试钉住，RFC-LOC-1 Core-A 退役了它；规则本身由 query.test.ts 覆盖）。
 *    国家内顺序段读国家足迹成员关系上的 `cityIds`。
 *
 * 5. FR-MR-5「同一地点在两层」按身份合并（RFC-LOC-1 Core 方案 C4）：地点实体 id 就是注册表的地点 id，
 *    同一地点在足迹与想去两层就是同一个实体的两条成员关系。一个实体在哪些可见图层里有未隐藏的成员关系，
 *    就在哪些层出现，地图上只画一个标记，`layerIds` 列出这些层（足迹 + 想去即心形徽标）；关掉足迹时，
 *    同一个实体按想去样式出现。不再按名字合并：名字相同但不是同一地点的城市各自一个标记。
 *    同一地点在同一层有几条记录（例如一条想去加一条 planned），也只画一个标记：`recordIds` 列出可见记录，
 *    `membershipMetadata` 取每层第一条可见成员关系的 metadata（快照合并顺序是 places → travel → want-to-go → planned，
 *    所以想去先于 planned）。
 */

import { officialLayers, TRAVEL_LAYER_ID } from './layers.ts'
import type { Anchor, Entity, EntityId, LayerId, LayerMembership, Relation, WorldGraphSnapshot } from './types.ts'

/**
 * 地图渲染一个地点标记需要的最小信息。字段能一一对应到 CesiumAtlasGlobe 的用法。
 *
 * 足迹相关的四个字段（`visitCount`、`countryEntityId`、`countryId`、`accent`）只在地点出现在足迹层
 * （`layerIds` 含 travel）时给出：它们描述足迹标记的样式与行为，按想去样式出现的标记不使用它们。
 */
export interface LayerPlace {
  entityId: EntityId
  /** 现在恒等于 `entityId`（地点 id 就是领域 id，Core 方案 C1）。保留给今天的调用方，留待以后清理。 */
  sourceId: string
  subtype: 'region' | 'country' | 'city' | undefined
  title: { zh: string; en?: string }
  lat: number
  lng: number
  /** 该地点在哪些【可见】图层里（有一条可见、未隐藏的成员关系），按 officialLayers.order 排序 */
  layerIds: LayerId[]
  /** 足迹层：part_of 指向的所属国家的实体 id（地点 id） */
  countryEntityId?: EntityId
  /** 足迹层：所属国家的领域 id；与 `countryEntityId` 相同（地点 id） */
  countryId?: string
  /** 两位大写国家代码，取地点实体的 metadata.countryCode。拿不到时不产出该键。 */
  countryCode?: string
  /**
   * 每个可见层里可见（未隐藏）记录的 id（成员关系的 recordId），按快照顺序；没有记录 id 的层（例如足迹）不写，
   * 一层都没有时不产出该键。同一地点有几条想去 / planned 记录，地图上仍只画一个标记（Core 方案 C4）。
   */
  recordIds?: Partial<Record<LayerId, string[]>>
  /** 足迹层的标记主色：地点自己足迹成员关系 metadata 的 accent，没有则取所属国家足迹成员关系的 accent */
  accent?: string
  /** 足迹层：指向本地点的 visited Relation 数量（journey → place）；不在足迹层或没有则 0 */
  visitCount: number
  /** 各可见图层里【第一条】可见成员关系的 metadata（note / hidden / source 等），键为 LayerId */
  membershipMetadata: Partial<Record<LayerId, Record<string, unknown>>>
}

/** 一段可渲染路线。fromLat… 直接来自两端的 location Anchor；positions 由 Globe 自己算（Cesium 相关）。 */
export interface LayerRouteSegment {
  id: string
  fromEntityId: EntityId
  toEntityId: EntityId
  fromSourceId: string
  toSourceId: string
  fromCountryId?: string
  toCountryId?: string
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  journeyId?: string
  kind: 'main' | 'dayTrip' | 'flight' | 'ferry' | 'drive'
}

export interface LayerQueryResult {
  visibleLayerIds: LayerId[]
  places: LayerPlace[]
  routes: LayerRouteSegment[]
}

type RouteKind = LayerRouteSegment['kind']

const routeKinds: readonly RouteKind[] = ['main', 'dayTrip', 'flight', 'ferry', 'drive']

/** 默认路线种类。与 PR3 之前 `mappedRoutes` 里的 `existingRoute?.type ?? 'main'` 一致。 */
const defaultRouteKind: RouteKind = 'main'

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const asRouteKind = (value: unknown): RouteKind | undefined =>
  routeKinds.find((kind) => kind === value)

/** 坐标必须是有限数字才算数：null / undefined / NaN 都判为"没有坐标"（与 travel 适配器同一判据）。 */
const isFiniteCoordinate = (anchor: Anchor): boolean =>
  typeof anchor.lat === 'number' &&
  Number.isFinite(anchor.lat) &&
  typeof anchor.lng === 'number' &&
  Number.isFinite(anchor.lng)

/** 两位字母才算国家代码，统一大写；其它形状一律视为没有。 */
const asCountryCode = (value: unknown): string | undefined => {
  const code = asString(value)?.trim().toUpperCase()
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
}

/** 按 Registry 的 order 排序；不在 Registry 里的图层排最后。 */
const sortByLayerOrder = (layerIds: readonly LayerId[], layerOrder: Map<LayerId, number>): LayerId[] =>
  [...layerIds].sort(
    (a, b) => (layerOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (layerOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
  )

/** 一个实体在某一层的可见成员关系汇总：第一条的 metadata 与全部 recordId。 */
interface VisibleLayerMembers {
  /** 第一条可见成员关系（它的 metadata 进 LayerPlace.membershipMetadata）。 */
  first: LayerMembership
  /** 可见成员关系的 recordId，按快照顺序、去重。 */
  recordIds: string[]
}

/**
 * 把一份快照 + 一组可见图层，投影成地图要渲染的地点与路线。
 *
 * FR-MR-5「同一地点在两层」按身份合并（Core 方案 C4）：一个实体在哪些可见图层里有未隐藏的成员关系，
 * 就在哪些层出现，地图上只画一个标记，`layerIds` 列出这些层（足迹 + 想去即心形徽标）。
 *
 * places 的顺序 = Entity 在 `snapshot.entities` 里的顺序（稳定，便于逐条对比）；
 * routes 的顺序 = 先国家内顺序段、后跨国段，各自保持遍历顺序。
 */
export const queryVisiblePlaces = (
  snapshot: WorldGraphSnapshot,
  visibleLayerIds: readonly LayerId[],
): LayerQueryResult => {
  const visible = new Set<LayerId>(visibleLayerIds)
  const layerOrder = new Map<LayerId, number>()
  /** LayerId → 该图层在地图上画的 subtype（Registry 的 mapSubtypes）。 */
  const mapSubtypesByLayerId = new Map<LayerId, Set<string>>()
  for (const layer of officialLayers) {
    layerOrder.set(layer.id, layer.order)
    mapSubtypesByLayerId.set(layer.id, new Set(layer.mapSubtypes))
  }

  const entityById = new Map<EntityId, Entity>()
  for (const entity of snapshot.entities) {
    if (!entityById.has(entity.id)) entityById.set(entity.id, entity)
  }

  // ---- location Anchor：每个 Entity 取第一条有有限坐标的 location Anchor ----
  const locationByEntityId = new Map<EntityId, Anchor>()
  for (const anchor of snapshot.anchors) {
    if (anchor.kind !== 'location') continue
    if (!isFiniteCoordinate(anchor)) continue
    if (!locationByEntityId.has(anchor.entityId)) locationByEntityId.set(anchor.entityId, anchor)
  }

  // ---- Relation 索引 ----
  const visitCountByEntityId = new Map<EntityId, number>()
  /** 到访过某个地点的 journeyId 列表，顺序 = relations 数组顺序（含 undefined，保留位置）。 */
  const visitJourneyIdsByEntityId = new Map<EntityId, (string | undefined)[]>()
  const partOfByEntityId = new Map<EntityId, EntityId>()
  const relatedToRelations: Relation[] = []

  for (const relation of snapshot.relations) {
    if (relation.type === 'visited') {
      visitCountByEntityId.set(relation.toEntityId, (visitCountByEntityId.get(relation.toEntityId) ?? 0) + 1)
      const journey = entityById.get(relation.fromEntityId)
      const journeyIds = visitJourneyIdsByEntityId.get(relation.toEntityId) ?? []
      journeyIds.push(journey ? asString(journey.metadata.journeyId) : undefined)
      visitJourneyIdsByEntityId.set(relation.toEntityId, journeyIds)
      continue
    }
    if (relation.type === 'part_of') {
      if (!partOfByEntityId.has(relation.fromEntityId)) {
        partOfByEntityId.set(relation.fromEntityId, relation.toEntityId)
      }
      continue
    }
    if (relation.type === 'related_to') relatedToRelations.push(relation)
  }

  const countryEntityOf = (entityId: EntityId): Entity | undefined => {
    const countryId = partOfByEntityId.get(entityId)
    return countryId === undefined ? undefined : entityById.get(countryId)
  }

  /** 领域 countryId：part_of 的目标实体的 id。地点 id 就是领域 id（Core 方案 C1）。 */
  const countryIdOf = (entityId: EntityId): string | undefined => countryEntityOf(entityId)?.id

  // ---- 足迹成员关系：每个实体第一条，不看可见性与隐藏。查询要读的 accent / cityIds 在它的 metadata 上 ----
  const travelMembershipByEntityId = new Map<EntityId, LayerMembership>()
  for (const membership of snapshot.memberships) {
    if (membership.layerId !== TRAVEL_LAYER_ID) continue
    if (!travelMembershipByEntityId.has(membership.entityId)) travelMembershipByEntityId.set(membership.entityId, membership)
  }
  const travelAccentOf = (entityId: EntityId): string | undefined =>
    asString(travelMembershipByEntityId.get(entityId)?.metadata?.accent)

  // ---- membership：只取可见图层、且没有被标记 hidden 的成员关系 ----
  const visibleMembersByEntityId = new Map<EntityId, Map<LayerId, VisibleLayerMembers>>()

  for (const membership of snapshot.memberships) {
    if (!visible.has(membership.layerId)) continue
    if (membership.metadata?.hidden === true) continue

    const byLayer = visibleMembersByEntityId.get(membership.entityId) ?? new Map<LayerId, VisibleLayerMembers>()
    visibleMembersByEntityId.set(membership.entityId, byLayer)
    const members = byLayer.get(membership.layerId) ?? { first: membership, recordIds: [] }
    byLayer.set(membership.layerId, members)
    if (membership.recordId !== undefined && !members.recordIds.includes(membership.recordId)) {
      members.recordIds.push(membership.recordId)
    }
  }

  // ---- places ----
  const places: LayerPlace[] = []
  for (const entity of snapshot.entities) {
    if (entityById.get(entity.id) !== entity) continue
    if (entity.type !== 'place') continue

    // 只保留"允许这个 subtype 上图"的可见图层：足迹层的国家在这里被排除，
    // 想去的国家条目则留下（文件头第 3 条）。
    const subtype = entity.subtype
    const membersByLayer = visibleMembersByEntityId.get(entity.id) ?? new Map<LayerId, VisibleLayerMembers>()
    const layerIds = [...membersByLayer.keys()].filter(
      (layerId) => subtype !== undefined && (mapSubtypesByLayerId.get(layerId)?.has(subtype) ?? false),
    )
    if (layerIds.length === 0) continue

    // 没有坐标的 Entity 是合法的（D06 / FR-TA-3），只是地图画不出来。
    const anchor = locationByEntityId.get(entity.id)
    if (!anchor) continue

    const place: LayerPlace = {
      entityId: entity.id,
      sourceId: entity.id,
      subtype: entity.subtype,
      title: entity.title.en === undefined
        ? { zh: entity.title.zh }
        : { zh: entity.title.zh, en: entity.title.en },
      lat: anchor.lat as number,
      lng: anchor.lng as number,
      layerIds: sortByLayerOrder(layerIds, layerOrder),
      visitCount: 0,
      membershipMetadata: {},
    }
    // 只带出留在 layerIds 里的那些图层的 metadata 与 recordId，与 layerIds 保持同一口径。
    const recordIds: Partial<Record<LayerId, string[]>> = {}
    for (const layerId of place.layerIds) {
      const members = membersByLayer.get(layerId)
      if (!members) continue
      if (members.first.metadata !== undefined) place.membershipMetadata[layerId] = members.first.metadata
      if (members.recordIds.length > 0) recordIds[layerId] = [...members.recordIds]
    }
    if (Object.keys(recordIds).length > 0) place.recordIds = recordIds

    // 足迹相关的字段只在地点出现在足迹层时给出（见 LayerPlace 的说明）。
    if (place.layerIds.includes(TRAVEL_LAYER_ID)) {
      place.visitCount = visitCountByEntityId.get(entity.id) ?? 0
      const country = countryEntityOf(entity.id)
      if (country) {
        place.countryEntityId = country.id
        place.countryId = country.id
      }
      const accent = travelAccentOf(entity.id) ?? (country ? travelAccentOf(country.id) : undefined)
      if (accent !== undefined) place.accent = accent
    }
    const countryCode = asCountryCode(entity.metadata.countryCode)
    if (countryCode !== undefined) place.countryCode = countryCode

    places.push(place)
  }

  return {
    visibleLayerIds: [...visibleLayerIds],
    places,
    routes: visible.has(TRAVEL_LAYER_ID) ? buildRoutes(snapshot, entityById, locationByEntityId, {
      relatedToRelations,
      visitJourneyIdsByEntityId,
      countryIdOf,
    }) : [],
  }
}

/** buildRoutes 需要的、已经在 queryVisiblePlaces 里算好的索引。 */
interface RouteIndexes {
  relatedToRelations: Relation[]
  visitJourneyIdsByEntityId: Map<EntityId, (string | undefined)[]>
  countryIdOf: (entityId: EntityId) => string | undefined
}

/** 合并前的一段路线：两端已确定，但还没查坐标、也还没丢掉缺 journeyId 的段。 */
interface PendingSegment {
  id: string
  fromEntityId: EntityId
  toEntityId: EntityId
  journeyId?: string
  kind: RouteKind
}

/**
 * 逐条复刻 PR3 之前 `CesiumAtlasGlobe.mappedRoutes` 的规则：
 *
 * 1. `orderedCountryRoutes`：每个国家按它足迹成员关系上 `metadata.cityIds` 的顺序取相邻两两成段，
 *    能在 `related_to` 里找到同端点的关系时用它的 routeId / journeyId / kind 覆盖；
 *    找不到 journeyId 时退回"两端共享的 journeyId"。
 * 2. `crossCountryRoutes`：所有两端国家不同的 `related_to` 关系。
 * 3. 合并后逐条：没有 journeyId、任一端没有 location Anchor → 丢弃。
 */
const buildRoutes = (
  snapshot: WorldGraphSnapshot,
  entityById: Map<EntityId, Entity>,
  locationByEntityId: Map<EntityId, Anchor>,
  indexes: RouteIndexes,
): LayerRouteSegment[] => {
  const { relatedToRelations, visitJourneyIdsByEntityId, countryIdOf } = indexes
  const pending: PendingSegment[] = []

  // ---- 1. 国家内的顺序段：国家的 cityIds 在它的足迹成员关系上，按成员关系的顺序遍历 ----
  const seenCountryIds = new Set<EntityId>()
  for (const membership of snapshot.memberships) {
    if (membership.layerId !== TRAVEL_LAYER_ID) continue
    const entity = entityById.get(membership.entityId)
    if (!entity || entity.type !== 'place' || entity.subtype !== 'country') continue
    if (seenCountryIds.has(entity.id)) continue
    seenCountryIds.add(entity.id)
    const cityIds = membership.metadata?.cityIds
    if (!Array.isArray(cityIds)) continue

    for (let index = 0; index + 1 < cityIds.length; index += 1) {
      const fromCityId = asString(cityIds[index])
      const toCityId = asString(cityIds[index + 1])
      if (fromCityId === undefined || toCityId === undefined) continue

      // 城市的实体 id 就是城市 id（地点 id）。
      const fromEntityId = fromCityId
      const toEntityId = toCityId
      if (!entityById.has(fromEntityId) || !entityById.has(toEntityId)) continue

      const existing = relatedToRelations.find(
        (relation) => relation.fromEntityId === fromEntityId && relation.toEntityId === toEntityId,
      )
      const fromJourneyIds = new Set(
        (visitJourneyIdsByEntityId.get(fromEntityId) ?? []).filter((journeyId) => Boolean(journeyId)),
      )
      const sharedJourneyId = (visitJourneyIdsByEntityId.get(toEntityId) ?? []).find(
        (journeyId) => journeyId !== undefined && fromJourneyIds.has(journeyId),
      )

      const segment: PendingSegment = {
        id:
          (existing ? asString(existing.metadata?.routeId) : undefined) ??
          `country-order__${entity.id}__${fromCityId}__${toCityId}`,
        fromEntityId,
        toEntityId,
        kind: (existing ? asRouteKind(existing.metadata?.kind) : undefined) ?? defaultRouteKind,
      }
      const journeyId = (existing ? asString(existing.metadata?.journeyId) : undefined) ?? sharedJourneyId
      if (journeyId !== undefined) segment.journeyId = journeyId
      pending.push(segment)
    }
  }

  // ---- 2. 跨国段 ----
  for (const relation of relatedToRelations) {
    const from = entityById.get(relation.fromEntityId)
    const to = entityById.get(relation.toEntityId)
    if (!from || !to) continue
    if (from.type !== 'place' || from.subtype !== 'city') continue
    if (to.type !== 'place' || to.subtype !== 'city') continue

    const fromCountryId = countryIdOf(from.id)
    const toCountryId = countryIdOf(to.id)
    if (fromCountryId === undefined || toCountryId === undefined) continue
    if (fromCountryId === toCountryId) continue

    const segment: PendingSegment = {
      // routeId 在 travel 快照里恒存在；缺失时退回 Relation 自己的 id，避免产出没有 id 的段。
      id: asString(relation.metadata?.routeId) ?? relation.id,
      fromEntityId: relation.fromEntityId,
      toEntityId: relation.toEntityId,
      kind: asRouteKind(relation.metadata?.kind) ?? defaultRouteKind,
    }
    const journeyId = asString(relation.metadata?.journeyId)
    if (journeyId !== undefined) segment.journeyId = journeyId
    pending.push(segment)
  }

  // ---- 3. 补坐标并过滤 ----
  const routes: LayerRouteSegment[] = []
  for (const segment of pending) {
    if (segment.journeyId === undefined) continue

    const from = entityById.get(segment.fromEntityId)
    const to = entityById.get(segment.toEntityId)
    const fromAnchor = locationByEntityId.get(segment.fromEntityId)
    const toAnchor = locationByEntityId.get(segment.toEntityId)
    if (!from || !to || !fromAnchor || !toAnchor) continue

    const route: LayerRouteSegment = {
      id: segment.id,
      fromEntityId: segment.fromEntityId,
      toEntityId: segment.toEntityId,
      fromSourceId: from.id,
      toSourceId: to.id,
      fromLat: fromAnchor.lat as number,
      fromLng: fromAnchor.lng as number,
      toLat: toAnchor.lat as number,
      toLng: toAnchor.lng as number,
      journeyId: segment.journeyId,
      kind: segment.kind,
    }
    const fromCountryId = countryIdOf(segment.fromEntityId)
    const toCountryId = countryIdOf(segment.toEntityId)
    if (fromCountryId !== undefined) route.fromCountryId = fromCountryId
    if (toCountryId !== undefined) route.toCountryId = toCountryId

    routes.push(route)
  }

  return routes
}
