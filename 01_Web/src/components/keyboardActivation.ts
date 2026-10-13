import type { KeyboardEvent } from 'react'

/**
 * Keyboard activation for an element with role="button" that is not a <button>: Enter and Space run the same handler
 * as its click. Both keys are consumed, so Space does not scroll the page and Enter does not also activate an
 * enclosing <button>. Returns whether the key activated the element.
 */
export function activateOnKey(event: Pick<KeyboardEvent, 'key' | 'preventDefault'>, activate: () => void): boolean {
  if (event.key !== 'Enter' && event.key !== ' ') return false
  event.preventDefault()
  activate()
  return true
}
