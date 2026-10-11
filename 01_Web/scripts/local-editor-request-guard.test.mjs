import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowedOrigins,
  authorizeRead,
  crossSiteRequestGuard,
  isCrossSiteSubresourceRequest,
  isLoopbackRequest,
  isSameOriginFetchSite,
} from './local-editor-request-guard.mjs'

const host = '127.0.0.1:5173'
const request = (headers = {}, address = '127.0.0.1') => ({ headers: { host, ...headers }, socket: { remoteAddress: address } })

// One row per browser situation the review named, plus the non-browser and other-port cases.
const cases = [
  { name: 'same-origin fetch', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, read: true, guard: false },
  { name: 'same-origin fetch with own Origin', headers: { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, read: true, guard: false },
  { name: 'none (typed address, bookmark)', headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }, read: true, guard: false },
  { name: 'absent (curl, Node)', headers: {}, read: true, guard: false },
  { name: 'same-site fetch (localhost:5999)', headers: { origin: 'http://localhost:5999', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }, read: false, guard: true },
  { name: 'same-site no-cors image', headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, read: false, guard: true },
  { name: 'cross-site fetch', headers: { origin: 'http://example.test', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, read: false, guard: true },
  { name: 'cross-site module script', headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' }, read: false, guard: true },
  { name: 'cross-site navigate (link from elsewhere)', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, read: false, guard: false },
  { name: 'same-site navigate', headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }, read: false, guard: false },
  { name: 'Origin on another port, no Sec-Fetch', headers: { origin: 'http://127.0.0.1:9999' }, read: false, guard: false },
  { name: 'Origin on another port, same-origin label', headers: { origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin' }, read: false, guard: false },
]

test('authorizeRead and the cross-site guard decide each browser situation', () => {
  for (const { name, headers, read, guard } of cases) {
    assert.equal(authorizeRead(request(headers)), read, `authorizeRead: ${name}`)
    assert.equal(isCrossSiteSubresourceRequest(request(headers)), guard, `guard: ${name}`)
  }
})

test('authorizeRead still requires a loopback socket', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(authorizeRead(request({}, address)), true, address)
  for (const address of ['203.0.113.10', '::ffff:10.0.0.1', '']) {
    assert.equal(authorizeRead(request({ 'sec-fetch-site': 'same-origin' }, address)), false, address)
  }
  assert.equal(isLoopbackRequest({ headers: {}, socket: {} }), false)
  assert.equal(authorizeRead({ headers: { host }, socket: {} }), false)
})

test('Origin must be http on localhost or 127.0.0.1 and match this server, as for writes', () => {
  assert.equal(allowedOrigins(request()), true)
  assert.equal(allowedOrigins(request({ origin: 'http://127.0.0.1:5173' })), true)
  for (const origin of ['http://127.0.0.1:9999', 'http://localhost:5173', 'https://127.0.0.1:5173', 'http://example.com', 'null', 'not a URL']) {
    assert.equal(allowedOrigins(request({ origin })), false, origin)
  }
  assert.equal(allowedOrigins(request({ origin: 'http://localhost:5173', host: 'localhost:5173' })), true)
})

test('Unknown or malformed Sec-Fetch-Site values are not readable; header case and spacing are normalized', () => {
  for (const value of ['cross-site, same-origin', 'same_origin', '', ['same-origin']]) {
    assert.equal(isSameOriginFetchSite(request({ 'sec-fetch-site': value })), false, JSON.stringify(value))
  }
  assert.equal(isSameOriginFetchSite(request({ 'sec-fetch-site': ' Same-Origin ' })), true)
  assert.equal(isCrossSiteSubresourceRequest(request({ 'sec-fetch-site': 'Cross-Site', 'sec-fetch-mode': 'CORS' })), true)
  assert.equal(isCrossSiteSubresourceRequest(request({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': ' Navigate ' })), false)
  assert.equal(isCrossSiteSubresourceRequest(request({ 'sec-fetch-site': 'cross-site' })), true, 'missing mode is not a navigation')
})

test('The guard middleware answers 403 itself or passes the request on untouched', () => {
  const run = (headers) => {
    const headersSet = new Map()
    const response = { statusCode: 200, body: undefined, setHeader: (key, value) => headersSet.set(key, value), end(body) { this.body = body } }
    let nextCalls = 0
    crossSiteRequestGuard(request(headers), response, () => { nextCalls += 1 })
    return { response, headersSet, nextCalls }
  }
  const blocked = run({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })
  assert.equal(blocked.nextCalls, 0)
  assert.equal(blocked.response.statusCode, 403)
  assert.equal(blocked.response.body, 'Forbidden')
  assert.equal(blocked.headersSet.get('cache-control'), 'no-store')
  assert.equal(blocked.headersSet.has('access-control-allow-origin'), false)

  for (const headers of [{}, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }]) {
    const passed = run(headers)
    assert.equal(passed.nextCalls, 1, JSON.stringify(headers))
    assert.equal(passed.response.statusCode, 200)
    assert.equal(passed.headersSet.size, 0)
    assert.equal(passed.response.body, undefined)
  }
})
