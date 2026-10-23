import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * 3C-5 D: a callback whose identity never changes and that always calls the latest `fn` (a parent's handler, made anew
 * each render, given to a memoized child: the child does not render again because of it).
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  useLayoutEffect(() => { latest.current = fn })
  return useCallback((...args: A) => latest.current(...args), [])
}
