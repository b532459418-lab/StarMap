import { appData } from './appData'
import { isLocalEditorAvailable } from './localEditorAvailability.ts'
import { forceSampleData } from './rawInputs'

// 解析、空状态与 orderBySavedIds 在纯派生层（./derive/editorState.ts，RFC-LOC-1 PR1）；
// 数据来源的选择在 ./rawInputs.ts，经 Canonical 重建的结果在 ./appData.ts（PR2）；本文件以原名导出。
export type { LocalEditorCountry, TravelAtlasEditorState } from './derive/editorState.ts'
export { orderBySavedIds } from './derive/editorState.ts'

export const travelAtlasEditorState = appData.editorState.travelAtlasEditorState

// 本地编辑只在开发服务器的个人配置下、且不是强制样例时可用（规则见 ./localEditorAvailability.ts）。
// 公开构建与强制样例下恒为 false：编辑控件根本不渲染，不靠 CSS 隐藏。
// 强制样例（?data=sample、VITE_TRAVEL_ATLAS_DATA_MODE=sample，RFC-LOC-1 PR4 审查补修）是在个人配置里预览公开版：
// 页面显示样例，写入却会落到私人目录，所以必须与公开模式渲染一致、不能编辑。判定只在 ./rawInputs.ts 一处。
// RFC-LOC-1 PR3b-2 / PR3b-3：V2 数据模式下编辑全部开放（服务端走 V2 写入，媒体端点也一样），所以这里不看数据模式；
// 媒体控件（城市照片的工具栏与上传、无人机影像的编辑区、隐藏媒体的恢复与彻底删除）同样以它为门。
// 前置的 import.meta.env.DEV 让构建产物里整条表达式在编译期就是 false，编辑相关代码随之被摇掉（与之前相同）。
export const localEditorAvailable = import.meta.env.DEV && isLocalEditorAvailable({
  dev: import.meta.env.DEV,
  mode: import.meta.env.MODE,
  forceSample: forceSampleData,
})
