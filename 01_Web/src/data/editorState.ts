import { appData } from './appData'
import { isLocalEditorAvailable } from './localEditorAvailability.ts'
import { forceSampleData } from './rawInputs'

// 类型与 orderBySavedIds 在纯派生层（./derive/editorState.ts，RFC-LOC-1 PR1）；
// 数据来源的选择在 ./rawInputs.ts，经 Canonical 重建的结果在 ./appData.ts（PR2）；本文件以原名导出。
export type { LocalEditorCountry, TravelAtlasEditorState } from './derive/editorState.ts'
export { orderBySavedIds } from './derive/editorState.ts'

export const travelAtlasEditorState = appData.editorState.travelAtlasEditorState

// 本地编辑只在开发服务器的个人配置下、且不是强制样例时可用（规则见 ./localEditorAvailability.ts）。
// 公开构建与强制样例下恒为 false：编辑控件根本不渲染，不靠 CSS 隐藏。
// 强制样例（?data=sample、VITE_TRAVEL_ATLAS_DATA_MODE=sample，RFC-LOC-1 PR4 审查补修）是在个人配置里预览公开版：
// 页面显示样例，写入却会落到私人目录，所以必须与公开模式渲染一致、不能编辑。判定只在 ./rawInputs.ts 一处。
// RFC-LOC-1 PR3b-2 / PR3b-3 / PR5a：编辑全部走 V2 写入（媒体端点也一样）。私人目录的旧数据还没迁移时，服务端拒绝写入并说明原因，
// 这里不另设门（界面显示那条说明）；
// 媒体控件（城市照片的工具栏与上传、无人机影像的编辑区、隐藏媒体的恢复与彻底删除）同样以它为门。
// 前置的 import.meta.env.DEV 让任何构建（公开与个人）里它都恒为 false。编辑代码怎样移出构建产物（第 5B 批）：
// - 编辑 API（./localEditorApi.ts）、只在编辑时出现的对话框与 exifr 都是按需加载，`import()` 写在
//   `import.meta.env.DEV && localEditorAvailable` 为真的分支里（./localEditorClient.ts、App.tsx、./droneMetadata.ts）。
//   构建时前半句在模块转换阶段就被替换成字面量 false，Rolldown 不再把这些 `import()` 计入 chunk 图，不生成它们的 chunk。
//   只写本常量不够：Rolldown 1.2.8 输出时会把导入的本常量折叠成 false、删掉调用，但 chunk 在此之前已经确定，
//   文件照样留在 dist 里（第 5B 批实测）。
// - 静态导入、只在 `localEditorAvailable ? … : null` 里用到的组件（例如编辑工具栏）靠同一次折叠删掉：
//   分支不可达，组件随之无人引用，不进入构建产物。
// CI 的公开冒烟检查要求 dist 里没有任何 `/__travelatlas/editor`。
export const localEditorAvailable = import.meta.env.DEV && isLocalEditorAvailable({
  dev: import.meta.env.DEV,
  mode: import.meta.env.MODE,
  forceSample: forceSampleData,
})
