/**
 * Collection 查询 —— 把一份 World Graph 快照里某个图层的【全部】成员列成清单（PRD R10，PR7 规格 §3.1）。
 *
 * 【待《World Graph Core Model RFC》定稿】本文件是 PRD 级草案。
 *
 * 它与地图查询 `queryVisiblePlaces`（query.ts）并列，但口径刻意不同：
 *
 * 1. 不看图层可见性（FR-LP-6：图层开关只作用于地图）。调用方传一个 layerId，拿到的就是这个图层
 *    的全部成员，与这个图层在地图上是开是关无关。
 * 2. 包含已隐藏的条目（membership.metadata.hidden === true）：Collection 是恢复 / 彻底删除它们的地方。
 * 3. 包含没有坐标的条目（D06）：它们在地图上画不出来，Collection 是它们唯一的入口。
 * 4. 不做 FR-MR-5 的同地点合并：被并进足迹城市的想去条目在这里单独列出，才能单独隐藏。
 *
 * 搜索、筛选、排序（filterCollection）也放在这里，写成纯函数，方便测试。
 *
 * 约束同其它 Core 文件：纯函数，不改输入、不读时钟、不读环境、不用 import.meta；
 * 受 eslint 的 FR-MOD 边界约束，不得 import `src/components/**` 或 `src/data/travelAtlas.ts`。
 * 语法约束：erasable-only TypeScript（只用 type / interface）。
 */

import type { Anchor, AnchorPrecision, Entity, EntityId, LayerId, WorldGraphSnapshot } from './types.ts'

/** Collection 里的一行。字段都能一一对应到 CollectionPage 的用法。 */
export interface CollectionEntry {
  entityId: EntityId
  layerId: LayerId
  subtype: 'region' | 'country' | 'city' | undefined
  title: { zh: string; en?: string }
  /** 两位大写国家代码；取 entity.metadata.countryCode，形状不对或没有则省略。 */
  countryCode?: string
  /** membership.addedAt */
  addedAt: string
  addedBy: 'user' | 'rule'
  /** membership.metadata.hidden === true */
  hidden: boolean
  /** membership.metadata.readOnly === true（planned 旅行记录，FR-WTG-7） */
  readOnly: boolean
  /** membership.metadata.note，非空字符串才输出 */
  note?: string
  /** membership.metadata.source，非空字符串才输出 */
  source?: string
  /** 该 Entity 第一条有有限坐标的 location Anchor；没有则省略（D06） */
  location?: { lat: number; lng: number; precision: AnchorPrecision }
}

export type CollectionStatusFilter = 'all' | 'visible' | 'hidden'
export type CollectionSort = 'recent' | 'name' | 'country'

export interface CollectionFilter {
  text?: string
  status?: CollectionStatusFilter
  sort?: CollectionSort
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** 两位字母才算国家代码，统一大写；与 query.ts 同一判据。 */
const asCountryCode = (value: unknown): string | undefined => {
  const code = asString(value)?.trim().toUpperCase()
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined
}

/** 坐标必须是有限数字才算数：null / undefined / NaN 都判为"没有坐标"（与 query.ts 同一判据）。 */
const isFiniteCoordinate = (anchor: Anchor): boolean =>
  typeof anchor.lat === 'number' &&
  Number.isFinite(anchor.lat) &&
  typeof anchor.lng === 'number' &&
  Number.isFinite(anchor.lng)

/** 纯码点比较：不受运行环境 locale 影响，给日期与 id 这类 ASCII 键用。 */
const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const compareNameZh = (left: CollectionEntry, right: CollectionEntry): number =>
  left.title.zh.localeCompare(right.title.zh, 'zh-CN')

/** 默认顺序（'recent'）：addedAt 降序 → 同日按中文名升序 → 再按 entityId 升序，保证稳定。 */
const compareRecent = (left: CollectionEntry, right: CollectionEntry): number =>
  compareCodePoints(right.addedAt, left.addedAt) ||
  compareNameZh(left, right) ||
  compareCodePoints(left.entityId, right.entityId)

/** 'name'：中文名升序；同名按 entityId，保证稳定。 */
const compareName = (left: CollectionEntry, right: CollectionEntry): number =>
  compareNameZh(left, right) || compareCodePoints(left.entityId, right.entityId)

/** 'country'：国家代码升序，没有国家代码的排最后；同国再按 'name' 规则。 */
const compareCountry = (left: CollectionEntry, right: CollectionEntry): number => {
  if (left.countryCode !== right.countryCode) {
    if (left.countryCode === undefined) return 1
    if (right.countryCode === undefined) return -1
    return compareCodePoints(left.countryCode, right.countryCode)
  }
  return compareName(left, right)
}

const comparators: Record<CollectionSort, (left: CollectionEntry, right: CollectionEntry) => number> = {
  recent: compareRecent,
  name: compareName,
  country: compareCountry,
}

/**
 * 列出 `layerId` 图层的全部成员（含已隐藏、含无坐标），按默认顺序排好。
 *
 * - 只取 `type === 'place'` 且在快照里存在的 Entity；其余成员关系忽略。
 * - 同一 `(entityId, layerId)` 只取第一条成员关系（与 mergeWorldGraphSnapshots 的去重口径一致）。
 * - 返回的对象都是新造的，不与输入共享任何引用。
 */
export const queryCollection = (snapshot: WorldGraphSnapshot, layerId: LayerId): CollectionEntry[] => {
  const entityById = new Map<EntityId, Entity>()
  for (const entity of snapshot.entities) {
    if (!entityById.has(entity.id)) entityById.set(entity.id, entity)
  }

  const locationByEntityId = new Map<EntityId, Anchor>()
  for (const anchor of snapshot.anchors) {
    if (anchor.kind !== 'location') continue
    if (!isFiniteCoordinate(anchor)) continue
    if (!locationByEntityId.has(anchor.entityId)) locationByEntityId.set(anchor.entityId, anchor)
  }

  const seenEntityIds = new Set<EntityId>()
  const entries: CollectionEntry[] = []
  for (const membership of snapshot.memberships) {
    if (membership.layerId !== layerId) continue
    if (seenEntityIds.has(membership.entityId)) continue
    seenEntityIds.add(membership.entityId)

    const entity = entityById.get(membership.entityId)
    if (!entity || entity.type !== 'place') continue

    const metadata = membership.metadata ?? {}
    const entry: CollectionEntry = {
      entityId: entity.id,
      layerId: membership.layerId,
      subtype: entity.subtype,
      title: entity.title.en === undefined
        ? { zh: entity.title.zh }
        : { zh: entity.title.zh, en: entity.title.en },
      addedAt: membership.addedAt,
      addedBy: membership.addedBy,
      hidden: metadata.hidden === true,
      readOnly: metadata.readOnly === true,
    }

    const countryCode = asCountryCode(entity.metadata.countryCode)
    if (countryCode !== undefined) entry.countryCode = countryCode
    const note = asString(metadata.note)
    if (note !== undefined) entry.note = note
    const source = asString(metadata.source)
    if (source !== undefined) entry.source = source

    const anchor = locationByEntityId.get(entity.id)
    if (anchor) {
      entry.location = { lat: anchor.lat as number, lng: anchor.lng as number, precision: anchor.precision }
    }

    entries.push(entry)
  }

  return entries.sort(compareRecent)
}

/** 搜索用的规范化：全角 / 兼容字符先折叠（NFKC），再转小写。 */
const normalizeSearchText = (value: string): string => value.normalize('NFKC').toLowerCase()

/** 参与搜索的字段：中文名、英文名、国家代码、备注。用换行拼接，避免跨字段拼出假匹配。 */
const searchTextOf = (entry: CollectionEntry): string =>
  normalizeSearchText(
    [entry.title.zh, entry.title.en, entry.countryCode, entry.note]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('\n'),
  )

/**
 * 搜索 + 状态筛选 + 排序。纯函数：不改输入数组与其中的对象，返回新数组。
 *
 * - `text`：trim 后为空则不过滤；否则对中文名 / 英文名 / 国家代码 / 备注做大小写不敏感的包含匹配。
 * - `status`：`visible` 只留未隐藏、`hidden` 只留已隐藏，缺省 `all`。
 * - `sort`：`recent`（缺省，即 queryCollection 的默认顺序）/ `name` / `country`。
 */
export const filterCollection = (
  entries: readonly CollectionEntry[],
  filter: CollectionFilter,
): CollectionEntry[] => {
  const needle = normalizeSearchText((filter.text ?? '').trim())
  const status = filter.status ?? 'all'
  const compare = comparators[filter.sort ?? 'recent'] ?? compareRecent

  return entries
    .filter((entry) => {
      if (status === 'visible' && entry.hidden) return false
      if (status === 'hidden' && !entry.hidden) return false
      return needle === '' || searchTextOf(entry).includes(needle)
    })
    .sort(compare)
}
