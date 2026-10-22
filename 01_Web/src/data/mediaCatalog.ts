import { useAppData } from './appStore.ts'

// 媒体目录的派生在纯派生层 ./derive/mediaCatalog.ts（RFC-LOC-1 PR1），数据经 ./appStore.ts 的快照。
// 3C-5 D: the data are no module constants any more: components read them through the hook below (./appStore.ts), so a
// save moves them on without a reload and react-hooks/exhaustive-deps sees every dependency on them. 
export type { ImportedMediaCatalogItem, ImportedMediaKind, ImportedMediaVariant } from './derive/mediaCatalog.ts'
export { getMediaSource } from './derive/mediaCatalog.ts'

/** allImportedMediaItems、importedMediaItems、getCityPhotos、getCityCoverPhoto、importedDroneMediaCatalogItems。 */
export const useMediaCatalog = () => useAppData().mediaCatalog
