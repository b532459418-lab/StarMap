/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { parseLocalEditorResponse } from './localEditorResponse.ts'
import { addLocalCountry, convertLocalWantToGoToTravel } from './localEditorApi.ts'
import { LocalEditorError, formatEditorError, requiresEditorReload } from '../i18n/editorErrors.ts'
import { resources } from '../i18n/resources.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from './uiLocale.ts'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const rejection = async (response: Response) => {
  try {
    await parseLocalEditorResponse(response)
  } catch (error) {
    assert.ok(error instanceof LocalEditorError)
    return error
  }
  assert.fail('Expected the response to fail')
}

test('Only an HTTP success with the literal boolean ok=true returns the unchanged success payload', async () => {
  const body = { ok: true, countryId: 'neutral-country', cities: [], count: 0 }
  for (const status of [200, 201]) assert.deepEqual(await parseLocalEditorResponse(jsonResponse(body, status)), body)
  assert.equal((await rejection(jsonResponse(body, 503))).code, 'E_EDITOR_RESPONSE_INVALID')
  for (const ok of ['false', 'true', 1, 0, null]) assert.equal((await rejection(jsonResponse({ ok }))).code, 'E_EDITOR_RESPONSE_INVALID')
  assert.equal((await rejection(jsonResponse({}))).code, 'E_EDITOR_RESPONSE_INVALID')
})

test('Conflicting success and failure fields are rejected even when the failure value is empty', async () => {
  const conflicts = [
    { error: '足迹已创建，但想去条目没有移除。', code: 'E_PARTIAL_WRITE', params: { written: ['travel'] } },
    { error: '' }, { code: '' }, { params: {} }, { details: '' },
  ]
  for (const status of [200, 201]) {
    for (const conflict of conflicts) {
      const error = await rejection(jsonResponse({ ok: true, ...conflict }, status))
      assert.equal(error.code, 'E_EDITOR_RESPONSE_INVALID')
      assert.deepEqual(error.params, { status })
      assert.ok(requiresEditorReload(error, { afterWrite: true }))
    }
  }
  const response = jsonResponse({ ok: true })
  response.json = async () => ({ ok: true, error: undefined })
  assert.equal((await rejection(response)).code, 'E_EDITOR_RESPONSE_INVALID')
})

test('Flat JSON failures preserve legacy text, known/unknown codes, params and diagnostic details', async () => {
  const body = { ok: false, error: '足迹已创建，但想去条目没有移除。', code: 'E_PARTIAL_WRITE', params: { written: ['travelMap'], failed: 'wantToGo', message: 'original recovery message' }, details: 'neutral diagnostic' }
  const error = await rejection(jsonResponse(body, 400))
  assert.equal(error.message, `${body.error}\n${body.details}`)
  assert.equal(error.code, body.code)
  assert.deepEqual(error.params, body.params)
  assert.equal(error.details, body.details)
  assert.ok(requiresEditorReload(error))
  assert.equal((await rejection(jsonResponse({ ok: false, error: 'old refusal' }, 403))).message, 'old refusal')
  assert.equal((await rejection(jsonResponse({ ok: false, error: 'future refusal', code: 'E_FUTURE', details: 'raw details' }, 400))).message, 'future refusal\nraw details')
  assert.equal((await rejection(jsonResponse({ ok: false }, 400))).code, 'E_LOCAL_EDITOR_FAILED')
  assert.equal((await rejection(jsonResponse({ ok: false, details: 'only diagnostic' }, 400))).message, 'only diagnostic')
  assert.equal((await rejection(jsonResponse({ ok: false, error: 'business failure' }, 200))).message, 'business failure')
})

test('Empty, HTML and malformed JSON responses keep only the JSON parser diagnostic plus HTTP status', async () => {
  for (const text of ['', '<html>neutral gateway response</html>', '{ broken JSON']) {
    const response = new Response(text, { status: 503 })
    let diagnostic: string | undefined
    try { await response.clone().json() } catch (error) { assert.ok(error instanceof Error); diagnostic = error.message }
    const error = await rejection(response)
    assert.equal(error.code, 'E_EDITOR_RESPONSE_INVALID')
    assert.deepEqual(error.params, { status: 503 })
    assert.equal(error.details, diagnostic)
    assert.ok(response.bodyUsed)
    assert.ok(requiresEditorReload(error))
  }
  assert.equal((await rejection(new Response(null, { status: 204 }))).code, 'E_EDITOR_RESPONSE_INVALID')
})

test('JSON null, arrays and primitives are rejected without accidental TypeErrors', async () => {
  for (const body of [null, [], ['error'], 'diagnostic', 42, false]) {
    const error = await rejection(jsonResponse(body, 400))
    assert.equal(error.code, 'E_EDITOR_RESPONSE_INVALID')
    assert.deepEqual(error.params, { status: 400 })
  }
})

test('Malformed error fields, including unsupported nested errors, never coerce to object strings', async () => {
  for (const [field, value] of [
    ['error', {}], ['error', null], ['error', 1], ['details', []], ['details', null],
    ['code', 1], ['code', null], ['params', []], ['params', 'bad'], ['params', null],
    ['error', { code: 'E_REQUIRED', params: { field: 'city' } }],
  ] as const) {
    const error = await rejection(jsonResponse({ ok: false, [field]: value }, 400))
    assert.equal(error.code, 'E_EDITOR_RESPONSE_INVALID', field)
    assert.notEqual(error.message, '[object Object]')
  }
})

test('Unreadable response notices follow language and warn that the write result may be unknown', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  const error = await rejection(new Response('invalid', { status: 503 }))
  const english = formatEditorError(error, i18n.t)
  assert.match(english, /HTTP 503/)
  assert.match(english, /result may be unknown/)
  assert.match(english, /Reload to check/)
  assert.ok(english.endsWith(error.details!))
  const rawMessage = error.message
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.match(formatEditorError(error, i18n.t), /HTTP 503/)
  assert.match(formatEditorError(error, i18n.t), /可能尚未确认/)
  assert.equal(error.message, rawMessage)
})

test('API integration preserves network and abort errors and never retries a failed write', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const error of [new TypeError('Neutral network failure'), new DOMException('Neutral canceled search', 'AbortError')]) {
      let requests = 0
      globalThis.fetch = async (url, init) => {
        requests += 1
        assert.equal(url, '/__travelatlas/editor/wanttogo/convert')
        assert.equal(init?.method, 'POST')
        throw error
      }
      await assert.rejects(convertLocalWantToGoToTravel({ source: 'want-to-go', id: 'neutral-item', startDate: '2026-10-02' }), (actual) => actual === error)
      assert.equal(requests, 1)
      assert.equal(requiresEditorReload(error), false)
      assert.equal(requiresEditorReload(error, { afterWrite: true }), true)
    }
    let requests = 0
    globalThis.fetch = async () => { requests += 1; return new Response('invalid response', { status: 503 }) }
    await assert.rejects(addLocalCountry('JP', '2026-10-02'), (error) => error instanceof LocalEditorError && error.code === 'E_EDITOR_RESPONSE_INVALID')
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('A canceled response body keeps the original AbortError instead of reporting malformed JSON', async () => {
  const response = jsonResponse({ ok: true })
  const canceled = new DOMException('Neutral canceled response', 'AbortError')
  response.json = async () => { throw canceled }
  await assert.rejects(parseLocalEditorResponse(response), (error) => error === canceled)
})
