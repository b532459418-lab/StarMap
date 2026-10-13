/** A Tab stop inside a dialog; radio buttons carry their group, because Tab leaves a radio group as a whole. */
export type DialogTabStop = { readonly radioGroup?: string }

/**
 * Where Tab (or Shift+Tab with `backwards`) must send focus to stay inside a modal dialog; extracted from
 * MediaRecoveryCenter so every aria-modal dialog wraps the same way.
 *
 * `stops` are the dialog's Tab stops in document order. `active.position` is the focused element's index among them,
 * or, for a focused element that is not a stop (the dialog itself), the number of stops before it minus one half.
 *
 * Returns the index to focus when the browser's own order would leave the dialog, `null` when the dialog has nothing
 * to focus (the key is still swallowed), or `undefined` when the browser's own order stays inside.
 */
export function dialogTabWrapTarget(
  stops: readonly DialogTabStop[],
  active: { readonly position: number; readonly radioGroup?: string },
  backwards: boolean,
): number | null | undefined {
  if (stops.length === 0) return null
  // The browser skips the rest of the focused radio group.
  const reachable = (index: number) => active.radioGroup === undefined || stops[index].radioGroup !== active.radioGroup
  if (backwards) {
    for (let index = Math.ceil(active.position) - 1; index >= 0; index -= 1) {
      if (reachable(index)) return undefined
    }
    return stops.length - 1
  }
  for (let index = Math.floor(active.position) + 1; index < stops.length; index += 1) {
    if (reachable(index)) return undefined
  }
  return 0
}
