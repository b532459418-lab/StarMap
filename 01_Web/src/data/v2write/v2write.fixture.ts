/**
 * V2 写入（RFC-LOC-1 PR3b-2）测试共用的数据与调用方式。不是测试文件，App 代码从不 import 它。
 *
 * - `migratedFiles()`：PR2 的中性个人模式数据（`consistentPersonalRaw`）经 PR3a 迁移得到的五个 V2 文件——
 *   与真实用户迁移后的形态相同（地点 id 为 UUIDv7，想去的阿克雷里已并进足迹城市）。PR5b 起是冻结的静态文件
 *   `./fixtures/migrated-files.json`（删除迁移工具之前用当时的代码生成），每次读出新对象。内容：
 *   冰岛（雷克雅未克、维克〔editor 隐藏〕、阿克雷里〔也被想去引用〕）、法罗群岛（托尔斯港、杰格夫、克拉克斯维克）、
 *   挪威（卑尔根，只有一条 planned 记录；特罗姆瑟，只被隐藏的想去条目引用）、格陵兰（努克，只被想去引用）；
 *   雷克雅未克两张照片、托尔斯港一张航拍。
 * - `testContext()`：确定的 UUID 序列（与迁移的序列错开）、固定时间、一份手写的小国家目录。
 */

/// <reference types="node" />

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { EN } from '../canonical/reconstruct.ts'
import type { CanonicalPlace } from '../canonical/types.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import { jsonClone } from '../canonical/v2Serializer.ts'
import { V2WriteError, type V2WriteErrorCode } from './errors.ts'
import { completeForWrite, integrityProblems, type CatalogCountry, type V2Write, type V2WriteContext } from './transaction.ts'

/** 这次写入的时间：2026-09-27T08:00:00.000Z。 */
export const WRITE_NOW = new Date(Date.UTC(2026, 8, 27, 8))

/** 与迁移（2026-01-01 起）错开的 UUID 序列起点。 */
export const WRITE_EPOCH_MS = Date.UTC(2026, 8, 27)

const catalogEntry = (countryCode: string, nameZh: string, nameEn: string, centerLat: number, centerLng: number, region?: string): CatalogCountry => ({
  countryCode, nameZh, nameEn, centerLat, centerLng, ...(region ? { region } : {}),
})

/** 手写的国家目录（形状同插件的 world-countries 目录，键为大写 ISO）。 */
export const TEST_CATALOG: ReadonlyMap<string, CatalogCountry> = new Map([
  ['IS', catalogEntry('IS', '冰岛', 'Iceland', 65, -18, 'Europe')],
  ['FO', catalogEntry('FO', '法罗群岛', 'Faroe Islands', 62, -7, 'Europe')],
  ['NO', catalogEntry('NO', '挪威', 'Norway', 62, 10, 'Europe')],
  ['GL', catalogEntry('GL', '格陵兰', 'Greenland', 72, -40, 'Americas')],
  ['JP', catalogEntry('JP', '日本', 'Japan', 36, 138, 'Asia')],
  ['DK', catalogEntry('DK', '丹麦', 'Denmark', 56, 10, 'Europe')],
])

export const testContext = (overrides: Partial<V2WriteContext> = {}): V2WriteContext => ({
  newId: sequentialUuids(WRITE_EPOCH_MS),
  now: WRITE_NOW,
  countryCatalog: TEST_CATALOG,
  ...overrides,
})

/** 中性个人模式数据迁移后的五个 V2 文件（冻结的静态文件，每次新对象）。 */
export const migratedFiles = (): V2Files =>
  JSON.parse(readFileSync(new URL('./fixtures/migrated-files.json', import.meta.url), 'utf8')) as V2Files

/** 按英文名（可限定类型）找地点。 */
export const placeNamed = (files: V2Files, en: string, subtype?: 'country' | 'city'): CanonicalPlace => {
  const place = files.places.places.find((candidate) => candidate.names[EN] === en && (subtype === undefined || candidate.subtype === subtype))
  if (!place) throw new Error(`fixture：没有英文名为 ${en} 的地点`)
  return place
}

/** 把写入应用到文件上（模拟插件按顺序写盘）。 */
export const applyWrites = (files: Partial<V2Files>, writes: readonly V2Write[]): V2Files => {
  const next = jsonClone(files) as Record<V2FileKey, unknown>
  for (const write of writes) next[write.file] = jsonClone(write.value)
  return next as unknown as V2Files
}

/** 写入顺序：只看文件名。 */
export const writeOrder = (writes: readonly V2Write[]): V2FileKey[] => writes.map((write) => write.file)

/** 断言抛出指定码的 V2WriteError；给了 `message` 时文案也要逐字相同。 */
export const assertV2Error = (run: () => unknown, code: V2WriteErrorCode, message?: string, check?: (error: V2WriteError) => void) => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof V2WriteError, String(error))
    assert.equal(error.code, code, error.message)
    if (message !== undefined) assert.equal(error.message, message)
    check?.(error)
    return true
  })
}

/** 一个不存在的地点 id（合法的 UUIDv7）。 */
export const GHOST_ID = '019b76da-ffff-7000-8000-00000000ffff'

/** 五个文件（缺的补空）通过完整性检查。 */
export const assertIntact = (files: Partial<Record<V2FileKey, unknown>>, message = '') => {
  const problems = integrityProblems(completeForWrite(files, WRITE_NOW))
  if (problems.length > 0) throw new Error(`${message} 完整性检查没通过：\n${problems.join('\n')}`)
}
