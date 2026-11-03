/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { resources } from '../i18n/resources.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../data/uiLocale.ts'
import { formatRecordDate } from '../data/derive/recordDateLabel.ts'
import { collectionCardText, regionName } from './collectionCardText.ts'

// 收藏页首开 §4.3: the texts a Collection card took from `t` itself are the same when the page translates them once.
test('the card texts translated by the page are the ones the cards translated, in both languages', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  for (const locale of [EN_UI_LOCALE, DEFAULT_UI_LOCALE]) {
    await i18n.changeLanguage(locale)
    // The cards' translation: the page's useTranslation(['collection', 'details', 'journey']).
    const t = i18n.getFixedT(locale, ['collection', 'details', 'journey'])
    const text = collectionCardText(t)
    assert.deepEqual(text, {
      date: { unknown: t('details:unknownDate'), yearOnly: t('journey:yearOnly'), partial: t('details:dateQualitypartial'),
        missing: t('details:dateQualitymissing'), invalid: t('details:dateQualityinvalid') },
      tags: { country: t('collection:wholeCountry'), hidden: t('collection:hidden'), noLocation: t('collection:noLocation'),
        travelLog: t('collection:readOnlyTravel'), sample: t('collection:sample') },
      view: t('collection:view'), visited: t('collection:visited'), editNote: t('collection:editNote'),
      restore: t('collection:restore'), delete: t('collection:delete'), hide: t('collection:hide'),
    })
    // Every text is a translation (no key left as it is).
    const values = [...Object.values(text.date), ...Object.values(text.tags), text.view, text.visited, text.editNote, text.restore, text.delete, text.hide]
    for (const value of values) assert.ok(value && !value.includes(':'), `${locale}: ${value}`)
    // The date labels as formatRecordDate takes them: a year-only date and a missing one.
    assert.equal(formatRecordDate({ year: 2024 }, text.date), `2024 · ${t('journey:yearOnly')}`)
    assert.equal(formatRecordDate({}, text.date), `${t('details:unknownDate')} · ${t('details:dateQualitymissing')}`)
  }
  await i18n.changeLanguage(EN_UI_LOCALE)
  const en = collectionCardText(i18n.getFixedT(EN_UI_LOCALE, ['collection', 'details', 'journey']))
  assert.equal(en.view, 'View on map')
  assert.equal(en.tags.country, 'Whole country')
})

test('regionName is Intl.DisplayNames, kept per locale and code; the code itself when there is no name', () => {
  for (const [code, locale] of [['IS', 'en'], ['IS', 'zh-Hans'], ['NO', 'en'], ['GL', 'en']] as const) {
    const expected = new Intl.DisplayNames([locale], { type: 'region' }).of(code)
    assert.equal(regionName(code, locale), expected)
    assert.equal(regionName(code, locale), expected)
  }
  assert.notEqual(regionName('IS', 'en'), regionName('IS', 'zh-Hans'))
  assert.equal(regionName('IS', 'not a locale!'), 'IS')
})
