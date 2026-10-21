import { useTranslation } from 'react-i18next'
import type { AppDataLoadError } from '../data/rawInputs'

/** Codes of the dev server's read-model endpoint that mean: the data/v2/ files cannot become a read model. */
const V2_REFUSALS = new Set(['E_MIGRATION_REFUSED', 'E_V2_UNREADABLE'])
const MAX_PROBLEMS = 10

/**
 * 3C-5B（规格 §2.3；审查）：App 的数据没有加载成功时代替地图显示的页面。读模型从不内联，启动时才取回（../data/rawInputs.ts）：
 * 开发服务器的端点，或个人构建的数据文件。这里说清楚是哪个地址、为什么，以及怎样修复，而不是一片空白：
 * - data/v2/ 的文件不能迁移（还不是新库的私人根）：列出迁移的问题（只有文件、路径与规则，没有值），说明修好文件后刷新；
 * - 开发服务器的其他错误：去看运行开发服务器的终端；
 * - 个人构建：数据文件要和页面一起部署，并经网页服务器打开。
 */
export function DataLoadError({ error }: { error: AppDataLoadError }) {
  const { t } = useTranslation('appShell')
  const v2Refused = error.code !== undefined && V2_REFUSALS.has(error.code)
  const problems = error.problems ?? []
  return (
    <main className="flex min-h-screen items-center justify-center p-6" role="alert" data-testid="data-load-error">
      <div className="glass-panel max-w-xl space-y-3 p-6">
        <h1 className="text-lg font-semibold">{t('dataLoadFailed')}</h1>
        <p className="break-words">{t('dataLoadFailedDetail', { file: error.file, reason: error.reason })}</p>
        {problems.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm break-words">
            {problems.slice(0, MAX_PROBLEMS).map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        )}
        <p>{v2Refused ? t('dataLoadFailedV2') : import.meta.env.DEV ? t('dataLoadFailedDev') : t('dataLoadFailedHelp')}</p>
      </div>
    </main>
  )
}
