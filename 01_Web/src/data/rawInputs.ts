/**
 * App 的原始数据输入（RFC-LOC-1 PR2 规格 §2.7；PR3b-1 规格 §2.2；PR4 规格 §2.3；PR5a 规格 §4.1）：「读哪份数据」集中在这里。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块、样例 JSON 与 import.meta.env，只能在 Vite 里跑。
 * 结果交给 ./appData.ts：canonicalForInputs（V2 Reader）→ Canonical → 派生。
 * 脚本 scripts/baseline.mjs 按同一套规则在 Node 里选数据（公开样例：`--sample`；私人目录：默认）。
 *
 * PR5a 起只有两种输入，都是五个 V2 文件：
 * 1. 公开模式，以及任何模式下的强制样例（VITE_TRAVEL_ATLAS_DATA_MODE=sample、开发时 ?data=sample）
 *    → 公开样例的 V2 文件 src/data/v2-sample/，来源标为 'sample'。editor-state 与媒体也取样例里的
 *    （空文件），不叠加私人目录的值。强制样例是在个人配置里预览公开版，所以本地编辑器整个关闭：./editorState.ts 的
 *    `localEditorAvailable` 看下面导出的 `forceSampleData`（RFC-LOC-1 PR4 审查补修），页面与公开模式渲染一致，
 *    不会把写入落到私人目录。
 * 2. 个人模式 → 虚拟模块注入的私人目录 data/v2/ 的五个文件，来源 'local'；没有数据时为空，不回落到样例（决定 E）。
 *    旧格式的私人文件 App 不读。私人目录有没迁移的旧数据时，虚拟模块另报 `privateLegacyUnmigrated`，
 *    下面的 `legacyUnmigrated` 据此让页面显示迁移提示（./privateDataNotice.ts）。
 */

import v2SampleEditorState from './v2-sample/editor-state.json'
import v2SampleMedia from './v2-sample/user-media.json'
import v2SamplePlaces from './v2-sample/places.json'
import v2SampleTravel from './v2-sample/travel-map.json'
import v2SampleWantToGo from './v2-sample/want-to-go.json'
import {
  privateLegacyUnmigrated, privateStoreMigrationRequired, privateStoreReadOnly, privateStoreRecoveryRequired, privateStoreRevision, privateV2Files,
} from 'virtual:starmap-private-data'
import type { AppInputs, V2FileInputs } from './canonical/canonicalForInputs.ts'

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

/** 公开样例的五个 V2 文件（手工维护，scripts/v2-sample.mjs 列出文件名，npm run privacy:check 校验）。 */
const v2SampleFiles: V2FileInputs = {
  places: v2SamplePlaces,
  travel: v2SampleTravel,
  wantToGo: v2SampleWantToGo,
  editorState: v2SampleEditorState,
  media: v2SampleMedia,
}

/** 交给 canonicalForInputs 的输入。 */
export const appInputs: AppInputs = useSampleData
  ? { v2Files: v2SampleFiles, source: 'sample' }
  : { v2Files: privateV2Files }

/**
 * 个人模式下私人目录有没迁移的旧数据（RFC-LOC-1 PR5a 决定 I；判定在 scripts/legacy-data.mjs，插件经虚拟模块注入）。
 * 读公开样例时（公开模式、强制样例）恒为 false：页面与公开版一致，不显示迁移提示。
 */
export const legacyUnmigrated: boolean = !useSampleData && privateLegacyUnmigrated === true

/**
 * 新库（3C-3；3C-4d 起是唯一的写入方式）的全库修订号：私人根下有 data/store/world.sqlite 时，插件把新库投影成上面同样的
 * 五个 V2 文件，另外给出这个修订号；还不是新库（只读）、公开模式与强制样例下为 undefined。只有本地编辑器（经 ./localEditorClient.ts 的门）用它：
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
