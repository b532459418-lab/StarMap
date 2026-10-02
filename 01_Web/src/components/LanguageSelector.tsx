import { DEFAULT_UI_LOCALE, EN_UI_LOCALE, type UiLocale } from '../data/uiLocale'
import { useUiLocale } from '../i18n/useUiLocale'

export function LanguageSelector() {
  const { locale, setLocale, t } = useUiLocale()
  return (
    <select className="atlas-language-selector" aria-label={t('language')} value={locale}
      onChange={(event) => setLocale(event.target.value as UiLocale)}>
      <option value={DEFAULT_UI_LOCALE}>中文</option>
      <option value={EN_UI_LOCALE}>English</option>
    </select>
  )
}
