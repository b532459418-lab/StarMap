/**
 * World Graph Core Model —— V0.4 子集。
 *
 * 【待《World Graph Core Model RFC》定稿】
 * 本文件是 PRD 级草案（StarMap V0.4 Layer Engine PRD v0.1 §6 FR-CM-1/FR-CM-2）。
 * 字段的增删以《World Graph Core Model RFC》为准；RFC 未定稿前，实现以 PRD §6 为准。
 * 不要在 RFC 定稿前把这些类型当作稳定契约向外扩散。
 *
 * 硬约束（来自《StarMap 产品战略与架构规划 v0.2》已定案决策）：
 * - D06  不强制所有 Entity 具有地理位置：没有 Anchor 的 Entity 是合法的。
 * - D14  Entity ↔ Layer 多对多：Entity 上【没有】 layerId 字段，归属只记在 LayerMembership 上。
 * - D15  Anchor 只连接坐标与时间：Anchor 上【没有】指向另一个 Entity 的字段，
 *        任何"指向 Entity"的语义一律走 Relation。
 * - D16  Anchor 自首版起携带 precision，并可选携带 visibility。
 * - D17  Relation 携带 provenance（user / rule / ai_suggested）。
 *
 * 语法约束：本文件必须是 erasable-only TypeScript（只用 type / interface，
 * 不用 enum / namespace / 参数属性），否则 Node 的类型剥离与 tsconfig 的
 * erasableSyntaxOnly 都会拒绝它。
 */

// ---- 标识 ----

export type EntityId = string

/** V0.4 官方 Layer；后续版本扩展。 */
export type LayerId = 'travel' | 'want_to_go'

/** V0.4 子集；'wish' 不是类型，见 PRD FR-WTG-1。 */
export type EntityType = 'place' | 'journey' | 'media'

/** Entity 的可见性等级。V0.4 恒为 'private'，权限 UI 属 0.8。 */
export type Visibility = 'private' | 'friends' | 'selected' | 'link' | 'public'

/** D16：Anchor 的精度等级。分享时的精度降级依赖它。 */
export type AnchorPrecision = 'exact' | 'city' | 'region' | 'hidden'

/** D15：Anchor 只连坐标与时间。 */
export type AnchorKind = 'location' | 'time' | 'event'

/** D17：Relation 的来源。ai_suggested 在用户确认前不参与投影与统计。 */
export type RelationProvenance = 'user' | 'rule' | 'ai_suggested'

export type RelationType =
  | 'visited'
  | 'captured_at'
  | 'watched'
  | 'listened'
  | 'saved'
  | 'want_to_go'
  | 'filmed_in'
  | 'story_in'
  | 'inspired'
  | 'part_of'
  | 'with_person'
  | 'created_by'
  | 'related_to'

// ---- 预留键（FR-CM-4 / D21）----
// V0.4 不写入、不读取这两个键，只保证类型上存在，避免 0.5 再改 schema。

export type EntityMetadata = Record<string, unknown> & {
  /** FR-CM-4 预留：条目级地图投影覆盖。V0.4 不使用。 */
  projection?: RelationType[]
}

export type RelationMetadata = Record<string, unknown> & {
  /** FR-CM-4 预留：用户自定义的关系角色标签。V0.4 不使用。 */
  roleLabel?: string
}

// ---- 五个核心对象中的四个（User 在 V0.4 隐含为本地单用户）----

export interface Entity {
  id: EntityId
  type: EntityType
  /** place 专用。 */
  subtype?: 'region' | 'country' | 'city'
  title: { zh: string; en?: string }
  summary?: string
  metadata: EntityMetadata
  /** V0.4 恒为 'private'。 */
  visibility: Visibility
  createdAt: string
  updatedAt: string
}

/**
 * D14：Entity 与 Layer 的多对多成员关系。
 * 复合主键是 (entityId, layerId)，没有独立 id（PRD §8.2）。
 */
export interface LayerMembership {
  entityId: EntityId
  layerId: LayerId
  addedBy: 'user' | 'rule'
  addedAt: string
  /** want_to_go: { note?: string; hidden?: boolean; source?: string } */
  metadata?: Record<string, unknown>
}

/**
 * D15：Anchor 只连接坐标与时间。
 * 这里【故意】没有任何指向另一个 Entity 的字段——那是 Relation 的职责。
 */
export interface Anchor {
  id: string
  entityId: EntityId
  kind: AnchorKind
  lat?: number
  lng?: number
  occurredAt?: string
  occurredUntil?: string
  /** D16：首版即存在。 */
  precision: AnchorPrecision
  /** 缺省继承所属 Entity 的 visibility。 */
  visibility?: Visibility
  /** 海拔等。 */
  metadata?: Record<string, unknown>
}

export interface Relation {
  id: string
  fromEntityId: EntityId
  toEntityId: EntityId
  type: RelationType
  /** D17。 */
  provenance: RelationProvenance
  metadata?: RelationMetadata
}

export interface WorldGraphSnapshot {
  entities: Entity[]
  memberships: LayerMembership[]
  anchors: Anchor[]
  relations: Relation[]
}
