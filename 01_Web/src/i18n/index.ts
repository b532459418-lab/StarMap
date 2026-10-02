import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE, initialUiLocale } from '../data/uiLocale.ts'
import { resources } from './resources.ts'

export function browserLocaleStorage(): Storage | undefined {
  try { return window.localStorage } catch { return undefined }
}

export const i18n = createInstance()
// Bundled resources initialize synchronously, before React's first render.
void i18n.use(initReactI18next).init({
  resources,
  lng: initialUiLocale(browserLocaleStorage(), navigator.languages),
  fallbackLng: EN_UI_LOCALE,
  supportedLngs: [DEFAULT_UI_LOCALE, EN_UI_LOCALE],
  load: 'currentOnly',
  defaultNS: 'common',
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

function applyDocumentLocale() {
  document.documentElement.lang = i18n.resolvedLanguage ?? EN_UI_LOCALE
  document.documentElement.dir = 'ltr'
}
applyDocumentLocale()
i18n.on('languageChanged', applyDocumentLocale)
