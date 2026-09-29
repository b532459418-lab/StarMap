import { dataMode } from '../data/appData'
import { dataModeNotice } from '../data/dataModeNotice'
import { plannedRecords, travelAtlasMeta } from '../data/travelAtlas'
import { wantToGoItems } from '../data/wantToGo'

// 数据在模块加载时就固定了，所以只算一次。显示规则见 ../data/dataModeNotice.ts。
const notice = dataModeNotice({
  personal: import.meta.env.MODE === 'personal',
  dataMode,
  travelRecordCount: travelAtlasMeta.importedRecords + plannedRecords.length,
  wantToGoItemCount: wantToGoItems.length,
})

/**
 * RFC-LOC-1 PR3b-1 §2.4（PR3b-3 §2.6 去掉只读说明）：个人模式 · V2 数据模式下，没有任何足迹与想去时地图页上方的空状态。
 * 公开模式、旧模式与有数据时不渲染。不拦截指针（pointer-events-none），不遮挡地球交互；
 * 沿用本地编辑器提示的类名（atlas-local-editor-empty）与地图页的 glass-panel 主题变量。
 */
export function DataModeNotice() {
  if (!notice) return null
  return (
    <div
      className="glass-panel pointer-events-none absolute left-1/2 top-[calc(var(--atlas-overlay-top)+12px)] w-max max-w-[calc(100vw-32px)] -translate-x-1/2 px-2 pt-2"
      role="status"
    >
      <p className="atlas-local-editor-empty">{notice.empty}</p>
    </div>
  )
}
