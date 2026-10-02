import { privateDataNotice } from '../data/privateDataNotice'
import { useTranslation } from 'react-i18next'
import { legacyUnmigrated } from '../data/rawInputs'
import { plannedRecords, travelAtlasMeta } from '../data/travelAtlas'
import { wantToGoItems } from '../data/wantToGo'

// 数据在模块加载时就固定了，所以只算一次。显示规则见 ../data/privateDataNotice.ts。
const notice = privateDataNotice({
  personal: import.meta.env.MODE === 'personal',
  legacyUnmigrated,
  travelRecordCount: travelAtlasMeta.importedRecords + plannedRecords.length,
  wantToGoItemCount: wantToGoItems.length,
})

/**
 * RFC-LOC-1 PR3b-1 §2.4 / PR5a §4.1：个人模式地图页上方的提示——私人目录有没迁移的旧数据时的迁移提示，
 * 或没有任何足迹与想去时的空状态。公开模式、强制样例与有数据时不渲染。只是说明，没有按钮。
 * 不拦截指针（pointer-events-none），不遮挡地球交互；沿用本地编辑器提示的类名（atlas-local-editor-empty）
 * 与地图页的 glass-panel 主题变量。
 */
export function PrivateDataNotice() {
  const { t } = useTranslation('mapMenu')
  if (!notice) return null
  const lines = notice.kind === 'legacy-unmigrated'
    ? ['legacyUnmigrated', 'legacyMigration', 'legacyRemove']
    : ['emptyPrivateData']
  return (
    <div
      className="glass-panel pointer-events-none absolute left-1/2 top-[calc(var(--atlas-overlay-top)+12px)] w-max max-w-[min(36rem,calc(100vw-32px))] -translate-x-1/2 px-2 pt-2"
      role="status"
      data-notice={notice.kind}
    >
      <div className="atlas-local-editor-empty space-y-1">
        {lines.map((key) => <p key={key}>{t(key)}</p>)}
      </div>
    </div>
  )
}
