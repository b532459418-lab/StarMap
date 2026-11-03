import type { TFunction } from 'i18next'

/**
 * 收藏页首开 §4.3: the texts of a Collection card that do not depend on the card (./CollectionPage.tsx), translated once
 * per translation function by the page instead of in each of 3 500 cards: the labels of the date (as
 * ../data/derive/recordDateLabel.ts formatRecordDate takes them), of the tags and of the action buttons. `t` is the
 * cards' translation (collection, details, journey); the texts with the card's name or date stay in the card.
 */
export function collectionCardText(t: TFunction) {
  return {
    date: {
      unknown: t('details:unknownDate'),
      yearOnly: t('journey:yearOnly'),
      partial: t('details:dateQualitypartial'),
      missing: t('details:dateQualitymissing'),
      invalid: t('details:dateQualityinvalid'),
    },
    tags: {
      country: t('collection:wholeCountry'),
      hidden: t('collection:hidden'),
      noLocation: t('collection:noLocation'),
      travelLog: t('collection:readOnlyTravel'),
      sample: t('collection:sample'),
    },
    view: t('collection:view'),
    visited: t('collection:visited'),
    editNote: t('collection:editNote'),
    restore: t('collection:restore'),
    delete: t('collection:delete'),
    hide: t('collection:hide'),
  } as const
}
export type CollectionCardText = ReturnType<typeof collectionCardText>

const regionNames = new Map<string, Intl.DisplayNames>()
const regionNameOf = new Map<string, string>()
/**
 * The name of a country code in a locale (Intl.DisplayNames; the code itself when it has none or the locale is not
 * supported). 收藏页首开 §4.3: kept per locale and code (the cards of a page share about a hundred countries).
 */
export const regionName = (countryCode: string, locale: string): string => {
  const key = `${locale}|${countryCode}`
  const known = regionNameOf.get(key)
  if (known !== undefined) return known
  let name: string
  try {
    let names = regionNames.get(locale)
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: 'region' })
      regionNames.set(locale, names)
    }
    name = names.of(countryCode) ?? countryCode
  } catch { name = countryCode }
  regionNameOf.set(key, name)
  return name
}
