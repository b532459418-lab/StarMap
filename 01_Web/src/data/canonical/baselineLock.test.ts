/**
 * 派生基线哈希锁的辅助（./baselineLock.fixture.ts，第 7 批）：锁不一致时写出实际基线与可读的差异。
 * 只用合成的小 JSON 与临时目录。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { assertBaselineLock, baselineLockSha256, checkBaselineLock } from './baselineLock.fixture.ts'
import { stableStringify } from '../derive/baseline.ts'

const withDirectory = (run: (directory: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'starmap-baseline-lock-test-'))
  try { run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

const before = stableStringify({ format: 'x@1', modules: { travelAtlas: { cities: ['a', 'b'], countries: { iceland: 1 } } } })
const after = stableStringify({ format: 'x@1', modules: { travelAtlas: { cities: ['a', 'c', 'd'], countries: { iceland: 1 } } } })

test('a matching lock writes nothing unless a capture directory is configured, then it writes the expected baseline', () => withDirectory((directory) => {
  assert.deepEqual(checkBaselineLock('sample', before, baselineLockSha256(before), { STARMAP_BASELINE_LOCK_DIR: directory }), { ok: true })
  assert.deepEqual(readdirSync(directory), ['sample.expected.json'])
  assert.equal(readFileSync(path.join(directory, 'sample.expected.json'), 'utf8'), `${before}\n`)
  assert.deepEqual(checkBaselineLock('other', before, baselineLockSha256(before), { STARMAP_BASELINE_LOCK_DIR: undefined }), { ok: true })
  assert.deepEqual(readdirSync(directory), ['sample.expected.json'])
}))

test('a mismatch without an expected baseline writes the actual one and says how to get the difference', () => withDirectory((directory) => {
  const outcome = checkBaselineLock('../v2write/fixtures/migrated-files.json', after, baselineLockSha256(before), { STARMAP_BASELINE_LOCK_DIR: directory })
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.actualPath, path.join(directory, '_v2write_fixtures_migrated-files.json.actual.json'))
  assert.equal(readFileSync(outcome.actualPath, 'utf8'), `${after}\n`)
  assert.equal(outcome.diffPath, undefined)
  assert.match(outcome.message, new RegExp(baselineLockSha256(after)))
  assert.match(outcome.message, new RegExp(baselineLockSha256(before)))
  assert.match(outcome.message, /STARMAP_BASELINE_LOCK_DIR/)
}))

test('a mismatch with the captured expected baseline lists the differing JSON paths in the message and in a file', () => withDirectory((directory) => {
  const environment = { STARMAP_BASELINE_LOCK_DIR: directory }
  const lock = baselineLockSha256(before)
  assert.deepEqual(checkBaselineLock('personal', before, lock, environment), { ok: true })
  const outcome = checkBaselineLock('personal', after, lock, environment)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  const expectedList = ['  $.modules.travelAtlas.cities[1]', '  $.modules.travelAtlas.cities[2]']
  assert.ok(outcome.diffPath)
  assert.deepEqual(readFileSync(outcome.diffPath, 'utf8').trimEnd().split('\n').slice(1), expectedList)
  for (const line of expectedList) assert.ok(outcome.message.includes(line), line)
  assert.ok(!outcome.message.includes('"c"'), 'only paths, never values')
}))

test('an expected file from another lock is not used for the comparison; assertBaselineLock fails with the message', () => withDirectory((directory) => {
  const environment = { STARMAP_BASELINE_LOCK_DIR: directory }
  assert.deepEqual(checkBaselineLock('stale', after, baselineLockSha256(after), environment), { ok: true })
  const outcome = checkBaselineLock('stale', after, baselineLockSha256(before), environment)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.diffPath, undefined)
  assert.match(outcome.message, /不是锁定的那一份/)
  assert.doesNotThrow(() => assertBaselineLock('anything', before, baselineLockSha256(before)))
}))
