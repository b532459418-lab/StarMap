/**
 * 迁移清单与决定文件的解析（migration/identityFiles.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IdentityFileError, emptyManifest, parseIdentityDecisions, parseIdentityManifest } from './identityFiles.ts'

const UUID_A = '019b76da-a801-7000-8000-000000000001'
const UUID_B = '019b76da-a802-7000-8000-000000000002'

test('迁移清单：合法的清单原样读进来；空清单', () => {
  const manifest = { schema_version: 1, sources: { 'country:iceland': UUID_A, 'wtg:w_1': UUID_B }, sourceHash: 'abc', plannedAt: '2026-09-26T00:00:00.000Z' }
  assert.deepEqual(parseIdentityManifest(manifest), manifest)
  assert.deepEqual(parseIdentityManifest({ schema_version: 1, sources: {} }), emptyManifest())
})

test('迁移清单：不合法时抛 IdentityFileError，消息不带清单内容', () => {
  for (const value of [
    null,
    [],
    { schema_version: 2, sources: {} },
    { schema_version: 1 },
    { schema_version: 1, sources: { 'city:secret__place': 'not-a-uuid' } },
    { schema_version: 1, sources: { 'city:secret__place': UUID_A.toUpperCase() } },
    { schema_version: 1, sources: { 'city:secret__place': UUID_A, 'city:other': UUID_A } },
    { schema_version: 1, sources: {}, sourceHash: 1 },
  ]) {
    assert.throws(() => parseIdentityManifest(value), (error: unknown) => {
      assert.ok(error instanceof IdentityFileError)
      assert.doesNotMatch(error.message, /secret/)
      return true
    }, JSON.stringify(value))
  }
})

test('决定文件：合法的三张表；只写了一部分也可以', () => {
  const full = {
    schema_version: 1,
    duplicates: { 'wtg:w_1|city:iceland__reykjavik': 'merge', 'wtg:w_2|city:iceland__vik': 'separate' },
    nameDifferences: { 'wtg:w_3': 'accept' },
    coordinateDifferences: { 'wtg:w_4': 'accept' },
  }
  assert.deepEqual(parseIdentityDecisions(full), full)
  assert.deepEqual(parseIdentityDecisions({ schema_version: 1 }), { schema_version: 1 })
})

test('决定文件：取值不在允许范围、不认识的表、版本不对时抛 IdentityFileError', () => {
  for (const value of [
    'x',
    { schema_version: 2 },
    { schema_version: 1, duplicates: { 'wtg:w_1|city:x': 'accept' } },
    { schema_version: 1, nameDifferences: { 'wtg:w_1': 'reject' } },
    { schema_version: 1, coordinateDifferences: ['wtg:w_1'] },
    { schema_version: 1, merges: {} },
  ]) {
    assert.throws(() => parseIdentityDecisions(value), IdentityFileError, JSON.stringify(value))
  }
})
