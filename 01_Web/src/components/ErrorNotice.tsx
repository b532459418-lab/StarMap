import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeLoadError } from './codeLoad.ts'
import { useDialogFocus } from './useDialogFocus.ts'

/** Where the notice stands: a page's stage, a map side panel, the map, a dialog's place, a corner of the page. */
export type ErrorNoticeVariant = 'page' | 'panel' | 'map' | 'dialog' | 'corner'

interface ErrorNoticeProps {
  /** The boundary's name (`data-error-boundary`). */
  readonly name: string
  readonly error: unknown
  /** The part that failed, translated (for example 「收藏页」 / "the Collection page"). */
  readonly part: string
  readonly variant: ErrorNoticeVariant
  /** Instead of the sentence about the part (the map's own). */
  readonly message?: string
  /** Mount the part again; offered only for an error it threw, never for code that did not load (./codeLoad.ts). */
  readonly onRetry?: () => void
  readonly retryLabel?: string
  readonly onBackToMap?: () => void
  readonly onReturnPrevious?: () => void
  readonly onClose?: () => void
  /** Corner notices only: which of the stacked places (0, 1, 2), so that several stay readable. */
  readonly slot?: number
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : error === undefined || error === null ? '' : String(error)

/**
 * The notice an error boundary shows in the place of the part that failed (robustness batch, design §2.3): what
 * failed, the error's message folded away under 「技术细节」 (never the stack), and the ways out: try again (an error the
 * part threw), back to the map, close (a dialog), and always reload the page. `role="alert"`, so screen readers read it.
 */
export function ErrorNotice({ name, error, part, variant, message, onRetry, retryLabel, onBackToMap, onReturnPrevious, onClose, slot }: ErrorNoticeProps) {
  const { t } = useTranslation('appShell')
  const codeFailed = error instanceof CodeLoadError
  const detail = messageOf(error)
  const notice = (
    <div
      className={variant === 'map' ? 'atlas-map-recovery atlas-error-notice glass-panel' : `atlas-error-notice atlas-error-notice-${variant} glass-panel`}
      role="alert"
      data-error-boundary={name}
      data-error-kind={codeFailed ? 'code' : 'render'}
      data-slot={slot}
    >
      <p className="atlas-error-notice-text">{message ?? t(codeFailed ? 'errorPartCodeFailed' : 'errorPartFailed', { part })}</p>
      {detail ? (
        <details className="atlas-error-notice-details">
          <summary>{t('errorDetails')}</summary>
          <p>{detail}</p>
        </details>
      ) : null}
      <div className="atlas-error-notice-actions">
        {onRetry && !codeFailed ? <button type="button" onClick={onRetry}>{retryLabel ?? t('errorRetry')}</button> : null}
        {onBackToMap ? <button type="button" onClick={onBackToMap}>{t('errorBackToMap')}</button> : null}
        {onReturnPrevious ? <button type="button" onClick={onReturnPrevious}>{t('returnPrevious')}</button> : null}
        {onClose ? <button type="button" onClick={onClose}>{t('errorClose')}</button> : null}
        <button type="button" onClick={() => window.location.reload()}>{t('errorReloadPage')}</button>
      </div>
    </div>
  )
  if (variant === 'page') return <div className="atlas-error-page">{notice}</div>
  if (variant === 'dialog') return <ErrorDialog onClose={onClose}>{notice}</ErrorDialog>
  return notice
}

/** A dialog's place: modal like the dialog it stands for; focus moves in, wraps, and goes back on close (Escape too). */
function ErrorDialog({ onClose, children }: { onClose?: () => void; children: ReactNode }) {
  const { t } = useTranslation('appShell')
  const { dialogRef, trapFocus } = useDialogFocus<HTMLDivElement>()
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && onClose) {
      event.stopPropagation()
      onClose()
      return
    }
    trapFocus(event)
  }
  return (
    <div className="atlas-error-dialog-backdrop">
      <div ref={dialogRef} className="atlas-error-dialog" role="dialog" aria-modal="true" aria-label={t('errorDialog')} tabIndex={-1} onKeyDown={keyDown}>
        {children}
      </div>
    </div>
  )
}
