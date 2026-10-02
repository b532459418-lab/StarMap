import { useTranslation } from 'react-i18next'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE, persistUiLocale, type UiLocale } from '../data/uiLocale.ts'
import { browserLocaleStorage } from './index.ts'

export function useUiLocale() {
  const { t, i18n } = useTranslation('common')
  const locale: UiLocale = i18n.resolvedLanguage === DEFAULT_UI_LOCALE ? DEFAULT_UI_LOCALE : EN_UI_LOCALE
  const setLocale = (next: UiLocale) => {
    persistUiLocale(browserLocaleStorage(), next)
    void i18n.changeLanguage(next)
  }
  return { locale, setLocale, t }
}
