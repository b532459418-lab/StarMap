import { useEffect } from 'react'
import App from './App.tsx'
import { DataLoadError } from './components/DataLoadError.tsx'
import { useAppSnapshot } from './data/appStore.ts'

/**
 * 3C-5 D: the read model is no longer awaited at the top of a module. Private data arrive after the first render: until
 * then an empty, busy page (as before, when the page stayed blank while the module waited); when they cannot be loaded
 * (3C-5B), the error page, never a blank map.
 */
export function AppRoot() {
  const snapshot = useAppSnapshot()
  // 3C-5 D (development only; no build has it): the revision of the data the page has rendered, for the browser tests
  // and the save-to-usable measurement (they wait for it instead of a reload).
  useEffect(() => {
    if (!import.meta.env.DEV || snapshot.status !== 'ready') return
    document.documentElement.dataset.starmapRevision = String(snapshot.revision)
  }, [snapshot.status, snapshot.revision])
  if (snapshot.status === 'loading') return <div className="min-h-screen" aria-busy="true" />
  if (snapshot.status === 'error' && snapshot.error) return <DataLoadError error={snapshot.error} />
  return <App />
}
