import { appData } from './appData'

// 媒体目录的派生在纯派生层 ./derive/mediaCatalog.ts（RFC-LOC-1 PR1）；数据来源的选择在 ./rawInputs.ts，
// 逐条校验与经 Canonical 重建在 ./appData.ts（PR2）；本文件以原名导出。
export type { ImportedMediaCatalogItem, ImportedMediaKind, ImportedMediaVariant } from './derive/mediaCatalog.ts'
export { getMediaSource } from './derive/mediaCatalog.ts'

const derived = appData.mediaCatalog

export const allImportedMediaItems = derived.allImportedMediaItems

export const importedMediaItems = derived.importedMediaItems

export const getCityPhotos = derived.getCityPhotos

export const getCityCoverPhoto = derived.getCityCoverPhoto

export const importedDroneMediaCatalogItems = derived.importedDroneMediaCatalogItems
