import { useState, type ReactElement } from 'react'

type Entry<P> = { readonly props: P; readonly element: ReactElement }

/**
 * 3C-5 D: the elements of a long list (the map's places and routes), kept while an item's props stay the same: after a
 * save the list creates elements only for the items whose props changed, and React passes over the others at once (the
 * same element). `same` is the memo comparator of the item. Call `begin()` before the list each render: the elements of
 * the items the list no longer shows are then let go.
 */
export function useElementCache<P>(same: (a: P, b: P) => boolean) {
  const [cache] = useState(() => {
    let shown = new Map<string, Entry<P>>()
    let before = new Map<string, Entry<P>>()
    return {
      begin() {
        before = shown
        shown = new Map()
      },
      /** The element of `key` with `props`: the one from before when its props are the same, else `create()`. */
      element(key: string, props: P, create: () => ReactElement): ReactElement {
        const known = shown.get(key) ?? before.get(key)
        const entry = known && same(known.props, props) ? known : { props, element: create() }
        shown.set(key, entry)
        return entry.element
      },
    }
  })
  return cache
}
