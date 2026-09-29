import { appData } from './appData'

// 解析、空状态与 orderBySavedIds 在纯派生层（./derive/editorState.ts，RFC-LOC-1 PR1）；
// 数据来源的选择在 ./rawInputs.ts，经 Canonical 重建的结果在 ./appData.ts（PR2）；本文件以原名导出。
export type { LocalEditorCountry, TravelAtlasEditorState } from './derive/editorState.ts'
export { orderBySavedIds } from './derive/editorState.ts'

export const travelAtlasEditorState = appData.editorState.travelAtlasEditorState

// 本地编辑只在开发模式的个人模式下可用（公开构建里恒为 false，编辑控件根本不渲染，不靠 CSS 隐藏）。
// RFC-LOC-1 PR3b-2 / PR3b-3：V2 数据模式下编辑全部开放（服务端走 V2 写入，媒体端点也一样），所以这里不看数据模式；
// 媒体控件（城市照片的工具栏与上传、无人机影像的编辑区、隐藏媒体的恢复与彻底删除）同样以它为门。
export const localEditorAvailable = import.meta.env.DEV && import.meta.env.MODE === 'personal'
