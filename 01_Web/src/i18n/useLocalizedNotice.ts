import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatEditorError } from './editorErrors.ts'

type LocalizedNotice = string | Error | { key: string; values?: Record<string, string | number> }

/** Keep UI messages as keys so an open form's notices also follow a language change.
 * Known editor error codes translate at display time; diagnostic details and unknown errors stay intact. */
export function useLocalizedNotice() {
  const [notice, setNotice] = useState<LocalizedNotice>('')
  const { t } = useTranslation(['editor', 'details'])
  return [typeof notice === 'string' ? notice : notice instanceof Error ? formatEditorError(notice, t) : t(notice.key, notice.values), setNotice] as const
}
