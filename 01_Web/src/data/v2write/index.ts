/**
 * V2 写入（RFC-LOC-1 PR3b-2）：本地编辑器 8 个非媒体写入端点与 `GET /editor/state` 在 V2 数据模式下的纯函数。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。插件（scripts/local-editor-plugin.mjs）经
 * scripts/v2-editor-store.mjs 调用这里：读 `data/v2/` → 调纯函数 → 按 `writes` 的顺序原子写盘 → 回写响应。
 * 媒体写入（上传、导入、删除）不在这里：纯函数在 ../v2media/editorWrites.ts，IO 在 scripts/v2-media-store.mjs（PR3b-3）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

export { convertToTravel } from './convert.ts'
export { putEditorState, readEditorStateV1 } from './editorState.ts'
export { V2WriteError, errorBody, messageFor, type V2WriteErrorCode } from './errors.ts'
export { addCountry, addTravelRecord, deleteHiddenCountries } from './footprint.ts'
export { integrityProblems, type CatalogCountry, type V2FilesOrEmpty, type V2Write, type V2WriteContext, type V2WriteOutcome } from './transaction.ts'
export { addWantToGo, deleteHiddenWantToGo, updateWantToGo } from './wantToGo.ts'
