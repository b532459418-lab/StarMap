/**
 * atomicJsonWrite（scripts/json-file.mjs）的原子写入（第 1 批 D8）：
 * 随机后缀的临时文件、wx 创建、fsync、rename、父目录 fsync；任一步失败都不留临时文件，目标始终是完整 JSON。
 * 失败用 node:test 的 mock 注入到 node:fs/promises（syncBuiltinESMExports 让 json-file.mjs 的具名导入看到替身）。
 * 只在 fs.mkdtemp 建的临时目录里读写，用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsPromises, { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { atomicJsonWrite } from './json-file.mjs'

const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-json-file-test-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const failing = (t, name, shouldFail = () => true) => {
  const original = fsPromises[name]
  t.mock.method(fsPromises, name, async (...args) => {
    if (shouldFail(...args)) throw Object.assign(new Error(`injected ${name} failure`), { code: 'EIO' })
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

test('atomicJsonWrite: writes complete JSON, keeps one .bak generation and leaves no temporary file', () => withTemp(async (directory) => {
  const target = path.join(directory, 'nested', 'state.local.json')
  await atomicJsonWrite(target, { generation: 1 })
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { generation: 1 })
  await atomicJsonWrite(target, { generation: 2 })
  await atomicJsonWrite(target, { generation: 3 })
  assert.equal(await readFile(target, 'utf8'), `${JSON.stringify({ generation: 3 }, null, 2)}\n`)
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'nested', 'state.local.bak'), 'utf8')), { generation: 2 })
  assert.deepEqual((await readdir(path.join(directory, 'nested'))).sort(), ['state.local.bak', 'state.local.json'])
}))

test('atomicJsonWrite: a failed rename removes the temporary file and leaves the previous complete JSON', (t) => withTemp(async (directory) => {
  const target = path.join(directory, 'state.local.json')
  await writeFile(target, `${JSON.stringify({ kept: true }, null, 2)}\n`, 'utf8')
  failing(t, 'rename')
  await assert.rejects(atomicJsonWrite(target, { kept: false }), /injected rename failure/)
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { kept: true })
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), [])
}))

test('atomicJsonWrite: a failed write/fsync stage removes the temporary file; a missing target stays missing', (t) => withTemp(async (directory) => {
  const target = path.join(directory, 'fresh.local.json')
  const original = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await original(...args)
    if (String(args[0]).endsWith('.tmp')) {
      handle.sync = async () => { throw Object.assign(new Error('injected sync failure'), { code: 'EIO' }) }
    }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  await assert.rejects(atomicJsonWrite(target, { value: 1 }), /injected sync failure/)
  assert.deepEqual(await readdir(directory), [])
}))

test('atomicJsonWrite: temporary names carry a random suffix, so two writes never share a temporary file', (t) => withTemp(async (directory) => {
  const target = path.join(directory, 'state.local.json')
  const temporaries = []
  const original = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args) => {
    if (String(args[0]).endsWith('.tmp')) {
      temporaries.push(path.basename(String(args[0])))
      assert.equal(args[1], 'wx', 'temporary files are created exclusively')
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  await atomicJsonWrite(target, { value: 1 })
  await atomicJsonWrite(target, { value: 2 })
  assert.equal(temporaries.length, 2)
  assert.notEqual(temporaries[0], temporaries[1])
  for (const name of temporaries) assert.match(name, new RegExp(`^state\\.local\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`))
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { value: 2 })
}))

test('atomicJsonWrite: a directory fsync that the platform refuses is ignored after the rename', (t) => withTemp(async (directory) => {
  const target = path.join(directory, 'state.local.json')
  failing(t, 'open', (file) => path.resolve(String(file)) === path.resolve(directory))
  await atomicJsonWrite(target, { value: 'saved' })
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { value: 'saved' })
}))
