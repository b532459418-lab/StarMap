/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { mapMenuResources } from './mapMenuResources.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../data/uiLocale.ts'

test('Layer recovery counts and an open notice follow language without rewriting place names', async () => {
  const i18n = createInstance()
  await i18n.init({
    resources: {
      [DEFAULT_UI_LOCALE]: { mapMenu: mapMenuResources.zh },
      [EN_UI_LOCALE]: { mapMenu: mapMenuResources.en },
    },
    lng: EN_UI_LOCALE,
    fallbackLng: EN_UI_LOCALE,
    initAsync: false,
  })
  assert.equal(i18n.t('mapMenu:hiddenCount', { count: 0 }), '0 hidden items')
  assert.equal(i18n.t('mapMenu:hiddenCount', { count: 1 }), '1 hidden item')
  assert.equal(i18n.t('mapMenu:hiddenCount', { count: 2 }), '2 hidden items')
  assert.equal(i18n.t('mapMenu:hiddenLayerCount', { count: 1, layer: 'Want to Go' }), '1 hidden item in the Want to Go layer')
  assert.equal(i18n.t('mapMenu:deleteConfirm', { name: '京都・Kyoto' }), 'Permanently delete “京都・Kyoto”? This cannot be undone.')
  const noticeKey = 'mapMenu:restoreFailed'
  assert.equal(i18n.t(noticeKey), 'Could not restore this place.')
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.equal(i18n.t('mapMenu:hiddenCount', { count: 1 }), '已隐藏 1 项')
  assert.equal(i18n.t('mapMenu:hiddenLayerCount', { count: 2, layer: '想去' }), '想去图层已隐藏 2 项')
  assert.equal(i18n.t('mapMenu:deleteConfirm', { name: '京都・Kyoto' }), '确定彻底删除「京都・Kyoto」吗？此操作无法撤销。')
  assert.equal(i18n.t(noticeKey), '恢复失败。')
})
