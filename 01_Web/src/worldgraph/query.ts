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
 *    CesiumAtlasGlobe 里 `mappedRoutes` 的行为，只是把数据源从领域对象换成快照；
 *    `src/worldgraph/query.parity.test.ts` 用逐字复制的 legacy 逻辑把这件事钉死。
 *
 * 5. FR-MR-5「同一地点在两层」在这里合并，而不是在 Globe 里：非足迹的城市地点，若
 *    `(countryCode, slug(英文名))` 与一个【可见的】足迹城市相同，就并进那个足迹地点
 *    （`layerIds` 追加、`membershipMetadata` 合并、`mergedEntityIds` 记下来源），自身不再输出。
 *    足迹不可见时不合并，想去地点按自己的样式单独出现。剩下的非足迹地点之间同键只留第一个
 *    （快照合并顺序是 travel → want-to-go → planned，所以想去先于 planned）。国家地点不参与合并。
 */

import { cityEntityId } from './adapters/travel.ts'
import { officialLayers, TRAVEL_LAYER_ID } from './layers.ts'
import { slugify } from './slug.ts'
import type { Anchor, Entity, EntityId, LayerId, Relation, WorldGraphSnapshot } from './types.ts'

/** 地图渲染一个地点标记需要的最小信息。字段能一一对应到 CesiumAtlasGlobe 的用法。 */
export interface LayerPlace {
  entityId: EntityId
  /** 来源领域对象 id（travel 为 CityId），来自 Entity.metadata.sourceId；没有则等于 entityId */
  sourceId: string
  subtype: 'region' | 'country' | 'city' | undefined
  title: { zh: string; en?: string }
  lat: number
  lng: number
  /** 该地点在哪些【可见】图层里，按 officialLayers.order 排序 */
  layerIds: LayerId[]
  /** travel：所属国家的 Entity id 与领域 id（metadata.countryId） */
  countryEntityId?: EntityId
  countryId?: string
  /**
   * 两位大写国家代码，FR-MR-5 合并键的一半。足迹城市取 part_of 目标国家 Entity 的
   * metadata.flagCode；想去 / planned 地点取自身 metadata.countryCode。拿不到时不产出该键。
   */
  countryCode?: string
  /** FR-MR-5：被并入本地点的其他 Entity（例如同一城市的想去条目），按并入顺序。没有合并时不产出该键。 */
  mergedEntityIds?: EntityId[]
  /** 标记主色：优先自身 metadata.accent，其次所属国家 Entity 的 metadata.accent */
  accent?: string
  /** 指向本地点的 visited Relation 数量（journey → place）；没有则 0 */
  visitCount: number
  /** 各可见图层的 membership.metadata（note / hidden / source 等），键为 LayerId */
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

/** 领域 id：Entity.metadata.sourceId，没有则回落到 EntityId 本身。 */
const sourceIdOf = (entity: Entity): string => asString(entity.metadata.sourceId) ?? entity.id

/** 两位字母才算国家代码，统一大写；其它形状一律视为没有（这样的地点不参与 FR-MR-5 合并）。 */
const asCountryCode = (value: unknown): string | undefined => {
  const code = asString(value)?.trim().toUpperCase()
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
}

/** 按 Registry 的 order 排序；不在 Registry 里的图层排最后。 */
const sortByLayerOrder = (layerIds: readonly LayerId[], layerOrder: Map<LayerId, number>): LayerId[] =>
  [...layerIds].sort(
    (a, b) => (layerOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (layerOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
  )

/** FR-MR-5 合并键：`<countryCode>:<slug(英文名，没有则中文名)>`。只有城市参与；拿不到国家代码或 slug 为空时不合并。 */
const mergeKeyOf = (place: LayerPlace): string | undefined => {
  if (place.subtype !== 'city' || place.countryCode === undefined) return undefined
  const slug = slugify(place.title.en ?? place.title.zh)
  return slug === '' ? undefined : `${place.countryCode}:${slug}`
}

/**
 * FR-MR-5：把"同一地点在多层"的重复标记合并掉（规则见文件头第 5 条）。
 * 入参 places 是本次查询新造的对象，可以就地改；输入快照里的对象一个也不碰。
 */
const mergeSamePlaces = (places: LayerPlace[], layerOrder: Map<LayerId, number>): LayerPlace[] => {
  const travelPlaceByKey = new Map<string, LayerPlace>()
  for (const place of places) {
    if (!place.layerIds.includes(TRAVEL_LAYER_ID)) continue
    const key = mergeKeyOf(place)
    if (key !== undefined && !travelPlaceByKey.has(key)) travelPlaceByKey.set(key, place)
  }

  const keptOtherPlaceByKey = new Map<string, LayerPlace>()
  const merged: LayerPlace[] = []
  for (const place of places) {
    const key = place.layerIds.includes(TRAVEL_LAYER_ID) ? undefined : mergeKeyOf(place)
    if (key === undefined) {
      merged.push(place)
      continue
    }

    const travelPlace = travelPlaceByKey.get(key)
    if (travelPlace) {
      travelPlace.layerIds = sortByLayerOrder(
        [...new Set([...travelPlace.layerIds, ...place.layerIds])],
        layerOrder,
      )
      // 逐层合并，足迹地点已有的层不覆盖；复制一份，免得改到别处共享的对象。
      const membershipMetadata = { ...travelPlace.membershipMetadata }
      for (const layerId of Object.keys(place.membershipMetadata) as LayerId[]) {
        if (membershipMetadata[layerId] === undefined) {
          membershipMetadata[layerId] = place.membershipMetadata[layerId]
        }
      }
      travelPlace.membershipMetadata = membershipMetadata
      travelPlace.mergedEntityIds = [...(travelPlace.mergedEntityIds ?? []), place.entityId]
      continue
    }

    const keptPlace = keptOtherPlaceByKey.get(key)
    if (keptPlace) {
      keptPlace.mergedEntityIds = [...(keptPlace.mergedEntityIds ?? []), place.entityId]
      continue
    }

    keptOtherPlaceByKey.set(key, place)
    merged.push(place)
  }
  return merged
}

/**
 * 把一份快照 + 一组可见图层，投影成地图要渲染的地点与路线。
 *
 * places 的顺序 = Entity 在 `snapshot.entities` 里的顺序（稳定，便于逐条对比），
 * 被 FR-MR-5 并入别处的地点从中删去，其余相对顺序不变；
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

  /** 领域 countryId：来自 part_of 的目标 Entity（travel 快照里 sourceId 与 countryId 相同）。 */
  const countryIdOf = (entityId: EntityId): string | undefined => {
    const country = countryEntityOf(entityId)
    if (!country) return undefined
    return asString(country.metadata.sourceId) ?? asString(country.metadata.countryId)
  }

  // ---- membership：只取可见图层、且没有被标记 hidden 的成员关系 ----
  const layerIdsByEntityId = new Map<EntityId, LayerId[]>()
  const membershipMetadataByEntityId = new Map<EntityId, Partial<Record<LayerId, Record<string, unknown>>>>()

  for (const membership of snapshot.memberships) {
    if (!visible.has(membership.layerId)) continue
    if (membership.metadata?.hidden === true) continue

    const layerIds = layerIdsByEntityId.get(membership.entityId) ?? []
    if (!layerIds.includes(membership.layerId)) layerIds.push(membership.layerId)
    layerIdsByEntityId.set(membership.entityId, layerIds)

    if (membership.metadata !== undefined) {
      const metadataByLayer = membershipMetadataByEntityId.get(membership.entityId) ?? {}
      metadataByLayer[membership.layerId] = membership.metadata
      membershipMetadataByEntityId.set(membership.entityId, metadataByLayer)
    }
  }

  // ---- places ----
  const places: LayerPlace[] = []
  for (const entity of snapshot.entities) {
    if (entityById.get(entity.id) !== entity) continue
    if (entity.type !== 'place') continue

    // 只保留"允许这个 subtype 上图"的可见图层：足迹的国家 Entity 在这里被排除，
    // 想去的国家条目则留下（文件头第 3 条）。
    const subtype = entity.subtype
    const layerIds = (layerIdsByEntityId.get(entity.id) ?? []).filter(
      (layerId) => subtype !== undefined && (mapSubtypesByLayerId.get(layerId)?.has(subtype) ?? false),
    )
    if (layerIds.length === 0) continue

    // 没有坐标的 Entity 是合法的（D06 / FR-TA-3），只是地图画不出来。
    const anchor = locationByEntityId.get(entity.id)
    if (!anchor) continue

    const country = countryEntityOf(entity.id)
    const accent = asString(entity.metadata.accent) ?? (country ? asString(country.metadata.accent) : undefined)

    const place: LayerPlace = {
      entityId: entity.id,
      sourceId: sourceIdOf(entity),
      subtype: entity.subtype,
      title: entity.title.en === undefined
        ? { zh: entity.title.zh }
        : { zh: entity.title.zh, en: entity.title.en },
      lat: anchor.lat as number,
      lng: anchor.lng as number,
      layerIds: sortByLayerOrder(layerIds, layerOrder),
      visitCount: visitCountByEntityId.get(entity.id) ?? 0,
      membershipMetadata: {},
    }
    // 只带出留在 layerIds 里的那些图层的 metadata，与 layerIds 保持同一口径。
    const metadataByLayer = membershipMetadataByEntityId.get(entity.id) ?? {}
    for (const layerId of place.layerIds) {
      const metadata = metadataByLayer[layerId]
      if (metadata !== undefined) place.membershipMetadata[layerId] = metadata
    }
    if (country) {
      place.countryEntityId = country.id
      const countryId = countryIdOf(entity.id)
      if (countryId !== undefined) place.countryId = countryId
    }
    if (accent !== undefined) place.accent = accent
    // 足迹城市的国家代码在所属国家 Entity 上（flagCode）；想去 / planned 地点自己带 countryCode。
    const countryCode = country
      ? asCountryCode(country.metadata.flagCode)
      : asCountryCode(entity.metadata.countryCode)
    if (countryCode !== undefined) place.countryCode = countryCode

    places.push(place)
  }

  return {
    visibleLayerIds: [...visibleLayerIds],
    places: mergeSamePlaces(places, layerOrder),
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
 * 1. `orderedCountryRoutes`：每个国家按 `metadata.cityIds` 顺序取相邻两两成段，
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

  // ---- 1. 国家内的顺序段 ----
  for (const entity of snapshot.entities) {
    if (entity.type !== 'place' || entity.subtype !== 'country') continue
    const cityIds = entity.metadata.cityIds
    if (!Array.isArray(cityIds)) continue
    const countrySourceId = sourceIdOf(entity)

    for (let index = 0; index + 1 < cityIds.length; index += 1) {
      const fromCityId = asString(cityIds[index])
      const toCityId = asString(cityIds[index + 1])
      if (fromCityId === undefined || toCityId === undefined) continue

      const fromEntityId = cityEntityId(fromCityId)
      const toEntityId = cityEntityId(toCityId)
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
          `country-order__${countrySourceId}__${fromCityId}__${toCityId}`,
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
      fromSourceId: sourceIdOf(from),
      toSourceId: sourceIdOf(to),
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
