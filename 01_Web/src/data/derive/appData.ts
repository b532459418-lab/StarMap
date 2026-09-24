/**
 * 六个数据模块的组合派生（RFC-LOC-1 PR1 §2.3）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * `deriveAppData(raw)` 按与 App 相同的依赖顺序串起六个派生
 * （editor-state → 足迹 → 媒体 → 无人机 → 想去 → World Graph），产出与六个模块今天导出
 * 同名、按模块分组的结果，可以直接交给 `buildBaseline`（`./baseline.ts`）。
 *
 * 「选哪份数据」【不】在这里判断：App 里由六个原文件判断，基线工具里由 CLI
 * （`scripts/legacy-baseline.mjs`）判断，两边都把选好的原始值放进 `RawAppInputs`。
 * 只由运行模式决定、与数据无关的导出（editorState 的 `localEditorAvailable`）不在这里。
 */

import { deriveDroneMedia, type DroneMediaDerived } from './droneMedia.ts'
import { deriveEditorState, orderBySavedIds, type TravelAtlasEditorState } from './editorState.ts'
import { deriveMediaCatalog, getMediaSource, type MediaCatalogDerived } from './mediaCatalog.ts'
import { deriveTravelAtlas, type TravelAtlasDerived, type TravelMapExport } from './travelAtlas.ts'
import { deriveWantToGo, type WantToGoDataSource, type WantToGoDerived } from './wantToGo.ts'
import { deriveWorldGraph, type WorldGraphDerived } from './worldGraph.ts'

export interface RawAppInputs {
  /** 已经由调用方选好：私人文件有效用私人，否则样例（与 travelAtlas.ts 的规则一致）。 */
  travelMap: TravelMapExport
  travelAtlasDataSource: 'local' | 'sample'
  /** 原始值，交给派生里的 parseEditorState。 */
  editorState: unknown
  mediaCatalog: unknown
  wantToGo: { source: WantToGoDataSource; value: unknown }
  /** 快照的 createdAt / updatedAt（App 里是 worldGraphSessionNow）。 */
  now: string
}

/** 六个模块今天的全部导出（名字相同），按模块分组。 */
export interface AppData {
  travelAtlas: { travelAtlasDataSource: 'local' | 'sample' } & TravelAtlasDerived
  editorState: { travelAtlasEditorState: TravelAtlasEditorState; orderBySavedIds: typeof orderBySavedIds }
  mediaCatalog: { getMediaSource: typeof getMediaSource } & MediaCatalogDerived
  droneMedia: DroneMediaDerived
  wantToGo: { wantToGoDataSource: WantToGoDataSource } & WantToGoDerived
  worldGraph: { worldGraphSessionNow: string } & WorldGraphDerived
}

export function deriveAppData(raw: RawAppInputs): AppData {
  const travelAtlasEditorState = deriveEditorState(raw.editorState)
  const travelAtlas = deriveTravelAtlas(raw.travelMap, travelAtlasEditorState)
  const mediaCatalog = deriveMediaCatalog(raw.mediaCatalog, travelAtlasEditorState)
  const droneMedia = deriveDroneMedia(mediaCatalog.importedDroneMediaCatalogItems)
  const wantToGo = deriveWantToGo(raw.wantToGo, travelAtlas)
  const worldGraph = deriveWorldGraph(travelAtlas, wantToGo.wantToGoItems, raw.now)

  return {
    travelAtlas: { travelAtlasDataSource: raw.travelAtlasDataSource, ...travelAtlas },
    editorState: { travelAtlasEditorState, orderBySavedIds },
    mediaCatalog: { getMediaSource, ...mediaCatalog },
    droneMedia,
    wantToGo: { wantToGoDataSource: raw.wantToGo.source, ...wantToGo },
    worldGraph: { worldGraphSessionNow: raw.now, ...worldGraph },
  }
}
