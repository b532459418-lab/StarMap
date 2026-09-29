/**
 * 冻结夹具的等价证明（RFC-LOC-1 PR5b §4.1）。只在冻结那一个提交里存在：下一个提交删除 Legacy Adapter 与迁移规划时，
 * 本文件与 ./frozenSources.fixture.ts 一起删除。
 *
 * - `./fixtures/` 与 `../v2write/fixtures/` 下每份静态文件，与原生成函数（./frozenSources.fixture.ts）现场生成的结果深相等；
 * - 旧 id 空间的 Canonical 冻结时经过一次 JSON 往返：与未往返的原值相比只少了值为 undefined 的键
 *   （原始记录上显式写成 undefined 的 `trip_title` / `region`），派生出的基线逐字节相同；
 * - 旧 id 空间的每份 Canonical，冻结后的派生基线都等于旧路径 B（`deriveAppData(normalizeLegacy(原始数据))`），
 *   所以 derive.test.ts 里锁定的哈希就是今天「B ≡ C」成立时的那个值；公开样例同时等于公布的 A 基线（8caf2cfb…）。
 *
 * 运行方式：npm test。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { deriveAppData } from '../derive/appData.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { LEGACY_ID_CANONICAL_SOURCES, generateFrozenFixtures } from './frozenSources.fixture.ts'
import { NOW, SAMPLE_BASELINE_SHA256, baselineText } from './legacy.fixture.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import { normalizeLegacy } from './normalizeLegacy.ts'
import type { CanonicalData } from './types.ts'
import { jsonClone } from './v2Serializer.ts'

const readFrozen = (relative: string): unknown => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'))

const canonicalBaseline = (canonical: CanonicalData) => baselineText(deriveAppDataFromCanonical(canonical, { now: NOW }))

test('冻结夹具：每份静态文件与原生成函数的输出深相等', () => {
  const generated = generateFrozenFixtures()
  assert.deepEqual(Object.keys(generated), [
    'canonical/fixtures/legacy-id-canonical.json',
    'canonical/fixtures/v2-space-canonical.json',
    'canonical/fixtures/migrated-canonical.json',
    'canonical/fixtures/canonical-for-inputs.json',
    'v2write/fixtures/migrated-files.json',
  ])
  for (const [relative, value] of Object.entries(generated)) {
    assert.deepStrictEqual(readFrozen(relative), value, relative)
  }
})

test('冻结夹具：旧 id 空间的 Canonical 只少了值为 undefined 的键，派生基线与未往返的原值、与旧路径 B 都逐字节相同', () => {
  const frozen = readFrozen('canonical/fixtures/legacy-id-canonical.json') as Record<string, CanonicalData>
  assert.deepEqual(Object.keys(frozen), Object.keys(LEGACY_ID_CANONICAL_SOURCES))
  for (const [name, rawOf] of Object.entries(LEGACY_ID_CANONICAL_SOURCES)) {
    const live = legacyAdapter(rawOf())
    assert.deepStrictEqual(frozen[name], jsonClone(live), name)
    const c = canonicalBaseline(frozen[name])
    assert.equal(c, canonicalBaseline(live), `${name}：冻结前后的派生基线`)
    assert.equal(c, baselineText(deriveAppData(normalizeLegacy(rawOf()).normalized)), `${name}：与旧路径 B`)
  }
  const sample = canonicalBaseline(frozen.sample)
  assert.equal(sample, baselineText(deriveAppData(LEGACY_ID_CANONICAL_SOURCES.sample())), '公开样例：与旧路径 A')
  assert.equal(createHash('sha256').update(`${sample}\n`).digest('hex'), SAMPLE_BASELINE_SHA256)
})
