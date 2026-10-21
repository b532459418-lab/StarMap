import { useTranslation } from 'react-i18next'
import type { AppDataLoadError } from '../data/rawInputs'

/**
 * 3C-5B（规格 §2.3）：App 的数据没有加载成功时代替地图显示的页面。个人构建的读模型是单独的数据文件，启动时才加载
 * （../data/rawInputs.ts）；读不到或格式不对时，这里说清楚是哪个文件、为什么，以及该怎么打开构建，而不是一片空白。
 */
export function DataLoadError({ error }: { error: AppDataLoadError }) {
  const { t } = useTranslation('appShell')
  return (
    <main className="flex min-h-screen items-center justify-center p-6" role="alert" data-testid="data-load-error">
      <div className="glass-panel max-w-xl space-y-3 p-6">
        <h1 className="text-lg font-semibold">{t('dataLoadFailed')}</h1>
        <p className="break-words">{t('dataLoadFailedDetail', { file: error.file, reason: error.reason })}</p>
        <p>{t('dataLoadFailedHelp')}</p>
      </div>
    </main>
  )
}
