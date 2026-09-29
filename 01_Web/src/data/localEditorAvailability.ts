/**
 * 本地编辑器是否可用（RFC-LOC-1 PR4 审查补修）——规则写成纯函数，`./editorState.ts` 用它算出 `localEditorAvailable`。
 *
 * 三个条件同时满足才可用：
 * - 开发服务器（`import.meta.env.DEV`）：构建产物里没有写入接口，编辑控件一律不渲染；
 * - 个人配置（`import.meta.env.MODE === 'personal'`）：公开配置只有中性样例，也没有写入接口；
 * - 不是强制样例（`VITE_TRAVEL_ATLAS_DATA_MODE=sample` 或开发时 `?data=sample`，判定只在 `./rawInputs.ts` 一处）：
 *   强制样例是在个人配置里预览公开版，页面显示的是样例而不是私人数据，所以必须与公开模式渲染一致、不能编辑——
 *   否则「添加国家」、上传、排序与隐藏会把写入落到私人目录里，而页面上看到的却是样例。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，不用 import.meta（单测在 Node 里跑）。
 */

export interface LocalEditorAvailabilityInput {
  /** `import.meta.env.DEV`：开发服务器为 true，构建产物为 false。 */
  dev: boolean
  /** `import.meta.env.MODE`：`personal` 或 `public`。 */
  mode: string
  /** 强制样例（`./rawInputs.ts` 的 `forceSampleData`）。 */
  forceSample: boolean
}

/** 开发服务器 + 个人配置 + 不是强制样例。 */
export const isLocalEditorAvailable = ({ dev, mode, forceSample }: LocalEditorAvailabilityInput): boolean =>
  dev && mode === 'personal' && !forceSample
