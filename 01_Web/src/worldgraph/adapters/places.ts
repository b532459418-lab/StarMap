/**
 * Places Adapter —— 把地点注册表里的地点投影成 World Graph 的地点实体（RFC-LOC-1 Core 方案 C1、C2）。
 *
 * 【待《World Graph Core Model RFC》定稿】
 *
 * 设计约束（与其余适配器同源，改之前先读完）：
 *
 * 1. 地点实体【只】由本适配器构造，每个地点一次（C2）。足迹、想去、planned 三个适配器只产出成员关系
 *    （以及足迹的行程日与关系），按地点 id 引用这里的实体。因此同一地点无论被哪个适配器引用，
 *    快照里都只有这一个实体，`mergeWorldGraphSnapshots` 的「先到先得」不再有取舍。
 *
 * 2. 实体 id 就是注册表的地点 id，不加前缀（C1）。本模块不解析 id 的结构，也不从名称推导 id。
 *
 * 3. 纯函数：不读文件、不修改输入、不读时钟。时间戳唯一来源是 options.now，【必填】。
 *    输入由 App 从注册表映射好之后传进来（`PlaceInput` 是 Core 自己的类型，不 import App）。
 *
 * 4. 不产出成员关系：一个地点在哪些图层里，由引用它的记录决定，不由地点本身决定。
 */

import type { Anchor, Entity, EntityId, Relation, WorldGraphSnapshot } from '../types.ts'
import { anchorId, relationId } from './travel.ts'

/** 注册表里的一个地点，已由 App 映射成 Core 的形状。 */
export interface PlaceInput {
  /** 注册表地点 id（V2 里是 UUID），即实体 id，不加前缀。 */
  id: EntityId
  subtype: 'country' | 'city'
  /** 显示名称。Core-B 改为 LocalizedText；今天沿用 `Entity.title` 的形状。 */
  title: { zh: string; en?: string }
  /** 两位大写国家代码：国家取自身 ISO，城市取所属国家的 ISO。拿不到时省略。 */
  countryCode?: string
  /** 城市 → 所属国家的地点 id。 */
  partOf?: EntityId
  /** 地点的规范坐标（RFC §3.2：记录上的坐标是记录级数据，地图不使用）。 */
  location?: { lat: number; lng: number }
}

export interface PlacesWorldGraphOptions {
  /** 注入 Entity.createdAt / updatedAt 的时间戳（ISO 8601）。【必填】，理由同 travel.ts。 */
  now: string
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 地点 → 实体：`type: 'place'`，`subtype` 与 `title` 照搬，`metadata` 只放 `countryCode`（有才写），
 * `visibility: 'private'`，`createdAt` 与 `updatedAt` 都是 `now`。返回新对象，不与输入共享引用。
 */
export const placeEntity = (place: PlaceInput, now: string): Entity => {
  const title: Entity['title'] = { zh: place.title.zh }
  if (place.title.en !== undefined) title.en = place.title.en
  const metadata: Entity['metadata'] = {}
  if (place.countryCode) metadata.countryCode = place.countryCode
  return {
    id: place.id,
    type: 'place',
    subtype: place.subtype,
    title,
    metadata,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 地点的位置锚点：lat / lng 都是有限数时才有（D06：没有坐标的地点是合法的）。
 * 精度按类型：国家 `'region'`（国家坐标是一个代表点），城市 `'exact'`。
 */
export const placeLocationAnchor = (place: PlaceInput): Anchor | undefined => {
  const location = place.location
  if (!location || !isFiniteNumber(location.lat) || !isFiniteNumber(location.lng)) return undefined
  return {
    id: anchorId('location', place.id),
    entityId: place.id,
    kind: 'location',
    lat: location.lat,
    lng: location.lng,
    precision: place.subtype === 'country' ? 'region' : 'exact',
  }
}

/**
 * 把注册表的地点投影成一个 World Graph 快照。
 *
 * - Entity：每个地点一个（`placeEntity`）
 * - Anchor：有坐标的地点一个 location Anchor（`placeLocationAnchor`）
 * - Relation：有 `partOf` 的地点一条 `part_of`（地点 → 所属地点，`provenance: 'rule'`）；
 *   目标不在输入里、或指向自己时不产出（不留悬空边）
 * - Membership：不产出（文件头第 4 条）
 *
 * 同一个 id 出现两次时第一条胜出，后续跳过；不修改输入，相同输入永远产出相同快照。
 */
export const placesToWorldGraph = (
  places: readonly PlaceInput[],
  options: PlacesWorldGraphOptions,
): WorldGraphSnapshot => {
  const entities: Entity[] = []
  const anchors: Anchor[] = []
  const relations: Relation[] = []
  const accepted: PlaceInput[] = []
  const acceptedIds = new Set<EntityId>()

  for (const place of places) {
    if (acceptedIds.has(place.id)) continue
    acceptedIds.add(place.id)
    accepted.push(place)
    entities.push(placeEntity(place, options.now))
    const anchor = placeLocationAnchor(place)
    if (anchor) anchors.push(anchor)
  }

  // part_of 只从被接受的地点派生，两端都必须在本快照里（与 travel.ts 的去重说明同理）。
  for (const place of accepted) {
    const target = place.partOf
    if (target === undefined || target === place.id || !acceptedIds.has(target)) continue
    relations.push({
      id: relationId('part_of', place.id, target),
      fromEntityId: place.id,
      toEntityId: target,
      type: 'part_of',
      provenance: 'rule',
    })
  }

  return { entities, memberships: [], anchors, relations }
}
