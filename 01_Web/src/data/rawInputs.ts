/**
 * App 的原始数据输入（RFC-LOC-1 PR2 规格 §2.7）：「读哪份数据」集中在这里。
 *
 * 这里【不是】 StarMap Core：它 import 了 Vite 虚拟模块、样例 JSON 与 import.meta.env，只能在 Vite 里跑。
 * 下面的判断原样搬自 travelAtlas.ts、editorState.ts、mediaCatalog.ts、wantToGo.ts、worldGraph.ts
 * （PR1 时它们各自留在原文件）；结果交给 ./appData.ts：Legacy Adapter → Canonical → 派生。
 * 脚本 scripts/legacy-baseline.mjs 按同一套规则在 Node 里选数据。
 */

import travelMapSample from './travel-map.sample.json'
import wantToGoSample from './want-to-go.sample.json'
import {
  privateEditorState,
  privateMediaCatalog,
  privateTravelMap,
  privateWantToGo,
} from 'virtual:starmap-private-data'
import type { RawAppInputs } from './derive/appData.ts'
import { isTravelMapExport, type TravelMapExport } from './derive/travelAtlas.ts'
import type { WantToGoDataSource } from './derive/wantToGo.ts'

// 强制样例模式：环境变量，或开发时 ?data=sample。足迹与想去用同一个判断。
const forceSampleData = import.meta.env.VITE_TRAVEL_ATLAS_DATA_MODE === 'sample'
  || (import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('data') === 'sample')

// ---- 足迹（原 travelAtlas.ts）：私有文件有效（有 records 数组）用私有，否则样例 ----
const localTravelMap = forceSampleData
  ? undefined
  : isTravelMapExport(privateTravelMap) ? privateTravelMap : undefined
const travelMap = localTravelMap ?? (travelMapSample as TravelMapExport)
const travelAtlasDataSource: 'local' | 'sample' = localTravelMap ? 'local' : 'sample'

// ---- 想去（原 wantToGo.ts，FR-PUB-1），按顺序判定 ----
// 1. 强制样例模式 → 样例；
// 2. 否则个人模式 → 私有文件；文件不存在 → 空列表，【不】回落样例（样例条目会带着写私有文件的「隐藏」按钮）；
// 3. 否则（公开模式）→ 样例。公开模式下虚拟模块本来就不注入任何私有数据。
const useSampleData = forceSampleData || import.meta.env.MODE !== 'personal'
const hasLocalWantToGo = !useSampleData && privateWantToGo !== undefined && privateWantToGo !== null
const wantToGoDataSource: WantToGoDataSource = useSampleData
  ? 'sample'
  : hasLocalWantToGo ? 'local' : 'none'
// 各来源对应的原始值；'none'（私有文件不存在）时派生层直接给空列表，不解析、不报 problem。
const wantToGoValue = wantToGoDataSource === 'sample'
  ? wantToGoSample
  : wantToGoDataSource === 'local'
    ? privateWantToGo
    : undefined

export const rawAppInputs: RawAppInputs = {
  travelMap,
  travelAtlasDataSource,
  // editor-state 与媒体目录（原 editorState.ts / mediaCatalog.ts）：虚拟模块注入的私有值，不受样例模式影响。
  editorState: privateEditorState,
  mediaCatalog: privateMediaCatalog,
  wantToGo: { source: wantToGoDataSource, value: wantToGoValue },
  // 原 worldGraph.ts 的 worldGraphSessionNow：模块加载时固定一次，适配器要求 now 必填且不读时钟。
  now: new Date().toISOString(),
}
