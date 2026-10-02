import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { V2WriteError, errorBody } from '../src/data/v2write/errors.ts'
import { maxJsonBodyBytes, normalizeLocalEditorError, readJsonBody } from './local-editor-errors.mjs'

test('known errors keep codes, parameters, diagnostics and recovery messages unchanged', () => {
  const params = { field: 'search_query' }
  const error = new V2WriteError('E_REQUIRED', params)
  error.details = 'raw diagnostic\nsecond line'
  assert.deepEqual(normalizeLocalEditorError(error), {
    ok: false, error: '请填写城市名称。', code: 'E_REQUIRED', params, details: error.details,
  })
  assert.deepEqual(errorBody(error), normalizeLocalEditorError(error))
  assert.equal(normalizeLocalEditorError(error).params, params)
  assert.equal(error.message, '请填写城市名称。')

  const message = '足迹已创建，但想去条目没有移除（磁盘已满）。可以在想去列表里隐藏或彻底删除它。'
  const partial = new V2WriteError('E_PARTIAL_WRITE', {
    message, written: ['places', 'travel'], failed: 'wantToGo', reason: '磁盘已满。',
  })
  const body = normalizeLocalEditorError(partial)
  assert.equal(body.error, message)
  assert.ok(body.error.startsWith('足迹已创建，但'))
  assert.deepEqual(body.params, partial.params)

  const reloadedModuleError = { name: 'V2WriteError', message: 'raw future diagnostic', code: 'E_FUTURE', params: { id: 'neutral' }, details: 'details' }
  assert.deepEqual(normalizeLocalEditorError(reloadedModuleError), {
    ok: false, error: reloadedModuleError.message, code: 'E_FUTURE', params: reloadedModuleError.params, details: 'details',
  })
})

test('known permission and search refusals preserve their previous Chinese messages', () => {
  const messages = {
    E_EDITOR_READ_FORBIDDEN: '仅允许本机编辑会话读取。',
    E_EDITOR_WRITE_FORBIDDEN: '仅允许本机编辑会话写入。',
    E_SEARCH_COUNTRY_NOT_FOUND: '没有找到这个国家，无法限制城市检索范围。',
    E_CITY_SEARCH_UNAVAILABLE: 'OpenStreetMap 暂时不可用。请稍后重试，或改用手动坐标。',
    E_CITY_SEARCH_ALL_UNAVAILABLE: 'Cesium ion 与 OpenStreetMap 均暂时不可用。请稍后重试，或改用手动坐标。',
    E_REQUEST_TOO_LARGE: '请求内容过大。',
  }
  for (const [code, message] of Object.entries(messages)) {
    assert.deepEqual(normalizeLocalEditorError(new V2WriteError(code)), { ok: false, error: message, code })
  }
  assert.equal(new V2WriteError('E_REQUIRED', { field: 'country_code' }).message, '请填写国家代码。')
  assert.equal(new V2WriteError('E_NUMBER_INVALID', { field: 'country_code' }).message, '国家代码无效。')
})

test('unexpected errors preserve raw messages and details without promoting system errno codes', () => {
  const error = Object.assign(new Error('EACCES: permission denied, open neutral.json'), {
    code: 'EACCES', details: 'raw IO detail\n下一行',
  })
  assert.deepEqual(normalizeLocalEditorError(error), {
    ok: false, error: error.message, code: 'E_UNEXPECTED', params: { reason: error.message }, details: error.details,
  })
  assert.equal(error.code, 'EACCES')
  assert.equal(normalizeLocalEditorError(new Error('')).error, '')
  assert.deepEqual(normalizeLocalEditorError(null), { ok: false, error: '本地编辑操作失败。', code: 'E_UNEXPECTED' })
  assert.deepEqual(normalizeLocalEditorError({ code: 'E_REQUIRED', details: 'raw object detail' }), {
    ok: false, error: '本地编辑操作失败。', code: 'E_UNEXPECTED', details: 'raw object detail',
  })
  assert.deepEqual(normalizeLocalEditorError(undefined, 'E_REQUEST_INVALID'), {
    ok: false, error: '请求内容无效。', code: 'E_REQUEST_INVALID',
  })
})

test('request reader preserves UTF-8 chunks, empty bodies and the exact 1 MiB boundary', async () => {
  const bytes = Buffer.from('{"note":"京都・Kyoto","date":"2026-10-02"}')
  assert.deepEqual(await readJsonBody(Readable.from([bytes.subarray(0, 11), bytes.subarray(11)])), {
    note: '京都・Kyoto', date: '2026-10-02',
  })
  assert.deepEqual(await readJsonBody(Readable.from([])), {})
  const atLimit = Buffer.concat([Buffer.from('{}'), Buffer.alloc(maxJsonBodyBytes - 2, 32)])
  assert.deepEqual(await readJsonBody(Readable.from([atLimit])), {})
  await assert.rejects(readJsonBody(Readable.from([atLimit, Buffer.from(' ')])), (error) => {
    assert.deepEqual(normalizeLocalEditorError(error, 'E_REQUEST_INVALID'), {
      ok: false, error: '请求内容过大。', code: 'E_REQUEST_TOO_LARGE', params: { limitBytes: maxJsonBodyBytes },
    })
    return true
  })
})

test('invalid JSON keeps the parser diagnostic and request stream failures remain distinct', async () => {
  const invalid = '{"note":'
  let originalMessage
  try { JSON.parse(invalid) } catch (error) { originalMessage = error.message }
  await assert.rejects(readJsonBody(Readable.from([Buffer.from(invalid)])), (error) => {
    assert.deepEqual(normalizeLocalEditorError(error, 'E_REQUEST_INVALID'), {
      ok: false, error: originalMessage, code: 'E_REQUEST_INVALID', params: { reason: originalMessage },
    })
    return true
  })
  const raw = new Error('request stream unavailable')
  const broken = (async function* () { yield Buffer.from('{"note":'); throw raw })()
  await assert.rejects(readJsonBody(broken), (error) => {
    assert.equal(error, raw)
    assert.equal(normalizeLocalEditorError(error, 'E_REQUEST_INVALID').error, raw.message)
    return true
  })
})
