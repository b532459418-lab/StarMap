/**
 * App 读到的全部数据（RFC-LOC-1 PR2 规格 §2.7）：
 *
 *   原始输入（./rawInputs.ts）──Legacy Adapter──> Canonical Model ──派生──> 六个数据模块的导出
 *
 * 这里【不是】 StarMap Core：它经 ./rawInputs.ts 依赖 Vite 虚拟模块与 import.meta.env。
 * 模块级只算一次：适配器与派生都是纯函数，输入是模块级常量，所以导出的对象引用天然稳定
 * （地图侧的 useMemo 靠它避免无谓重算，AC-8）。
 *
 * travelAtlas.ts、editorState.ts、mediaCatalog.ts、droneMedia.ts、wantToGo.ts、worldGraph.ts
 * 从这里取值、以原名导出；导出名与类型不变，其他文件的 import 不改。
 * PR1 的 deriveAppData（./derive/appData.ts）仍保留，供 normalizeLegacy 与 scripts/legacy-baseline.mjs 比对用，
 * App 不再调用它。
 */

import { deriveAppDataFromCanonical } from './canonical/derive.ts'
import { legacyAdapter } from './canonical/legacyAdapter.ts'
import { rawAppInputs } from './rawInputs.ts'

/** 模块加载时固定一次。适配器要求 options.now 必填且不读时钟，时间从这里注入。worldGraph.ts 以原名导出。 */
export const worldGraphSessionNow: string = rawAppInputs.now

const canonical = legacyAdapter(rawAppInputs)

export const appData = deriveAppDataFromCanonical(canonical, { now: worldGraphSessionNow })

if (import.meta.env.DEV) {
  const { wantToGoDataSource, wantToGoProblems } = appData.wantToGo
  if (wantToGoProblems.length > 0) {
    // 样例出现 problem 是构建缺陷：tracked 的样例由 npm run privacy:check 兜底，不该带坏数据。
    const fileName = wantToGoDataSource === 'sample' ? 'want-to-go.sample.json（公开样例，属构建缺陷）' : 'want-to-go.local.json'
    console.warn(
      `[StarMap] ${fileName} 有 ${wantToGoProblems.length} 条记录被跳过：\n${wantToGoProblems.join('\n')}`,
    )
  }

  // 媒体目录逐条校验（PR1 发现 7）：坏条目跳过，不再让整个 App 加载失败。只报序号与原因，不报内容。
  const mediaProblems = canonical.media.problems
  if (mediaProblems.length > 0) {
    console.warn(
      `[StarMap] user-media.local.json 有 ${mediaProblems.length} 条媒体记录被跳过：\n${mediaProblems.join('\n')}`,
    )
  }
}
