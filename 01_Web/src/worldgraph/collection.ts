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
 * 4. 每条记录一行（成员关系的 recordId）：地图上同一地点只画一个标记（FR-MR-5 按身份合并），这里仍逐条列出，
 *    才能单独隐藏、编辑与转为足迹。`title`、`countryCode`、`location` 取自地点实体（RFC-LOC-1 Core-A：由注册表构造），
 *    隐藏、只读、备注、来源这些记录级字段取自成员关系。
 *
 * 搜索、筛选、排序（filterCollection）也放在这里，写成纯函数，方便测试。
 *
 * 约束同其它 Core 文件：纯函数，不改输入、不读时钟、不读环境、不用 import.meta；
 * 受 eslint 的 FR-MOD 边界约束，不得 import `src/components/**` 或 `src/data/travelAtlas.ts`。
 * 语法约束：erasable-only TypeScript（只用 type / interface）。
 */

import {
  copyLocalizedText,
  resolveName,
  searchableNames,
  type LanguageTag,
  type LocalizedText,
} from './localizedText.ts'
import type { Anchor, AnchorPrecision, Entity, EntityId, LayerId, WorldGraphSnapshot } from './types.ts'

/** Collection 里的一行。字段都能一一对应到 CollectionPage 的用法。 */
export interface CollectionEntry {
  entityId: EntityId
  layerId: LayerId
  /** membership.recordId：这一行背后的记录 id（想去条目 / planned 足迹）；成员关系没有时省略。 */
  recordId?: string
  subtype: 'region' | 'country' | 'city' | undefined
  /** 地点实体的多语言名称，原样传出（复制一份）；显示用 `resolveName` / `originalNameSubtitle`（./localizedText.ts）。 */
  title: LocalizedText
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

type CompareEntries = (left: CollectionEntry, right: CollectionEntry) => number

/**
 * 名称比较（RFC-LOC-1 Core 方案 C7）：`Intl.Collator(uiLocale)` 比较 `resolveName(title, uiLocale)`。
 * 界面语言无效或不受支持时用显式英文排序，不取运行环境的默认 locale。
 * 每个条目的显示名称只算一次。
 */
const nameComparator = (uiLocale: LanguageTag): CompareEntries => {
  let collator: Intl.Collator
  try {
    collator = new Intl.Collator(Intl.Collator.supportedLocalesOf(uiLocale).length > 0 ? uiLocale : 'en')
  } catch {
    collator = new Intl.Collator('en')
  }
  const names = new Map<CollectionEntry, string>()
  const nameOf = (entry: CollectionEntry): string => {
    let name = names.get(entry)
    if (name === undefined) {
      name = resolveName(entry.title, uiLocale)
      names.set(entry, name)
    }
    return name
  }
  return (left, right) => collator.compare(nameOf(left), nameOf(right))
}

/** 最后的稳定键：entityId 升序，再按 recordId 升序（没有 recordId 按空串算）。 */
const compareIdentity: CompareEntries = (left, right) =>
  compareCodePoints(left.entityId, right.entityId) ||
  compareCodePoints(left.recordId ?? '', right.recordId ?? '')

/**
 * 三种排序，名称都按界面语言比较（见 `nameComparator`）：
 * - 'recent'（默认顺序）：addedAt 降序 → 同日按名称升序 → 再按 entityId、recordId 升序，保证稳定。
 * - 'name'：名称升序；同名按 entityId、recordId，保证稳定。
 * - 'country'：国家代码升序，没有国家代码的排最后；同国再按 'name' 规则。
 */
const comparatorsFor = (uiLocale: LanguageTag): Record<CollectionSort, CompareEntries> => {
  const compareNames = nameComparator(uiLocale)
  const compareName: CompareEntries = (left, right) => compareNames(left, right) || compareIdentity(left, right)
  return {
    recent: (left, right) =>
      compareCodePoints(right.addedAt, left.addedAt) ||
      compareNames(left, right) ||
      compareIdentity(left, right),
    name: compareName,
    country: (left, right) => {
      if (left.countryCode !== right.countryCode) {
        if (left.countryCode === undefined) return 1
        if (right.countryCode === undefined) return -1
        return compareCodePoints(left.countryCode, right.countryCode)
      }
      return compareName(left, right)
    },
  }
}

/**
 * 列出 `layerId` 图层的全部成员（含已隐藏、含无坐标），按默认顺序排好。
 *
 * - 只取 `type === 'place'` 且在快照里存在的 Entity；其余成员关系忽略。
 * - 同一 `(entityId, layerId, recordId)` 只取第一条成员关系（没有 recordId 按空串算；与 mergeWorldGraphSnapshots 的去重口径一致）。
 *   同一实体在这个图层有几条不同记录，就列几行。
 * - 返回的对象都是新造的，不与输入共享任何引用。
 * - 默认顺序里同日的条目按名称排，名称按 `uiLocale`（界面语言）取与比较，见 `comparatorsFor`。
 */
export const queryCollection = (
  snapshot: WorldGraphSnapshot,
  layerId: LayerId,
  uiLocale: LanguageTag,
): CollectionEntry[] => {
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

  const seenMembershipKeys = new Set<string>()
  const entries: CollectionEntry[] = []
  for (const membership of snapshot.memberships) {
    if (membership.layerId !== layerId) continue
    // 与 snapshot.ts 的 membershipKey 同一写法：JSON 数组做键，避免 id 里的分隔符造成碰撞。
    const key = JSON.stringify([membership.entityId, membership.layerId, membership.recordId ?? ''])
    if (seenMembershipKeys.has(key)) continue
    seenMembershipKeys.add(key)

    const entity = entityById.get(membership.entityId)
    if (!entity || entity.type !== 'place') continue

    const metadata = membership.metadata ?? {}
    const entry: CollectionEntry = {
      entityId: entity.id,
      layerId: membership.layerId,
      subtype: entity.subtype,
      title: copyLocalizedText(entity.title),
      addedAt: membership.addedAt,
      addedBy: membership.addedBy,
      hidden: metadata.hidden === true,
      readOnly: metadata.readOnly === true,
    }
    if (membership.recordId !== undefined) entry.recordId = membership.recordId

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

  return entries.sort(comparatorsFor(uiLocale).recent)
}

/** 搜索用的规范化：全角 / 兼容字符先折叠（NFKC），再转小写。 */
const normalizeSearchText = (value: string): string => value.normalize('NFKC').toLowerCase()

/**
 * 参与搜索的字段：名称的全部语言（`searchableNames`，RFC LOC-3：不只是当前显示的那个）、国家代码、备注。
 * 用换行拼接，避免跨字段拼出假匹配。
 */
const searchTextOf = (entry: CollectionEntry): string =>
  normalizeSearchText(
    [...searchableNames(entry.title), entry.countryCode, entry.note]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('\n'),
  )

/**
 * 搜索 + 状态筛选 + 排序。纯函数：不改输入数组与其中的对象，返回新数组。
 *
 * - `text`：trim 后为空则不过滤；否则对名称（任何语言）/ 国家代码 / 备注做大小写不敏感的包含匹配。
 * - `status`：`visible` 只留未隐藏、`hidden` 只留已隐藏，缺省 `all`。
 * - `sort`：`recent`（缺省，即 queryCollection 的默认顺序）/ `name` / `country`。
 * - `uiLocale`：界面语言。排序里的名称是 `resolveName(title, uiLocale)`，用 `Intl.Collator(uiLocale)` 比较。
 *   它与 `filter` 分开传：`filter` 是用户在页面上选的条件，界面语言不是。
 */
export const filterCollection = (
  entries: readonly CollectionEntry[],
  filter: CollectionFilter,
  uiLocale: LanguageTag,
): CollectionEntry[] => {
  const needle = normalizeSearchText((filter.text ?? '').trim())
  const status = filter.status ?? 'all'
  const comparators = comparatorsFor(uiLocale)
  const compare = comparators[filter.sort ?? 'recent'] ?? comparators.recent

  return entries
    .filter((entry) => {
      if (status === 'visible' && entry.hidden) return false
      if (status === 'hidden' && !entry.hidden) return false
      return needle === '' || searchTextOf(entry).includes(needle)
    })
    .sort(compare)
}
