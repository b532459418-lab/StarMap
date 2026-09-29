/**
 * 本地编辑器可用性（./localEditorAvailability.ts）的单元测试，以及接线的源码断言（RFC-LOC-1 PR4 审查补修：强制样例不能编辑）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict + node:fs。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isLocalEditorAvailable } from './localEditorAvailability.ts'

const dataDirectory = path.dirname(fileURLToPath(import.meta.url))
const srcDirectory = path.resolve(dataDirectory, '..')

test('公开配置：开发服务器与构建产物都不可编辑（强制样例与否都一样）', () => {
  for (const dev of [true, false]) {
    for (const forceSample of [false, true]) {
      assert.equal(isLocalEditorAvailable({ dev, mode: 'public', forceSample }), false, `dev=${dev} forceSample=${forceSample}`)
    }
  }
})

test('个人配置：开发服务器可编辑；构建产物不可编辑', () => {
  assert.equal(isLocalEditorAvailable({ dev: true, mode: 'personal', forceSample: false }), true)
  assert.equal(isLocalEditorAvailable({ dev: false, mode: 'personal', forceSample: false }), false)
})

test('个人配置 + 强制样例（?data=sample 或 VITE_TRAVEL_ATLAS_DATA_MODE=sample）：不可编辑——它是在预览公开版', () => {
  assert.equal(isLocalEditorAvailable({ dev: true, mode: 'personal', forceSample: true }), false)
  assert.equal(isLocalEditorAvailable({ dev: false, mode: 'personal', forceSample: true }), false)
})

test('接线：editorState.ts 用 isLocalEditorAvailable 与 rawInputs.ts 的 forceSampleData 算出 localEditorAvailable', () => {
  const source = readFileSync(path.join(dataDirectory, 'editorState.ts'), 'utf8')
  assert.match(source, /^import \{ forceSampleData \} from '\.\/rawInputs'$/m)
  assert.match(source, /^import \{ isLocalEditorAvailable \} from '\.\/localEditorAvailability\.ts'$/m)
  assert.match(source, /export const localEditorAvailable = import\.meta\.env\.DEV && isLocalEditorAvailable\(\{\s*dev: import\.meta\.env\.DEV,\s*mode: import\.meta\.env\.MODE,\s*forceSample: forceSampleData,\s*\}\)/)
})

test('强制样例的判定只有一处：rawInputs.ts 导出 forceSampleData；src 里别处不再各自解析 ?data=sample 或读 VITE_TRAVEL_ATLAS_DATA_MODE', () => {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(full)
    }
  }
  walk(srcDirectory)
  const users = files.filter((file) => {
    const code = readFileSync(file, 'utf8')
    return /import\.meta\.env\.VITE_TRAVEL_ATLAS_DATA_MODE/.test(code) || /get\('data'\)/.test(code)
  })
  assert.deepEqual(users.map((file) => path.relative(srcDirectory, file).replaceAll('\\', '/')), ['data/rawInputs.ts'])
  assert.match(readFileSync(path.join(dataDirectory, 'rawInputs.ts'), 'utf8'), /^export const forceSampleData: boolean =/m)
})
