import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DraftStatus } from '../data/drafts'

type DraftConflictNoticeProps = {
  /** `changed` or `deleted` (nothing is shown while the draft is only being edited). */
  status: DraftStatus | undefined
  /** What the draft concerns when it started, and in the data now (../data/draftProbes.ts values). */
  before: unknown
  after: unknown
  /** The id the editor's save button points to (aria-describedby) while the conflict holds the save. */
  id?: string
  busy?: boolean
  onKeepMine: () => void
  onTakeTheirs: () => void
  onDiscard: () => void
  /** The draft's own text, offered for copying when the record is gone (a note). */
  copyText?: string
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 3C-5 D (the author's decisions of 2026-10-22): the data a draft concerns changed elsewhere — another tab, a
 * command-line import. Shown inside the editor; it lists what changed (old → new) and holds the save until the user
 * keeps their changes (only the fields the draft writes are written over the new data) or takes the new content. When
 * the record was deleted elsewhere, the draft can only be discarded; a note can be copied first.
 *
 * Accessibility (batch 6): an alert (announced when it appears, without taking the focus from what the user is
 * typing), labelled by its heading and described by its list; every action is a native button, so it works by keyboard.
 */
export function DraftConflictNotice({ status, before, after, id, busy = false, onKeepMine, onTakeTheirs, onDiscard, copyText }: DraftConflictNoticeProps) {
  const { t } = useTranslation('editor')
  const ownId = useId()
  const noticeId = id ?? ownId
  const titleId = `${noticeId}-title`
  const listId = `${noticeId}-changes`
  const [copied, setCopied] = useState(false)
  // Not while the editor's own write runs: its result moves the data on, and the editor closes or goes on after it.
  if ((status !== 'changed' && status !== 'deleted') || busy) return null

  // The fields of ../data/draftProbes.ts.
  const fieldLabel = (key: string): string => {
    switch (key) {
      case 'order': return t('draftConflictField_order')
      case 'hidden': return t('draftConflictField_hidden')
      case 'cover': return t('draftConflictField_cover')
      case 'note': return t('draftConflictField_note')
      case 'start_date': return t('draftConflictField_start_date')
      case 'end_date': return t('draftConflictField_end_date')
      case 'trip_title': return t('draftConflictField_trip_title')
      case 'city': return t('draftConflictField_city')
      default: return key
    }
  }
  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return t('draftConflictEmpty')
    if (typeof value === 'boolean') return t(value ? 'draftConflictYes' : 'draftConflictNo')
    if (Array.isArray(value)) return t('draftConflictItems', { count: value.length })
    return String(value)
  }
  const changes = plain(before) && plain(after)
    ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => {
        const lists = Array.isArray(before[key]) && Array.isArray(after[key])
        return {
          key,
          label: fieldLabel(key),
          text: lists
            ? t('draftConflictListChanged', { before: (before[key] as unknown[]).length, after: (after[key] as unknown[]).length })
            : t('draftConflictValueChanged', { before: formatValue(before[key]), after: formatValue(after[key]) }),
        }
      })
    : []
  const copy = async () => {
    if (!copyText) return
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
    } catch { setCopied(false) }
  }

  return (
    <div id={noticeId} className="atlas-draft-conflict" role="alert" aria-labelledby={titleId} aria-describedby={status === 'changed' ? listId : undefined}>
      <p id={titleId} className="atlas-draft-conflict-title">{t(status === 'deleted' ? 'draftConflictDeleted' : 'draftConflictChanged')}</p>
      {status === 'changed' ? (
        <ul id={listId} className="atlas-draft-conflict-changes">
          {changes.length ? changes.map((change) => <li key={change.key}><span>{change.label}</span>{t('draftConflictSeparator')}{change.text}</li>)
            : <li>{t('draftConflictSomething')}</li>}
        </ul>
      ) : copyText ? (
        <label className="atlas-draft-conflict-copy">
          <span>{t('draftConflictYourText')}</span>
          <textarea readOnly value={copyText} rows={3} />
        </label>
      ) : null}
      <div className="atlas-draft-conflict-actions">
        {status === 'changed' ? (
          <>
            <button type="button" disabled={busy} onClick={onKeepMine}>{t('draftConflictKeepMine')}</button>
            <button type="button" disabled={busy} onClick={onTakeTheirs}>{t('draftConflictTakeTheirs')}</button>
          </>
        ) : (
          <>
            {copyText ? <button type="button" onClick={() => void copy()}>{t(copied ? 'draftConflictCopied' : 'draftConflictCopy')}</button> : null}
            <button type="button" disabled={busy} onClick={onDiscard}>{t('draftConflictDiscard')}</button>
          </>
        )}
      </div>
    </div>
  )
}
