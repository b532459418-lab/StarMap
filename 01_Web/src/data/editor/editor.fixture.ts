/**
 * The editor tests' shared data (RFC-LOC-1 PR3b-2; 3C-5 E: moved here from the retired V2 write layer's fixture). Not a
 * test file; the App never imports it.
 *
 * - `migratedFiles()`: the five V2 files of PR2's neutral personal-mode data (`consistentPersonalRaw`) after the PR3a
 *   migration (./fixtures/migrated-files.json, frozen since PR5b), a fresh object each time: Iceland (Reykjavik, Vik
 *   hidden in the editor state, Akureyri also referenced by a want-to-go item), the Faroe Islands (Torshavn, Gjogv,
 *   Klaksvik), Norway (Bergen with one planned record; Tromso referenced only by a hidden want-to-go item), Greenland
 *   (Nuuk, referenced only by a want-to-go item); two photos of Reykjavik and an aerial photo of Torshavn. The editor
 *   tests migrate it into a store (../store/v2Store.fixture.ts).
 * - `testContext()`: a deterministic UUID sequence (apart from the migration's), a fixed time and a small hand-written
 *   country catalog.
 */

/// <reference types="node" />

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { EN } from '../canonical/reconstruct.ts'
import type { CanonicalPlace } from '../canonical/types.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import { completeForWrite, integrityProblems } from '../compat/v2/v2Integrity.ts'
import type { V2FileKey, V2Files } from '../compat/v2/v2Schema.ts'
import { V2WriteError, type V2WriteErrorCode } from './errors.ts'
import type { CatalogCountry } from './rules/places.ts'

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
  // 第 2A 批：同名不同城（江苏苏州 / 安徽宿州，英文名都是 Suzhou）的用例。
  ['CN', catalogEntry('CN', '中国', 'China', 35, 105, 'Asia')],
])

/** 江苏苏州与安徽宿州（公开地理事实）：英文名都是 Suzhou，相距约 400 km。 */
export const SUZHOU_JS = { lat: 31.2989, lng: 120.5853 }
export const SUZHOU_AH = { lat: 33.6461, lng: 116.9641 }

/** The context of a write in the tests: its ids, its time and the country catalog. */
export interface EditorTestContext {
  newId(): string
  now: Date
  countryCatalog: ReadonlyMap<string, CatalogCountry>
}

export const testContext = (overrides: Partial<EditorTestContext> = {}): EditorTestContext => ({
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
