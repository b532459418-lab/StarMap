import { appData, dataMode } from './appData'

// 解析、空状态与 orderBySavedIds 在纯派生层（./derive/editorState.ts，RFC-LOC-1 PR1）；
// 数据来源的选择在 ./rawInputs.ts，经 Canonical 重建的结果在 ./appData.ts（PR2）；本文件以原名导出。
export type { LocalEditorCountry, TravelAtlasEditorState } from './derive/editorState.ts'
export { orderBySavedIds } from './derive/editorState.ts'

export const travelAtlasEditorState = appData.editorState.travelAtlasEditorState

// 本地编辑只在开发模式的个人模式下可用（公开构建里恒为 false，编辑控件根本不渲染，不靠 CSS 隐藏）。
// RFC-LOC-1 PR3b-2 §2.7：V2 数据模式下非媒体编辑已开放（服务端走 V2 写入），所以这里不再看数据模式。
export const localEditorAvailable = import.meta.env.DEV && import.meta.env.MODE === 'personal'

// 媒体编辑（城市照片的工具栏与上传、无人机影像的编辑区、隐藏媒体的恢复与彻底删除）在 V2 数据模式下仍关闭，
// 由 RFC-LOC-1 PR3b-3 开放。这些控件以它为门，在 V2 下根本不渲染；服务端另外对三个媒体端点返回 409。
export const mediaEditorAvailable = localEditorAvailable && dataMode !== 'v2'
