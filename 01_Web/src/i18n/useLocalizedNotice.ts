import { useState } from 'react'
import { useTranslation } from 'react-i18next'

type LocalizedNotice = string | { key: string; values?: Record<string, string | number> }

/** Keep UI messages as keys so an open form's notices also follow a language change.
 * External error messages remain intact until the API adopts translated error codes. */
export function useLocalizedNotice() {
  const [notice, setNotice] = useState<LocalizedNotice>('')
  const { t } = useTranslation(['editor', 'details'])
  return [typeof notice === 'string' ? notice : t(notice.key, notice.values), setNotice] as const
}
