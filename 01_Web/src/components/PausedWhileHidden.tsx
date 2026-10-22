import { memo, type ReactNode } from 'react'
import { HoldDataWhileHidden } from '../data/appStore'

/**
 * 3C-5 D: a part of the page that is not shown (a page behind another one, the map's panels while another page is up)
 * does not render again while it stays hidden: not when its parent renders (the memo below; it renders once when it is
 * hidden, with the props of that moment), not when the data change (HoldDataWhileHidden). When it is shown again, it
 * renders with the latest props and data before the browser paints. It stays mounted: its own state (scroll position,
 * filters, an open draft) is kept, and the pages' CSS fade out as before.
 */
export const PausedWhileHidden = memo(function PausedWhileHidden({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <HoldDataWhileHidden visible={visible}>{children}</HoldDataWhileHidden>
}, (previous, next) => !previous.visible && !next.visible)
