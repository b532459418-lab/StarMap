import { privateEditorState } from 'virtual:starmap-private-data'
import { deriveEditorState } from './derive/editorState.ts'

// 解析、空状态与 orderBySavedIds 在纯派生层（./derive/editorState.ts，RFC-LOC-1 PR1）；
// 本文件只负责选出数据来源（虚拟模块）并以原名导出。
export type { LocalEditorCountry, TravelAtlasEditorState } from './derive/editorState.ts'
export { orderBySavedIds } from './derive/editorState.ts'

export const travelAtlasEditorState = deriveEditorState(privateEditorState)

export const localEditorAvailable = import.meta.env.DEV && import.meta.env.MODE === 'personal'
