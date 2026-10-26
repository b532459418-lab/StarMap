/// <reference types="node" />
/**
 * The editor's error codes and messages (./errors.ts; 3C-5 E review R1: ported from the retired
 * v2write/transaction.test.ts, which tested them with the V2 transaction).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V2WriteError, V2_WRITE_ERROR_CODES, errorBody, messageFor } from './errors.ts'

test('every code has a Chinese message; a V2WriteError\'s message is it; the response body is { ok: false, error, code, params? }', () => {
  for (const code of V2_WRITE_ERROR_CODES) {
    const message = messageFor(code, { field: 'country' })
    assert.ok(message.length > 0, code)
    assert.match(message, /\p{Script=Han}/u, code)
  }
  const error = new V2WriteError('E_REQUIRED', { field: 'country' })
  assert.equal(error.message, '请填写国家中文名。')
  assert.deepEqual(errorBody(error), { ok: false, error: '请填写国家中文名。', code: 'E_REQUIRED', params: { field: 'country' } })
  assert.deepEqual(errorBody(new V2WriteError('E_WTG_EXISTS')), { ok: false, error: '这个地方已在想去列表中。', code: 'E_WTG_EXISTS' })
})

test('codes the old editor had keep its messages, word for word', () => {
  assert.equal(messageFor('E_CITY_EXISTS'), '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。')
  assert.equal(messageFor('E_COUNTRY_EXISTS'), '这个国家已经存在于国家足迹中。')
  assert.equal(messageFor('E_COUNTRY_NOT_IN_CATALOG'), '没有找到这个国家，请从候选列表中选择。')
  assert.equal(messageFor('E_CONVERT_CITY_IN_FOOTPRINT'), '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。')
  assert.equal(messageFor('E_DATE_FORMAT', { field: 'visitedDate' }), '首次到访日期必须使用 YYYY-MM-DD。')
  assert.equal(messageFor('E_NUMBER_INVALID', { field: 'lat' }), '纬度无效。')
  assert.equal(messageFor('E_WTG_DELETE_NOT_HIDDEN', { ids: ['a', 'b'] }), '只能彻底删除已隐藏的想去记录。以下记录不符合条件：a、b')
  assert.equal(
    messageFor('E_COUNTRY_HAS_MEDIA', { cities: [{ placeId: 'x', name: '雷克雅未克', count: 2 }] }),
    '以下城市仍有照片或无人机影像：雷克雅未克（2 个媒体）。请先在对应城市中彻底删除这些媒体。',
  )
  // PR3b-3: the media messages of the old upload, import and delete.
  assert.equal(messageFor('E_MEDIA_LOCATION_NOT_FOUND'), '找不到对应的国家和城市，请先把城市加入旅行数据。')
  assert.equal(messageFor('E_MEDIA_DELETE_NOT_HIDDEN'), '只能彻底删除当前城市中已经隐藏的照片或无人机影像。')
  assert.equal(messageFor('E_MEDIA_UPLOAD_REJECTED', { reason: '单个文件不能超过 250 MiB。' }), '单个文件不能超过 250 MiB。')
})
