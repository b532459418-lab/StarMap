import { DEFAULT_UI_LOCALE, EN_UI_LOCALE, type UiLocale } from '../data/uiLocale.ts'
import { originalNameSubtitle, resolveName, type LocalizedText } from '../worldgraph/localizedText.ts'

export type NamedPlace = { id?: string; nameZh?: string; nameEn?: string }

export function localizedPlaceNames(title: LocalizedText | undefined, place: NamedPlace, locale: UiLocale) {
  const text = title ?? { names: {
    ...(place.nameZh ? { [DEFAULT_UI_LOCALE]: place.nameZh } : {}),
    ...(place.nameEn ? { [EN_UI_LOCALE]: place.nameEn } : {}),
  } }
  return { name: resolveName(text, locale), subtitle: originalNameSubtitle(text, locale) }
}

export function regionName(countryCode: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(countryCode.toUpperCase()) ?? countryCode }
  catch { return countryCode }
}
