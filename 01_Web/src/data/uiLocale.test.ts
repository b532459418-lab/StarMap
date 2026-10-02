/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE, initialUiLocale, persistUiLocale, UI_LOCALE_STORAGE_KEY } from './uiLocale.ts'

test('A saved manual choice takes priority over browser preferences', () => {
  const store = { getItem: (key: string) => key === UI_LOCALE_STORAGE_KEY ? EN_UI_LOCALE : null, setItem: () => {} }
  assert.equal(initialUiLocale(store, ['zh-CN']), EN_UI_LOCALE)
  assert.equal(initialUiLocale({ ...store, getItem: () => DEFAULT_UI_LOCALE }, ['en-US']), DEFAULT_UI_LOCALE)
})

test('First visit uses the first supported browser language, including regional tags', () => {
  assert.equal(initialUiLocale(undefined, ['fr-FR', 'zh-TW', 'en-US']), DEFAULT_UI_LOCALE)
  assert.equal(initialUiLocale(undefined, ['en-GB', 'zh-CN']), EN_UI_LOCALE)
  assert.equal(initialUiLocale(undefined, ['bad_tag', 'zh-CN']), DEFAULT_UI_LOCALE)
  assert.equal(initialUiLocale(undefined, ['de-DE']), EN_UI_LOCALE)
  assert.equal(initialUiLocale(undefined, []), EN_UI_LOCALE)
})

test('Invalid saved values and blocked storage do not prevent startup or session switching', () => {
  const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(initialUiLocale(blocked, ['zh-CN']), DEFAULT_UI_LOCALE)
  assert.equal(initialUiLocale({ ...blocked, getItem: () => 'unsupported' }, ['zh-CN']), DEFAULT_UI_LOCALE)
  assert.doesNotThrow(() => persistUiLocale(blocked, EN_UI_LOCALE))
  assert.doesNotThrow(() => persistUiLocale(undefined, EN_UI_LOCALE))
})

test('Manual selection is saved using the stable browser preference key', () => {
  const writes: [string, string][] = []
  persistUiLocale({ getItem: () => null, setItem: (key, value) => { writes.push([key, value]) } }, DEFAULT_UI_LOCALE)
  assert.deepEqual(writes, [[UI_LOCALE_STORAGE_KEY, DEFAULT_UI_LOCALE]])
})
