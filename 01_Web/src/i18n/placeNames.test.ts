/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localizedPlaceNames, regionName } from './placeNames.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../data/uiLocale.ts'

test('Detail and Journey names use registry translations and only a known original as subtitle', () => {
  const title = { names: { 'zh-Hans': '东京', en: 'Tokyo', ja: '東京' }, originalLanguage: 'ja' }
  const legacy = { nameZh: 'legacy Chinese', nameEn: 'legacy English' }
  assert.deepEqual(localizedPlaceNames(title, legacy, EN_UI_LOCALE), { name: 'Tokyo', subtitle: '東京' })
  assert.deepEqual(localizedPlaceNames(title, legacy, DEFAULT_UI_LOCALE), { name: '东京', subtitle: '東京' })
  assert.deepEqual(localizedPlaceNames({ names: { en: 'Tokyo' }, originalLanguage: 'en' }, legacy, EN_UI_LOCALE), { name: 'Tokyo', subtitle: undefined })
})

test('Legacy UI projections fall back safely without inventing an original language', () => {
  assert.deepEqual(localizedPlaceNames(undefined, { nameZh: '京都', nameEn: 'Kyoto' }, EN_UI_LOCALE), { name: 'Kyoto', subtitle: undefined })
  assert.equal(localizedPlaceNames(undefined, { nameZh: '京都' }, EN_UI_LOCALE).name, '京都')
  assert.equal(regionName('jp', EN_UI_LOCALE), 'Japan')
  assert.equal(regionName('jp', DEFAULT_UI_LOCALE), '日本')
  assert.equal(regionName('invalid!', EN_UI_LOCALE), 'invalid!')
})
