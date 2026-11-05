import { appCrashResources } from '../i18n/appCrashResources.ts'
import type { ErrorFallbackProps } from './ErrorBoundary.tsx'

/**
 * The root error boundary's notice (robustness batch, design §2.5): the whole page failed. It depends on nothing that
 * may have failed with it: no i18n (the text is plain data, the language is the document's, which ../i18n/index.ts
 * keeps in step with the interface language), no App component, only classes of index.css.
 */
export function RootCrashNotice({ name, error }: ErrorFallbackProps) {
  const language = typeof document === 'undefined' ? '' : document.documentElement.lang
  const text = language.startsWith('zh') ? appCrashResources.zh : appCrashResources.en
  const detail = error instanceof Error ? error.message : error === undefined || error === null ? '' : String(error)
  return (
    <main className="flex min-h-screen items-center justify-center p-6" role="alert" data-error-boundary={name}>
      <div className="glass-panel atlas-error-notice max-w-xl space-y-3 p-6">
        <h1 className="text-lg font-semibold">{text.title}</h1>
        <p>{text.detail}</p>
        {detail ? (
          <details className="atlas-error-notice-details">
            <summary>{text.technicalDetails}</summary>
            <p>{detail}</p>
          </details>
        ) : null}
        <div className="atlas-error-notice-actions">
          <button type="button" autoFocus onClick={() => window.location.reload()}>{text.reload}</button>
        </div>
      </div>
    </main>
  )
}
