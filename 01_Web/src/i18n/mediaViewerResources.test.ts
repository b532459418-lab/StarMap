/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { mediaViewerResources } from './mediaViewerResources.ts'
import { panoramaCaption, panoramaLanguageKeys } from './mediaViewerOptions.ts'

test('Gallery count and photo labels translate without changing place text', async () => {
  const i18n = createInstance()
  await i18n.init({
    resources: {
      en: { mediaViewer: mediaViewerResources.en },
      zh: { mediaViewer: mediaViewerResources.zh },
    },
    defaultNS: 'mediaViewer', lng: 'en', initAsync: false,
    interpolation: { escapeValue: false },
  })
  assert.equal(i18n.t('photos', { count: 1 }), '1 photo')
  assert.equal(i18n.t('photos', { count: 2 }), '2 photos')
  assert.equal(i18n.t('openPhoto', { name: '京都・Kyoto', number: 2 }), 'Open 京都・Kyoto photo 2')
  await i18n.changeLanguage('zh')
  assert.equal(i18n.t('photos', { count: 1 }), '1 张照片')
  assert.equal(i18n.t('openPhoto', { name: '京都・Kyoto', number: 2 }), '打开京都・Kyoto的第 2 张照片')
  for (const key of panoramaLanguageKeys) {
    assert.ok(mediaViewerResources.zh[key])
    assert.ok(mediaViewerResources.en[key])
  }
})

test('Panorama captions render user-authored markup as plain text', () => {
  assert.equal(panoramaCaption('旅行 <img src=x onerror=alert(1)> & City'), '旅行 &lt;img src=x onerror=alert(1)&gt; &amp; City')
  assert.equal(panoramaCaption('京都・Tokyo "2026"'), '京都・Tokyo "2026"')
})
