import { StrictMode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from './i18n/index.ts'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DataLoadError } from './components/DataLoadError.tsx'
import { appDataLoadError } from './data/rawInputs.ts'

// 3C-5B：数据没有加载成功（个人构建的数据文件读不到或格式不对）时显示错误页，而不是一片空白或空的地图。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>{appDataLoadError ? <DataLoadError error={appDataLoadError} /> : <App />}</I18nextProvider>
  </StrictMode>,
)
