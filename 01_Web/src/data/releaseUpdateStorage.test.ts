/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyUpdateText, readUpdateStorage, writeUpdateStorage } from './releaseUpdateStorage.ts'

const refuse = () => { throw new DOMException('Storage is disabled', 'SecurityError') }

test('A blocked, full or missing store reads as nothing recorded and writes nothing, without throwing', () => {
  const blocked = { getItem: refuse, setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') } }
  assert.equal(readUpdateStorage('travel-atlas:update:owner/repo', () => blocked), null)
  assert.doesNotThrow(() => writeUpdateStorage('travel-atlas:update:owner/repo:dismissed', 'v9.9.9', () => blocked))
  // Reading window.localStorage itself throws when site data is blocked.
  assert.equal(readUpdateStorage('key', refuse), null)
  assert.doesNotThrow(() => writeUpdateStorage('key', 'value', refuse))
  // Node has no window: the default store is unavailable, not an error.
  assert.equal(readUpdateStorage('key'), null)
  assert.doesNotThrow(() => writeUpdateStorage('key', 'value'))
})

test('A working store keeps its values', () => {
  const values = new Map<string, string>()
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
  assert.equal(readUpdateStorage('dismissed', storage), null)
  writeUpdateStorage('dismissed', 'v1.2.3', storage)
  assert.equal(readUpdateStorage('dismissed', storage), 'v1.2.3')
})

test('Copying reports failure for a rejected, throwing or missing clipboard instead of rejecting', async () => {
  const written: string[] = []
  assert.equal(await copyUpdateText('prompt', () => ({ writeText: async (text: string) => { written.push(text) } })), true)
  assert.deepEqual(written, ['prompt'])
  assert.equal(await copyUpdateText('prompt', () => ({ writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) })), false)
  assert.equal(await copyUpdateText('prompt', () => ({ writeText: () => { throw new TypeError('not a secure context') } })), false)
  assert.equal(await copyUpdateText('prompt', () => undefined), false)
  assert.equal(await copyUpdateText('prompt', refuse), false)
  // Node has no navigator.clipboard.
  assert.equal(await copyUpdateText('prompt'), false)
})
