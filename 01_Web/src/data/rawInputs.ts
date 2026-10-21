/**
 * App 的原始数据输入（RFC-LOC-1 PR2 规格 §2.7；PR3b-1 规格 §2.2；PR4 规格 §2.3；PR5a 规格 §4.1；3C-5B 规格 §2.2、§2.3）：
 * 「读哪份数据」集中在这里。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块、样例 JSON 与 import.meta.env，只能在 Vite 里跑。
 * 结果交给 ./appData.ts：读模型 → 官方视图（./store/projectCanonical.ts 的 officialViewOf）→ Canonical → 派生。
 * 脚本 scripts/baseline.mjs 按同一套规则在 Node 里选数据（公开样例：`--sample`；私人目录：默认）。
 *
 * 3C-5B 起只有一种输入：读模型 `starmap.read-model`（src/worldgraph/readModel/types.ts），读之前过 readReadModel（表头与
 * 行的形状；格式不对就抛错，页面显示错误，不会是空白的地图）。来源有两种：
 * 1. 公开模式，以及任何模式下的强制样例（VITE_TRAVEL_ATLAS_DATA_MODE=sample、开发时 ?data=sample）
 *    → 原生公开样例的读模型 ./sample/sample.read-model.json（3C-5A 生成），来源标为 'sample'。V2 样例 ./v2-sample/
 *    只留作迁移与兼容测试的输入，App 不再读。强制样例是在个人配置里预览公开版，所以本地编辑器整个关闭：./editorState.ts 的
 *    `localEditorAvailable` 看下面导出的 `forceSampleData`（RFC-LOC-1 PR4 审查补修），页面与公开模式渲染一致，
 *    不会把写入落到私人目录。
 * 2. 个人模式 → 虚拟模块注入的读模型，来源 'local'：新库的读模型；还不是新库时是 data/v2/ 的文件在内存里迁移一次得到的
 *    读模型（没有数据时为空，不回落到样例，决定 E）。旧格式的私人文件 App 不读。私人目录有没迁移的旧数据时，虚拟模块另报
 *    `privateLegacyUnmigrated`，下面的 `legacyUnmigrated` 据此让页面显示迁移提示（./privateDataNotice.ts）。
 *    个人构建不内联读模型（3C-5B 规格 §2.3）：虚拟模块只给出数据文件的路径 `privateReadModelUrl`，这里在模块加载时
 *    （顶层 await）取回它。读不到或格式不对时，`appDataLoadError` 说明是哪个文件、为什么，../main.tsx 显示错误页
 *    （../components/DataLoadError.tsx），数据当作空的读模型，页面不会是一片空白。
 */

import sampleReadModelJson from './sample/sample.read-model.json'
import {
  privateLegacyUnmigrated, privateReadModel, privateReadModelUrl, privateStoreMigrationRequired, privateStoreReadOnly, privateStoreRecoveryRequired,
  privateStoreRevision,
} from 'virtual:starmap-private-data'
import { readModelOf } from '../worldgraph/readModel/build.ts'
import { readReadModel } from '../worldgraph/readModel/check.ts'
import type { ReadModel } from '../worldgraph/readModel/types.ts'
import { emptyFormalState } from '../worldgraph/store/formal.ts'

/** 原 worldGraph.ts 的 worldGraphSessionNow：模块加载时固定一次，适配器要求 now 必填且不读时钟。 */
export const sessionNow: string = new Date().toISOString()

/**
 * 强制样例模式：环境变量，或开发时 ?data=sample。全仓库只在这里判定一次：足迹、想去的数据选择用它，
 * ./editorState.ts 的 `localEditorAvailable` 也用它（强制样例下不能编辑）。
 */
export const forceSampleData: boolean = import.meta.env.VITE_TRAVEL_ATLAS_DATA_MODE === 'sample'
  || (import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('data') === 'sample')

/** 读公开样例：公开模式，或任何模式下的强制样例（上面第 1 条）。 */
const useSampleData = forceSampleData || import.meta.env.MODE !== 'personal'

/** 官方视图的来源（Canonical 的 `travel.source`、`wantToGo.source`）：公开样例为 'sample'，私人数据为 'local'。 */
export const appDataSource: 'local' | 'sample' = useSampleData ? 'sample' : 'local'

/** App 的数据没有加载成功：哪个文件（个人构建的数据文件，或样例、虚拟模块），为什么。 */
export interface AppDataLoadError {
  readonly file: string
  readonly reason: string
}

/** 上面两种来源之一的读模型；读不到或格式不对时是空的读模型加上原因。 */
async function loadAppReadModel(): Promise<{ readonly model: ReadModel; readonly error?: AppDataLoadError }> {
  const file = useSampleData ? 'sample/sample.read-model.json' : privateReadModelUrl ?? 'virtual:starmap-private-data'
  try {
    if (useSampleData) return { model: readReadModel(sampleReadModelJson) }
    if (privateReadModelUrl === undefined) return { model: readReadModel(privateReadModel) }
    const response = await fetch(`${import.meta.env.BASE_URL}${privateReadModelUrl}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // A static server without the file often answers 200 with its index.html (an SPA fallback): say so plainly.
    const value: unknown = await response.json().catch(() => {
      throw new Error(`HTTP ${response.status}, ${response.headers.get('content-type') ?? 'no content type'}: not JSON`)
    })
    return { model: readReadModel(value) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { model: readModelOf(emptyFormalState(), { origin: useSampleData ? 'sample' : 'local' }), error: { file, reason } }
  }
}
const loaded = await loadAppReadModel()

/** App 读的读模型（上面两种来源之一）。 */
export const appReadModel: ReadModel = loaded.model

/** 读模型没有加载成功的原因（3C-5B）；成功时为 undefined。../main.tsx 据此显示错误页。 */
export const appDataLoadError: AppDataLoadError | undefined = loaded.error

/**
 * 个人模式下私人目录有没迁移的旧数据（RFC-LOC-1 PR5a 决定 I；判定在 scripts/legacy-data.mjs，插件经虚拟模块注入）。
 * 读公开样例时（公开模式、强制样例）恒为 false：页面与公开版一致，不显示迁移提示。
 */
export const legacyUnmigrated: boolean = !useSampleData && privateLegacyUnmigrated === true

/**
 * 新库（3C-3；3C-4d 起是唯一的写入方式）的全库修订号：私人根下有 data/store/world.sqlite 时，插件给出新库的读模型
 * 和这个修订号；还不是新库（只读）、公开模式与强制样例下为 undefined。只有本地编辑器（经 ./localEditorClient.ts 的门）用它：
 * 「修改想去」的请求带上它作为 x-starmap-base-revision。
 */
export const storeRevision: number | undefined = useSampleData ? undefined : privateStoreRevision

/**
 * 新库模式（3C-4b）：新库没有通过打开检查（可能已损坏），只能读取。数据照常显示，写入一律被拒绝（E_STORE_READ_ONLY）；
 * 地图页显示只读提示（./privateDataNotice.ts，只在本地编辑器可用时）。读公开样例时恒为 false。
 */
export const storeReadOnly: boolean = !useSampleData && privateStoreReadOnly === true

/**
 * 3C-4d：个人数据还没有迁移到新库（有 V2 数据、没有新库）。数据只读显示，写入一律被拒绝（E_STORE_MIGRATION_REQUIRED）；
 * 地图页提示运行迁移（./privateDataNotice.ts，只在本地编辑器可用时）。读公开样例时恒为 false。
 */
export const storeMigrationRequired: boolean = !useSampleData && privateStoreMigrationRequired === true

/**
 * 3C-4d：没有可用的新库，data/store/ 下有残留（或空的私人根没能建立新库）。只读，写入被拒绝（E_STORE_RECOVERY_REQUIRED）；
 * 地图页提示运行 npm run library:recover。读公开样例时恒为 false。
 */
export const storeRecoveryRequired: boolean = !useSampleData && privateStoreRecoveryRequired === true
