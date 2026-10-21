/**
 * App 读到的全部数据（RFC-LOC-1 PR2 规格 §2.7；3C-5B 规格 §2.2 起读读模型）：
 *
 *   读模型（./rawInputs.ts）──官方视图──> Canonical Model ──派生──> 六个数据模块的导出
 *
 * 官方视图（./store/projectCanonical.ts 的 officialViewOf）是新库到 Canonical 的投影本身（projectStoreToCanonical，
 * 不记录 skipped、不冻结），没有第二套实现。读模型的来源：个人模式是私人数据（新库，或还没迁移时在内存里迁移的
 * data/v2/），公开模式与强制样例是原生公开样例 ./sample/sample.read-model.json，来源标为 'sample'（选择见 ./rawInputs.ts）。
 * 读模型里只有迁移和编辑器写入的行：迁移会拒绝 readV2 要跳过的记录，所以官方视图的 `problems` 恒为空，不再有
 * 「记录被跳过」的开发期警告。
 *
 * 这里【不是】 StarMap Core：它经 ./rawInputs.ts 依赖 Vite 虚拟模块与 import.meta.env。
 * 模块级只算一次：官方视图与派生都是纯函数，输入是模块级常量，所以导出的对象引用天然稳定
 * （地图侧的 useMemo 靠它避免无谓重算，AC-8）。改成 hook 是 3C-5 子批 D 的事。
 *
 * travelAtlas.ts、editorState.ts、mediaCatalog.ts、droneMedia.ts、wantToGo.ts、worldGraph.ts
 * 从这里取值、以原名导出；导出名与类型不变，其他文件的 import 不改。
 * 基线工具 scripts/baseline.mjs 与 App 走同一条管线。
 */

import { deriveAppDataFromCanonical } from './canonical/derive.ts'
import { deriveTimeQueryContext } from './derive/timeQueryContext.ts'
import { appDataSource, appReadModel, sessionNow } from './rawInputs.ts'
import { officialViewOf } from './store/projectCanonical.ts'

/** 模块加载时固定一次。适配器要求 options.now 必填且不读时钟，时间从这里注入。worldGraph.ts 以原名导出。 */
export const worldGraphSessionNow: string = sessionNow

const canonical = officialViewOf(appReadModel, appDataSource)

export const appData = deriveAppDataFromCanonical(canonical, { now: worldGraphSessionNow })

/** RD-04 auxiliary query input, derived from the same official view. It is
 * separate from the six legacy data exports; their baseline format remains @4.
 * Raw date evidence and original endpoints have independent semantic tests. */
export const timeQueryContext = deriveTimeQueryContext(canonical)
