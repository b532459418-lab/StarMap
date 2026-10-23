import { useState } from 'react'

/**
 * 3C-5 D: `value` while `visible`; while hidden, the value it had when last visible. For a value a part of the page
 * that is not shown gets from its parent (the globe's places while another page is up: App.tsx), so a save does not
 * render that part again; it takes the latest value when it is shown again. `value` must keep its identity while it
 * does not change.
 */
export function useHeldWhileHidden<T>(value: T, visible: boolean): T {
  const [held, setHeld] = useState(value)
  if (visible && held !== value) setHeld(value)
  return visible ? value : held
}
