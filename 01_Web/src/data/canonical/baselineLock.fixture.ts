/**
 * 派生基线的哈希锁（./derive.test.ts 用；审查 E6，第 7 批）。不是测试文件，App 代码从不 import 它。
 *
 * 锁只存基线的 sha256（基线全文加起来约 2 MB，不进仓库）。不一致时只报两个哈希不便定位，所以这里同时写出实际的基线，
 * 并在手头有预期的那一份时列出差异的 JSON 路径（只列路径，不带值）：
 * - 目录：环境变量 `STARMAP_BASELINE_LOCK_DIR`；未设置时是 `<系统临时目录>/starmap-baseline-locks`。
 * - 锁一致：设置了 `STARMAP_BASELINE_LOCK_DIR` 时把基线写成 `<名字>.expected.json`；未设置时什么都不写。
 * - 锁不一致：基线写成 `<名字>.actual.json`；同一目录里有哈希等于锁的 `<名字>.expected.json` 时，
 *   前 50 处差异路径写进 `<名字>.diff.txt`，也放进失败信息。
 *
 * 用法：在改动之前的提交上（例如 `git stash` 之后）带 `STARMAP_BASELINE_LOCK_DIR=<目录>` 跑一次
 * `node --test src/data/canonical/derive.test.ts`，得到各份预期的基线；回到改动之后再跑，失败信息就列出差异。
 * 写出的文件与 `scripts/baseline.mjs` 的输出格式相同（末尾换行），也可以用 `node scripts/baseline.mjs --compare` 比较。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

/// <reference types="node" />

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { baselineDifferences } from '../derive/baseline.ts'

/** 锁里的哈希：基线文本加末尾换行的 sha256（与 `scripts/baseline.mjs` 写出的文件相同）。 */
export const baselineLockSha256 = (text: string): string => createHash('sha256').update(`${text}\n`).digest('hex')

export type BaselineLockOutcome =
  | { ok: true }
  | { ok: false; message: string; actualPath: string; diffPath?: string }

const MAX_REPORTED_DIFFERENCES = 50

/** 文件名只留字母、数字、点、横线与下划线，去掉开头的点。 */
const fileStem = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'baseline'

/**
 * 比较基线文本与锁。`environment` 默认 `process.env`（测试可以传自己的目录）。
 * 返回失败信息（含实际基线的路径与可用时的差异路径），不抛错；`assertBaselineLock` 在失败时抛出。
 */
export const checkBaselineLock = (
  name: string,
  text: string,
  expectedSha256: string,
  environment: Record<string, string | undefined> = process.env,
): BaselineLockOutcome => {
  const configured = environment.STARMAP_BASELINE_LOCK_DIR
  const directory = configured ? path.resolve(configured) : path.join(tmpdir(), 'starmap-baseline-locks')
  const stem = path.join(directory, fileStem(name))
  const actualSha256 = baselineLockSha256(text)
  if (actualSha256 === expectedSha256) {
    if (configured) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(`${stem}.expected.json`, `${text}\n`, 'utf8')
    }
    return { ok: true }
  }

  mkdirSync(directory, { recursive: true })
  const actualPath = `${stem}.actual.json`
  writeFileSync(actualPath, `${text}\n`, 'utf8')
  const lines = [`${name}：派生基线的 sha256 是 ${actualSha256}，锁定的是 ${expectedSha256}。`, `实际的基线：${actualPath}`]

  const expectedPath = `${stem}.expected.json`
  const expectedText = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf8') : undefined
  if (expectedText === undefined || createHash('sha256').update(expectedText).digest('hex') !== expectedSha256) {
    lines.push(
      expectedText === undefined
        ? `没有预期的基线（${expectedPath}）。`
        : `${expectedPath} 不是锁定的那一份（哈希不同），不能用来比较。`,
      '要看差异：在改动之前的提交上带 STARMAP_BASELINE_LOCK_DIR 跑一次本测试（锁一致时写出 .expected.json），再回到改动之后重跑。',
    )
    return { ok: false, message: lines.join('\n'), actualPath }
  }

  const { paths, total } = baselineDifferences(JSON.parse(expectedText), JSON.parse(text), MAX_REPORTED_DIFFERENCES)
  const diffPath = `${stem}.diff.txt`
  const listed = total === 0
    ? ['解析后的 JSON 相同，只有格式不同。']
    : [`共 ${total} 处差异${total > paths.length ? `，以下是前 ${paths.length} 处` : ''}（JSON 路径，预期 → 实际）：`, ...paths.map((where) => `  ${where}`)]
  writeFileSync(diffPath, `${listed.join('\n')}\n`, 'utf8')
  lines.push(`预期的基线：${expectedPath}`, `差异：${diffPath}`, ...listed)
  return { ok: false, message: lines.join('\n'), actualPath, diffPath }
}

/** 锁不一致时以 `checkBaselineLock` 的信息失败。 */
export const assertBaselineLock = (name: string, text: string, expectedSha256: string): void => {
  const outcome = checkBaselineLock(name, text, expectedSha256)
  if (!outcome.ok) assert.fail(outcome.message)
}
