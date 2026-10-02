import { StrictMode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from './i18n/index.ts'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}><App /></I18nextProvider>
  </StrictMode>,
)
