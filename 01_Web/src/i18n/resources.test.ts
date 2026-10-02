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
  for (const namespace of ['common', 'collection', 'editor', 'details', 'journey', 'mediaViewer', 'droneEditor', 'mapMenu', 'domainError', 'appShell', 'layer', 'auxiliary'] as const) {
    const flatten = (dictionary: object, prefix = ''): Record<string, string> => Object.fromEntries(Object.entries(dictionary).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key
      return typeof value === 'string' ? [[path, value]] : Object.entries(flatten(value, path))
    }))
    const zh = flatten(resources[DEFAULT_UI_LOCALE][namespace])
    const en = flatten(resources[EN_UI_LOCALE][namespace])
    const baseKeys = (dictionary: object) => [...new Set(Object.keys(dictionary).map(normalize))].sort()
    assert.deepEqual(baseKeys(zh), baseKeys(en), namespace)
    for (const [key, value] of Object.entries(en)) {
      const peer = Object.entries(zh).find(([candidate]) => normalize(candidate) === normalize(key))?.[1]
      const args = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
      assert.deepEqual(args(value), args(peer!), `${namespace}:${key}`)
    }
  }
})


test('Editor counts, confirmations and notices resolve in both languages without changing user values', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  assert.equal(i18n.t('details:cityCount', { count: 1 }), '1 city')
  assert.equal(i18n.t('details:cityCount', { count: 2 }), '2 cities')
  assert.match(i18n.t('editor:deletePhotosConfirm', { count: 1 }), /1 hidden photo from/)
  assert.match(i18n.t('editor:deletePhotosConfirm', { count: 2 }), /2 hidden photos from/)
  for (const key of ['restoreCountries', 'restoreCities', 'restorePhotos']) {
    assert.ok(!i18n.t(`editor:${key}`, { count: 1 }).includes(key))
  }
  const notice = { key: 'editor:minimumQuery', values: { count: 2 } }
  assert.equal(i18n.t(notice.key, notice.values), 'Enter at least 2 characters.')
  assert.equal(i18n.t('editor:hideConfirm', { name: '京都・Kyoto' }), 'Hide “京都・Kyoto” from this view? Your travel records will be kept.')
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.equal(i18n.t(notice.key, notice.values), '请至少输入 2 个字符。')
  assert.equal(i18n.t('details:cityCount', { count: 1 }), '1 个城市')
})
