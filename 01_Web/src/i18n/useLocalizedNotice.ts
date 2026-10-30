import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { formatEditorError } from './editorErrors.ts'

type LocalizedNotice = string | Error | { key: string; values?: Record<string, string | number> }

/** Keep UI messages as keys so an open form's notices also follow a language change.
 * Known editor error codes translate at display time; diagnostic details and unknown errors stay intact. */
export function useLocalizedNotice() {
  const { t } = useTranslation(['editor', 'details'])
  return useLocalizedNoticeWith(t)
}

/**
 * The same with the translation of the caller's parent (性能续 a: a list of many cards subscribes once, in the page,
 * instead of once per card). `t` must be the editor and details namespaces, as `useLocalizedNotice` takes them.
 */
export function useLocalizedNoticeWith(t: TFunction) {
  const [notice, setNotice] = useState<LocalizedNotice>('')
  return [typeof notice === 'string' ? notice : notice instanceof Error ? formatEditorError(notice, t) : t(notice.key, notice.values), setNotice] as const
}
