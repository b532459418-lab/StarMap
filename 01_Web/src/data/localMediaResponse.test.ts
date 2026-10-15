import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalEditorError } from '../i18n/editorErrors.ts'
import { parseMediaImportResponse, parseMediaUploadResponse } from './localMediaResponse.ts'

const responseOf = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const uploadBody = { ok: true, fileName: 'photo.jpg', bytes: 123, sourcePath: 'Country/City/photos/photo.jpg' }
const invalid = (status: number) => (error: unknown) => {
  assert.ok(error instanceof LocalEditorError)
  assert.equal(error.code, 'E_EDITOR_RESPONSE_INVALID')
  assert.deepEqual(error.params, { status })
  assert.equal(error.details, undefined)
  return true
}

test('valid upload/import payloads retain extra fields and allow Unicode, spaces and empty import results', async () => {
  const upload = { ...uploadBody, fileName: '照片 1.jpg', sourcePath: '冰岛/Vík 中心/photos/照片 1.jpg', extra: { untouched: true } }
  assert.deepEqual(await parseMediaUploadResponse(responseOf(upload, 201)), upload)
  const imported = { ok: true, output: '', restoredMediaIds: [], extra: ['preserved'] }
  assert.deepEqual(await parseMediaImportResponse(responseOf(imported)), imported)
  const ids = { ok: true, output: 'Original CLI output\r\n', restoredMediaIds: ['custom id', 'media-0123456789abcdef'] }
  assert.deepEqual(await parseMediaImportResponse(responseOf(ids)), ids)
})

test('upload requires all confirmed fields and a positive safe integer byte count', async () => {
  for (const body of [
    { ok: true },
    ...['', '  ', 0, null].map((fileName) => ({ ...uploadBody, fileName })),
    ...[undefined, null, 0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1].map((bytes) => ({ ...uploadBody, bytes })),
    ...[undefined, null, '', '   ', 123].map((sourcePath) => ({ ...uploadBody, sourcePath })),
  ]) {
    await assert.rejects(parseMediaUploadResponse(responseOf(body, 201)), invalid(201))
  }
})

test('upload rejects absolute, Windows, traversal, empty segments and control-character source paths', async () => {
  for (const sourcePath of [
    '/Country/photo.jpg', '//server/photo.jpg', 'C:/Country/photo.jpg', 'C:photo.jpg',
    '\\server\\share\\photo.jpg', 'Country\\City\\photo.jpg',
    'Country//photo.jpg', 'Country/photos/', './photo.jpg', 'Country/./photo.jpg',
    '../photo.jpg', 'Country/../photo.jpg', 'Country/photos/..',
    'Country/photos/a\u0000.jpg', 'Country/photos/a\n.jpg', 'Country/photos/a\u007f.jpg', 'Country/photos/a\u0085.jpg',
  ]) {
    await assert.rejects(parseMediaUploadResponse(responseOf({ ...uploadBody, sourcePath })), invalid(200))
  }
})

test('import requires output text and an id array whose elements are nonempty strings', async () => {
  for (const body of [
    { ok: true }, { ok: true, output: '' }, { ok: true, restoredMediaIds: [] },
    ...[null, 123, {}, []].map((output) => ({ ok: true, output, restoredMediaIds: [] })),
    ...[null, {}, 'id', 123, [''], ['  '], [null], [123], ['id', {}]].map((restoredMediaIds) => ({ ok: true, output: '', restoredMediaIds })),
  ]) {
    await assert.rejects(parseMediaImportResponse(responseOf(body)), invalid(200))
  }
})

test('media success validation does not expose the malformed payload as a diagnostic', async () => {
  const privateMarker = 'synthetic-body-marker-must-not-be-diagnostic'
  for (const parse of [parseMediaUploadResponse, parseMediaImportResponse]) {
    await assert.rejects(parse(responseOf({ ok: true, unexpected: privateMarker })), (error) => {
      invalid(200)(error)
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(privateMarker), false)
      return true
    })
  }
})

test('media parsers retain original known/unknown failures and abort identity', async () => {
  const body = { ok: false, error: 'original server message\r\n', details: 'original details\n', code: 'E_MEDIA_IMPORT_FAILED', params: { stage: 'apply', reason: 'original reason' } }
  for (const parse of [parseMediaUploadResponse, parseMediaImportResponse]) {
    for (const code of ['E_MEDIA_IMPORT_FAILED', 'E_FUTURE']) {
      await assert.rejects(parse(responseOf({ ...body, code }, 400)), (error) => {
        assert.ok(error instanceof LocalEditorError)
        assert.equal(error.code, code)
        assert.equal(error.message, `${body.error}\n${body.details}`)
        assert.equal(error.details, body.details)
        assert.deepEqual(error.params, body.params)
        return true
      })
    }
    const abort = new DOMException('Original cancellation', 'AbortError')
    const response = new Response('{}')
    response.json = async () => { throw abort }
    await assert.rejects(parse(response), (error) => error === abort)
  }
})
