/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { resources } from './resources.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../data/uiLocale.ts'

test('Bundled translations resolve immediately and apply English singular/plural rules', async () => {
  const i18n = createInstance()
  const initialized = i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  assert.equal(i18n.t('common:map'), 'Map')
  await initialized
  assert.equal(i18n.t('collection:places', { count: 0 }), '0 places')
  assert.equal(i18n.t('collection:places', { count: 1 }), '1 place')
  assert.equal(i18n.t('collection:places', { count: 2 }), '2 places')
  assert.equal(i18n.t('common:visitRecords', { count: 1 }), '1 visit record')
  assert.equal(i18n.t('collection:viewFor', { name: 'Kyoto' }), 'View on map: Kyoto')
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.equal(i18n.t('common:map'), '地图')
  assert.equal(i18n.t('collection:places', { count: 1 }), '1 个地点')
  assert.equal(i18n.t('collection:filteredPlaces', { count: 2, visible: 1 }), '1 / 2 个地点')
  assert.equal(i18n.t('collection:viewFor', { name: '京都' }), '在地图上查看：京都')
})

test('Both languages cover every translation key and preserve interpolation arguments', () => {
  const normalize = (key: string) => key.replace(/_(one|other)$/, '')
  for (const namespace of ['common', 'collection'] as const) {
    const zh = resources[DEFAULT_UI_LOCALE][namespace]
    const en = resources[EN_UI_LOCALE][namespace]
    const baseKeys = (dictionary: object) => [...new Set(Object.keys(dictionary).map(normalize))].sort()
    assert.deepEqual(baseKeys(zh), baseKeys(en), namespace)
    for (const [key, value] of Object.entries(en)) {
      const peer = Object.entries(zh).find(([candidate]) => normalize(candidate) === normalize(key))?.[1]
      const args = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
      assert.deepEqual(args(value), args(peer!), `${namespace}:${key}`)
    }
  }
})
