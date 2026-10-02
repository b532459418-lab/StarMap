/** App preferences are separate from the language tags stored in place data. */
export const DEFAULT_UI_LOCALE = 'zh-Hans'
export const EN_UI_LOCALE = 'en'
export type UiLocale = typeof DEFAULT_UI_LOCALE | typeof EN_UI_LOCALE
export const UI_LOCALE_STORAGE_KEY = 'starmap.uiLocale'
type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>

export function initialUiLocale(storage: LocaleStorage | undefined, languages: readonly string[]): UiLocale {
  try {
    const saved = storage?.getItem(UI_LOCALE_STORAGE_KEY)
    if (saved === DEFAULT_UI_LOCALE || saved === EN_UI_LOCALE) return saved
  } catch { /* A blocked browser store must not prevent startup. */ }
  for (const language of languages) {
    try {
      const tag = new Intl.Locale(language).language
      if (tag === 'zh') return DEFAULT_UI_LOCALE
      if (tag === 'en') return EN_UI_LOCALE
    } catch { /* Ignore malformed browser language tags. */ }
  }
  return EN_UI_LOCALE
}

export function persistUiLocale(storage: LocaleStorage | undefined, locale: UiLocale): void {
  try {
    storage?.setItem(UI_LOCALE_STORAGE_KEY, locale)
  } catch { /* The choice still applies to this session when storage is blocked. */ }
}
