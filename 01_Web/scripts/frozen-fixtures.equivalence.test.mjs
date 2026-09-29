/**
 * 冻结夹具在脚本测试一侧的等价证明（RFC-LOC-1 PR5b §4.1）。只在冻结那一个提交里存在：下一个提交删除 migrate-identity 时，
 * 本文件与 ./frozen-fixture-sources.mjs 一起删除。
 *
 * `scripts/fixtures/` 下三份 V2 文件，各自与原测试的做法（临时私人根里写旧数据，跑 migrate-identity 的 dry-run 与 --apply）
 * 现场得到的五个文件相同：随机的 UUID 按首次出现的顺序换成确定序列、迁移时刻换成固定值之后深相等
 * （见 ./frozen-fixture-sources.mjs）。冻结文件对这个变换是恒等的，所以它们就是「换好名字的迁移结果」本身。
 *
 * 运行方式：npm test。私人根一律是 fs.mkdtemp 建的临时目录，用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FROZEN_V2_SOURCES, canonicalizeMigratedFiles, migrateInto, readMigratedFiles } from './frozen-fixture-sources.mjs'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'

const readFrozen = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

test('冻结夹具（脚本测试）：三份静态 V2 文件与 migrate-identity 现场迁移的结果相同（UUID 与迁移时刻换成确定值之后）', async () => {
  assert.deepEqual(Object.keys(FROZEN_V2_SOURCES), ['bak-files-v2.json', 'baseline-v2.json', 'editor-store-v2.json'])
  for (const [name, setup] of Object.entries(FROZEN_V2_SOURCES)) {
    const directory = await mkdtemp(path.join(tmpdir(), 'starmap-frozen-v2-test-'))
    try {
      const root = path.join(directory, 'private')
      await setup(root)
      const { dryRun, applied } = migrateInto(root)
      assert.equal(dryRun.status, 0, `${name}\n${dryRun.stdout}${dryRun.stderr}`)
      assert.match(dryRun.stdout, /^canApply：true$/m, name)
      assert.equal(applied.status, 0, `${name}\n${applied.stdout}${applied.stderr}`)

      const frozen = readFrozen(name)
      assert.deepEqual(Object.keys(frozen), V2_FILE_KEYS, name)
      assert.deepEqual(validateV2Files(frozen), [], name)
      assert.deepStrictEqual(canonicalizeMigratedFiles(frozen), frozen, `${name}：冻结文件对变换恒等`)
      assert.deepStrictEqual(canonicalizeMigratedFiles(await readMigratedFiles(root)), frozen, name)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
