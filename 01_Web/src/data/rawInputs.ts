/**
 * App 的原始数据输入（RFC-LOC-1 PR2 规格 §2.7；PR3b-1 规格 §2.2；PR4 规格 §2.3）：「读哪份数据」集中在这里。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块、样例 JSON 与 import.meta.env，只能在 Vite 里跑。
 * 结果交给 ./appData.ts：canonicalForInputs（Legacy Adapter 或 V2 Reader）→ Canonical → 派生。
 * 脚本 scripts/legacy-baseline.mjs 按同一套规则在 Node 里选数据（公开样例：`--path v2-sample`）。
 *
 * 按顺序判定（PR4 起）：
 * 1. 公开模式，以及任何模式下的强制样例（VITE_TRAVEL_ATLAS_DATA_MODE=sample、开发时 ?data=sample）
 *    → 公开样例的 V2 文件 src/data/v2-sample/，经 V2 Reader，来源标为 'sample'。editor-state 与媒体也取样例里的
 *    （空文件），不再叠加私人目录的值。强制样例是在个人配置里预览公开版，所以本地编辑器整个关闭：./editorState.ts 的
 *    `localEditorAvailable` 看下面导出的 `forceSampleData`（RFC-LOC-1 PR4 审查补修），页面与公开模式渲染一致，
 *    不会把写入落到私人目录。
 * 2. 个人模式 · v2（插件按私人目录的标记判定后注入，scripts/data-mode.mjs）→ 只读 data/v2/ 的五个文件；
 *    没有数据时为空，不回落到样例（决定 E）。
 * 3. 个人模式 · legacy → 与 PR4 之前的个人模式完全相同：足迹私有文件有效（有 records 数组）用私有，
 *    否则回落到旧格式的足迹样例（旧模式的既有行为，PR5 连同 Legacy Adapter 一起删除）；想去私有文件存在为 local，
 *    否则 none，不回落样例；editor-state 与媒体是虚拟模块注入的私有值。
 */

import travelMapSample from './travel-map.sample.json'
import v2SampleEditorState from './v2-sample/editor-state.json'
import v2SampleMedia from './v2-sample/user-media.json'
import v2SamplePlaces from './v2-sample/places.json'
import v2SampleTravel from './v2-sample/travel-map.json'
import v2SampleWantToGo from './v2-sample/want-to-go.json'
import {
  privateDataMode,
  privateEditorState,
  privateMediaCatalog,
  privateTravelMap,
  privateV2Files,
  privateWantToGo,
} from 'virtual:starmap-private-data'
import type { AppInputs, V2FileInputs } from './canonical/canonicalForInputs.ts'
import type { RawAppInputs } from './derive/appData.ts'
import { isTravelMapExport, type TravelMapExport } from './derive/travelAtlas.ts'

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

/** 公开样例的五个 V2 文件（`npm run sample:v2` 生成，scripts/v2-sample.mjs 列出文件名）。 */
const v2SampleFiles: V2FileInputs = {
  places: v2SamplePlaces,
  travel: v2SampleTravel,
  wantToGo: v2SampleWantToGo,
  editorState: v2SampleEditorState,
  media: v2SampleMedia,
}

/**
 * 个人模式 · legacy（上面第 3 条）：PR4 之前个人模式的选择，一字不改（强制样例已在第 1 条分走）。
 * 旧格式的足迹样例只在这里用：私有足迹文件无效或不存在时的既有回落。
 */
const legacyPersonalInputs = (): RawAppInputs => {
  const localTravelMap = isTravelMapExport(privateTravelMap) ? privateTravelMap : undefined
  const hasLocalWantToGo = privateWantToGo !== undefined && privateWantToGo !== null
  return {
    travelMap: localTravelMap ?? (travelMapSample as TravelMapExport),
    travelAtlasDataSource: localTravelMap ? 'local' : 'sample',
    // editor-state 与媒体目录（原 editorState.ts / mediaCatalog.ts）：虚拟模块注入的私有值。
    editorState: privateEditorState,
    mediaCatalog: privateMediaCatalog,
    // 想去（原 wantToGo.ts，FR-PUB-1）：私有文件不存在 → none（空列表），【不】回落样例。
    wantToGo: hasLocalWantToGo ? { source: 'local', value: privateWantToGo } : { source: 'none', value: undefined },
    now: sessionNow,
  }
}

/** 交给 canonicalForInputs 的输入。 */
export const appInputs: AppInputs = useSampleData
  ? { dataMode: 'v2', v2Files: v2SampleFiles, source: 'sample' }
  : privateDataMode === 'v2'
    ? { dataMode: 'v2', v2Files: privateV2Files }
    : { ...legacyPersonalInputs(), dataMode: 'legacy' }
