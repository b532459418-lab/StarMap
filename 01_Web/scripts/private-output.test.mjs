/**
 * scripts/private-output.mjs 的测试：私人数据可以写到哪里。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict。
 * 只做路径判断，不建任何文件；私人根通过 environment 参数给出。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { isAllowedPrivateOutput, isInsideRepository } from './private-output.mjs'
import { sourceRoot, webRoot } from './private-profile.mjs'

const envWithRoot = (root) => ({ STARMAP_PRIVATE_ROOT: root })

test('私人根在仓库内（独立克隆的 06_private）：私人根之内放行，仓库内其他位置拒绝，仓库外放行', () => {
  const root = path.join(sourceRoot, '06_private')
  const env = envWithRoot(root)
  assert.equal(isInsideRepository(root), true)
  assert.equal(isAllowedPrivateOutput(root, env), true)
  assert.equal(isAllowedPrivateOutput(path.join(root, 'data', 'v2'), env), true)
  assert.equal(isAllowedPrivateOutput(path.join(root, 'data', '..', '..', '01_Web', 'x.json'), env), false)
  assert.equal(isAllowedPrivateOutput(path.join(webRoot, 'baseline.json'), env), false)
  assert.equal(isAllowedPrivateOutput(sourceRoot, env), false)
  assert.equal(isAllowedPrivateOutput(path.join(sourceRoot, '06_private_other', 'x.json'), env), false)
  assert.equal(isAllowedPrivateOutput(path.join(tmpdir(), 'starmap-out', 'x.json'), env), true)
  if (process.platform === 'win32') {
    assert.equal(isAllowedPrivateOutput(path.join(root.toUpperCase(), 'data'), env), true)
    assert.equal(isAllowedPrivateOutput(path.join(webRoot.toUpperCase(), 'x.json'), env), false)
  }
})

test('私人根在仓库外：只按「在仓库之外」判断', () => {
  const root = path.join(tmpdir(), 'starmap-private-root-for-test')
  const env = envWithRoot(root)
  assert.equal(isAllowedPrivateOutput(path.join(root, 'data', 'v2'), env), true)
  assert.equal(isAllowedPrivateOutput(path.join(webRoot, 'x.json'), env), false)
  assert.equal(isAllowedPrivateOutput(path.join(tmpdir(), 'elsewhere.json'), env), true)
})

test('私人根就是仓库根或包含仓库：不给「私人根之内」的放行，仓库内一律拒绝', () => {
  for (const root of [sourceRoot, path.dirname(sourceRoot)]) {
    const env = envWithRoot(root)
    assert.equal(isAllowedPrivateOutput(path.join(webRoot, 'x.json'), env), false, root)
    assert.equal(isAllowedPrivateOutput(path.join(sourceRoot, 'data', 'v2'), env), false, root)
  }
  assert.equal(isAllowedPrivateOutput(path.join(path.dirname(sourceRoot), 'outside-repo', 'x.json'), envWithRoot(path.dirname(sourceRoot))), true)
})
