import { travelAtlasEditorState } from './editorState'
import { privateMediaCatalog } from 'virtual:starmap-private-data'
import { deriveMediaCatalog } from './derive/mediaCatalog.ts'

// 媒体目录的解析与派生在纯派生层 ./derive/mediaCatalog.ts（RFC-LOC-1 PR1）；
// 本文件只负责选出数据来源（虚拟模块）并以原名导出。
export type { ImportedMediaCatalogItem, ImportedMediaKind, ImportedMediaVariant } from './derive/mediaCatalog.ts'
export { getMediaSource } from './derive/mediaCatalog.ts'

const derived = deriveMediaCatalog(privateMediaCatalog, travelAtlasEditorState)

export const allImportedMediaItems = derived.allImportedMediaItems

export const importedMediaItems = derived.importedMediaItems

export const getCityPhotos = derived.getCityPhotos

export const getCityCoverPhoto = derived.getCityCoverPhoto

export const importedDroneMediaCatalogItems = derived.importedDroneMediaCatalogItems
