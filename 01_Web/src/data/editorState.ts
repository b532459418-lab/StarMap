import { appData } from './appData'

// 解析、空状态与 orderBySavedIds 在纯派生层（./derive/editorState.ts，RFC-LOC-1 PR1）；
// 数据来源的选择在 ./rawInputs.ts，经 Canonical 重建的结果在 ./appData.ts（PR2）；本文件以原名导出。
export type { LocalEditorCountry, TravelAtlasEditorState } from './derive/editorState.ts'
export { orderBySavedIds } from './derive/editorState.ts'

export const travelAtlasEditorState = appData.editorState.travelAtlasEditorState

export const localEditorAvailable = import.meta.env.DEV && import.meta.env.MODE === 'personal'
