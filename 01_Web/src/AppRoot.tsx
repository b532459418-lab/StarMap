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
  if (snapshot.status === 'loading') return <div className="min-h-screen" aria-busy="true" />
  if (snapshot.status === 'error' && snapshot.error) return <DataLoadError error={snapshot.error} />
  return <App />
}
