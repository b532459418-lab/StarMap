import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { dialogTabWrapTarget } from './dialogFocus.ts'

const tabStopSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]'

const radioOf = (element: Element) => element instanceof HTMLInputElement && element.type === 'radio' && element.name
  ? element
  : undefined

/** Visible Tab stops in document order; a radio group with a checked radio is reached only through that radio. */
function tabStopsIn(dialog: HTMLElement): HTMLElement[] {
  const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(tabStopSelector))
    .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
  const checkedGroups = new Set(candidates.flatMap((element) => {
    const radio = radioOf(element)
    return radio?.checked ? [radio.name] : []
  }))
  return candidates.filter((element) => {
    const radio = radioOf(element)
    return !radio || radio.checked || !checkedGroups.has(radio.name)
  })
}

type DialogFocusOptions = {
  /** For a dialog that stays mounted while closed; one that mounts when it opens leaves it out. */
  open?: boolean
  /** Where focus goes back on close, when the opener records it itself; otherwise the element focused at mount. */
  returnFocus?: RefObject<HTMLElement | null>
}

/**
 * Focus handling shared by every aria-modal dialog, extracted from MediaRecoveryCenter:
 * - on open, focus moves into the dialog; an element inside that already has focus (autoFocus, or the dialog's own
 *   first-field focus) keeps it, otherwise the dialog element itself (`tabIndex={-1}`) takes it;
 * - Tab and Shift+Tab wrap inside the dialog (`trapFocus` on the dialog's onKeyDown);
 * - on close, focus returns to the element that had it before the dialog opened.
 *
 * The dialog element must leave the document when the dialog closes: that is how a real close is told apart from
 * React StrictMode's simulated unmount, which keeps the element and must not move focus out.
 */
export function useDialogFocus<T extends HTMLElement>({ open = true, returnFocus }: DialogFocusOptions = {}) {
  const dialogRef = useRef<T>(null)
  // Read while the opening dialog renders, before an autoFocus child inside it can take focus.
  const [opener] = useState(() => typeof document === 'undefined' ? null : document.activeElement)

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    // Read at open: a dialog that records its own opener sets it before opening.
    const target = returnFocus ? returnFocus.current : opener
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus()
    return () => {
      if (dialog?.isConnected) return
      if (target instanceof HTMLElement || target instanceof SVGElement) target.focus()
    }
  }, [open, opener, returnFocus])

  const trapFocus = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const stops = tabStopsIn(dialog)
    const active = document.activeElement
    let position = active instanceof HTMLElement ? stops.indexOf(active) : -1
    if (position < 0) {
      position = stops.filter((stop) => active && stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).length - 0.5
    }
    const radio = active ? radioOf(active) : undefined
    const target = dialogTabWrapTarget(
      stops.map((stop) => ({ radioGroup: radioOf(stop)?.name })),
      { position, radioGroup: radio?.name },
      event.shiftKey,
    )
    if (target === undefined) return
    event.preventDefault()
    if (target !== null) stops[target].focus()
  }, [])

  return { dialogRef, trapFocus }
}
