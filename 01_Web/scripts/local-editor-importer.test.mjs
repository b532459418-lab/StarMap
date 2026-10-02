import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createLocalEditorImporter } from './local-editor-importer.mjs'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const webRoot = path.resolve('synthetic-web-root')
const privateRoot = path.resolve('synthetic-private-root')
const script = path.join(webRoot, 'scripts', 'import-media.mjs')

test('importer preflight execution failure preserves diagnostics and never applies', async () => {
  const calls = []
  const original = Object.assign(new Error('Command failed: original diagnostic\n'), {
    code: 1,
    stdout: '  preflight output\r\n',
    stderr: 'original diagnostic\n',
  })
  const run = createLocalEditorImporter({ webRoot, privateRoot, execFileAsync: async (...args) => {
    calls.push(args)
    throw original
  } })
  await assert.rejects(run(), (error) => {
    assert.ok(error instanceof V2WriteError)
    assert.equal(error.code, 'E_MEDIA_IMPORT_FAILED')
    assert.deepEqual(error.params, { reason: original.message, stage: 'preflight' })
    assert.equal(error.message, original.message)
    assert.equal(error.details, `${original.stdout}\n${original.stderr}`)
    return true
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1], [script])
})

test('zero-exit preflight with unresolved data blocks apply for every existing stop condition', async () => {
  for (const warning of ['需要处理', '缺少日期或分辨率', '缺少日期、分辨率或有效坐标', '无法读取', '找不到国家', '找不到城市']) {
    let calls = 0
    const run = createLocalEditorImporter({ webRoot, privateRoot, execFileAsync: async () => {
      calls += 1
      return { stdout: 'StarMap 媒体预检\n', stderr: `${warning}：待确认\n` }
    } })
    await assert.rejects(run(), (error) => {
      assert.ok(error instanceof V2WriteError)
      assert.equal(error.code, 'E_MEDIA_IMPORT_BLOCKED')
      assert.equal(error.message, '媒体预检发现未解决信息，已停止导入。')
      assert.equal(error.details, `StarMap 媒体预检\n\n${warning}：待确认`)
      return true
    })
    assert.equal(calls, 1, warning)
  }
})

test('apply execution failure identifies its stage and preserves stream bytes and extra details', async () => {
  const calls = []
  const original = Object.assign(new Error('EACCES: synthetic output path'), {
    code: 'EACCES',
    stdout: '  导入开始\r\n',
    stderr: 'permission denied\n',
    details: 'additional diagnostic\r\n',
  })
  const run = createLocalEditorImporter({ webRoot, privateRoot, execFileAsync: async (_command, args) => {
    calls.push(args)
    if (args.includes('--apply')) throw original
    return { stdout: '预检通过', stderr: '' }
  } })
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 'E_MEDIA_IMPORT_FAILED')
    assert.deepEqual(error.params, { reason: original.message, stage: 'apply' })
    assert.equal(error.message, original.message)
    assert.equal(error.details, `${original.stdout}\n${original.stderr}\n${original.details}`)
    return true
  })
  assert.deepEqual(calls, [[script], [script, '--apply']])
})

test('successful importer preserves command options, preflight/apply order and output format', async () => {
  const calls = []
  const run = createLocalEditorImporter({ webRoot, privateRoot, execFileAsync: async (command, args, options) => {
    calls.push({ command, args, options })
    return args.includes('--apply')
      ? { stdout: '  StarMap 媒体导入：1 个文件\n', stderr: '提醒：坐标缺失但允许导入\n' }
      : { stdout: '预检通过', stderr: '坐标缺失但允许导入' }
  } })
  assert.equal(await run(), 'StarMap 媒体导入：1 个文件\n\n提醒：坐标缺失但允许导入')
  assert.deepEqual(calls.map(({ args }) => args), [[script], [script, '--apply']])
  for (const { command, options } of calls) {
    assert.equal(command, process.execPath)
    assert.equal(options.cwd, webRoot)
    assert.equal(options.env.STARMAP_PRIVATE_ROOT, privateRoot)
    assert.equal(options.maxBuffer, 8 * 1024 * 1024)
  }
})

test('execution failures retain existing details without duplication and never infer typed codes from errno', async () => {
  for (const original of [
    Object.assign(new Error('raw failure'), { stdout: '', stderr: 'diagnostic\n', details: 'diagnostic\n' }),
    Object.assign(new Error('raw failure'), { code: 'E_MEDIA_IMPORT_BLOCKED', details: '' }),
    new Error(''),
    'executor rejection',
  ]) {
    const run = createLocalEditorImporter({ webRoot, privateRoot, execFileAsync: async () => { throw original } })
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, 'E_MEDIA_IMPORT_FAILED')
      assert.equal(error.params.stage, 'preflight')
      assert.equal(error.message, original instanceof Error ? original.message : original)
      if (typeof original.details === 'string') assert.equal(error.details, original.details)
      return true
    })
  }
})
