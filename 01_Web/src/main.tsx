import { StrictMode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from './i18n/index.ts'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRoot } from './AppRoot.tsx'
import { boundaryNameOf, logCaughtError, type CaughtErrorInfo } from './data/caughtErrorLog.ts'
import { reportToBrowserTests } from './data/browserTestReport.ts'

// 性能续 ⑦ (the author's decision of 2026-10-30): the daily personal preview (`npm run dev:personal`) renders without
// StrictMode's double calls of renders and effects; the browser tests keep them (playwright.config.mjs sets
// VITE_STARMAP_STRICT_MODE=1 for its dev server). `dev:public` and the public build are unchanged.
const strict = import.meta.env.MODE !== 'personal' || import.meta.env.VITE_STARMAP_STRICT_MODE === '1'
// 3C-5B / D: the data (or the error page when they could not be loaded) in ./AppRoot.tsx.
const app = <I18nextProvider i18n={i18n}><AppRoot /></I18nextProvider>
// Robustness batch: every error an error boundary caught passes here. It is logged as React's default handler logs it;
// the browser tests' dev server also reports it as an uncaught page error, so a case fails unless it expects the error
// (./data/caughtErrorReport.ts). React's defaults for recoverable and uncaught errors already report them (reportError).
const onCaughtError = (error: unknown, info: CaughtErrorInfo) => {
  logCaughtError(error, info)
  reportToBrowserTests?.(boundaryNameOf(info), error)
}
createRoot(document.getElementById('root')!, { onCaughtError }).render(strict ? <StrictMode>{app}</StrictMode> : app)
