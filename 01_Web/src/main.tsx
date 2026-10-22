import { StrictMode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from './i18n/index.ts'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRoot } from './AppRoot.tsx'

// 3C-5B / D: the data (or the error page when they could not be loaded) in ./AppRoot.tsx.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}><AppRoot /></I18nextProvider>
  </StrictMode>,
)
