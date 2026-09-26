/**
 * 迁移清单与决定文件（RFC-LOC-1 §3.6，PR3a 规格 §2.5）。
 *
 * `src/data/migration/` 是 App 层的迁移工具，【不是】 StarMap Core。两个文件都在私人数据目录的
 * `data/migration/` 下：
 *
 * - `identity-manifest.local.json`：「稳定来源键 → UUID」，只增不改；记录上次 dry-run 时四个旧文件的
 *   哈希与时间。已有条目永不改变，所以 decisions 的改动不影响已分配的 UUID。
 * - `identity-decisions.local.json`：作者手写。迁移报告给出每个待决项的键，照抄即可。
 *
 * 这里只有类型与「读进来的 JSON 是否合法」的检查；解析失败抛 `IdentityFileError`，
 * 消息只说哪里不对，不带文件内容（键里有旧 id，旧 id 是地名的 slug）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { isUuidV7 } from '../canonical/uuidv7.ts'

export interface IdentityManifest {
  schema_version: 1
  /** 稳定来源键（`country:<旧键>`、`city:<旧键>`、`wtg:<条目 id>`、`iso:<CC>`）→ UUIDv7。 */
  sources: Record<string, string>
  /** 上次 dry-run 时四个旧文件原文的 sha256（由 CLI 计算）。 */
  sourceHash?: string
  /** 上次规划的时间（ISO 8601）。 */
  plannedAt?: string
}

export type DuplicateDecision = 'merge' | 'separate'
export type AcceptDecision = 'accept'

export interface IdentityDecisions {
  schema_version: 1
  /** 键 `wtg:<条目 id>|city:<足迹城市旧 id>`。 */
  duplicates?: Record<string, DuplicateDecision>
  /** 键 `wtg:<条目 id>`。 */
  nameDifferences?: Record<string, AcceptDecision>
  /** 键 `wtg:<条目 id>`。 */
  coordinateDifferences?: Record<string, AcceptDecision>
}

export class IdentityFileError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 空清单。 */
export const emptyManifest = (): IdentityManifest => ({ schema_version: 1, sources: {} })

/** 读进来的清单 → `IdentityManifest`。不合法时抛 `IdentityFileError`。 */
export function parseIdentityManifest(value: unknown): IdentityManifest {
  if (!isObject(value)) throw new IdentityFileError('迁移清单不是一个对象。')
  if (value.schema_version !== 1) throw new IdentityFileError('迁移清单的 schema_version 不是 1。')
  if (!isObject(value.sources)) throw new IdentityFileError('迁移清单的 sources 不是对象。')
  const seen = new Set<string>()
  let position = 0
  for (const uuid of Object.values(value.sources)) {
    position += 1
    if (!isUuidV7(uuid)) throw new IdentityFileError(`迁移清单 sources 的第 ${position} 项不是小写的 UUIDv7。`)
    if (seen.has(uuid)) throw new IdentityFileError(`迁移清单 sources 的第 ${position} 项与前面的某一项是同一个 UUID。`)
    seen.add(uuid)
  }
  for (const key of ['sourceHash', 'plannedAt'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new IdentityFileError(`迁移清单的 ${key} 不是字符串。`)
  }
  return {
    schema_version: 1,
    sources: { ...(value.sources as Record<string, string>) },
    ...(value.sourceHash !== undefined ? { sourceHash: value.sourceHash as string } : {}),
    ...(value.plannedAt !== undefined ? { plannedAt: value.plannedAt as string } : {}),
  }
}

const decisionTable = <T extends string>(value: unknown, name: string, allowed: readonly T[]): Record<string, T> | undefined => {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new IdentityFileError(`决定文件的 ${name} 不是对象。`)
  let position = 0
  for (const decision of Object.values(value)) {
    position += 1
    if (!allowed.includes(decision as T)) {
      throw new IdentityFileError(`决定文件 ${name} 的第 ${position} 项只能是 ${allowed.join(' / ')}。`)
    }
  }
  return { ...(value as Record<string, T>) }
}

/** 读进来的决定文件 → `IdentityDecisions`。不合法时抛 `IdentityFileError`。 */
export function parseIdentityDecisions(value: unknown): IdentityDecisions {
  if (!isObject(value)) throw new IdentityFileError('决定文件不是一个对象。')
  if (value.schema_version !== 1) throw new IdentityFileError('决定文件的 schema_version 不是 1。')
  for (const key of Object.keys(value)) {
    if (!['schema_version', 'duplicates', 'nameDifferences', 'coordinateDifferences'].includes(key)) {
      throw new IdentityFileError('决定文件里有不认识的字段（只允许 duplicates、nameDifferences、coordinateDifferences）。')
    }
  }
  const duplicates = decisionTable<DuplicateDecision>(value.duplicates, 'duplicates', ['merge', 'separate'])
  const nameDifferences = decisionTable<AcceptDecision>(value.nameDifferences, 'nameDifferences', ['accept'])
  const coordinateDifferences = decisionTable<AcceptDecision>(value.coordinateDifferences, 'coordinateDifferences', ['accept'])
  return {
    schema_version: 1,
    ...(duplicates ? { duplicates } : {}),
    ...(nameDifferences ? { nameDifferences } : {}),
    ...(coordinateDifferences ? { coordinateDifferences } : {}),
  }
}
