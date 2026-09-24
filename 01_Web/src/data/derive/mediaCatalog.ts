/**
 * 媒体目录（user-media）的纯派生（RFC-LOC-1 PR1）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * 这里的逻辑原样搬自 `src/data/mediaCatalog.ts`；「读哪份数据」仍留在原文件。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { CityId, CountryId } from '../../types/travel.ts'
import { orderBySavedIds, type TravelAtlasEditorState } from './editorState.ts'

export type ImportedMediaKind = 'photo' | 'panorama360' | 'aerialPhoto' | 'video'

export type ImportedMediaVariant = {
  src: string
  width?: number
  height?: number
}

export type ImportedMediaCatalogItem = {
  id: string
  kind: ImportedMediaKind
  scope: 'city'
  countryId: CountryId
  countryName: string
  cityId: CityId
  cityName: string
  src: string
  width?: number
  height?: number
  variants?: {
    thumb?: ImportedMediaVariant
    preview?: ImportedMediaVariant
    original: ImportedMediaVariant
  }
  originalFileName: string
  titleZh?: string
  titleEn?: string
  date?: string
  resolution?: string
  captureType?: string
  description?: string
  altitudeMeters?: number
  relativeAltitudeMeters?: number
  position?: {
    lat: number
    lng: number
    altitudeMeters?: number
  }
  isCover: boolean
  status: 'ready' | 'needsMetadata'
}

type LocalMediaCatalog = {
  schemaVersion: number
  items: ImportedMediaCatalogItem[]
}

const isCatalog = (value: unknown): value is LocalMediaCatalog => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LocalMediaCatalog>
  return (candidate.schemaVersion === 1 || candidate.schemaVersion === 2) && Array.isArray(candidate.items)
}

export const getMediaSource = (
  item: ImportedMediaCatalogItem,
  variant: 'thumb' | 'preview' | 'original',
) => item.variants?.[variant]?.src ?? item.variants?.original.src ?? item.src

/**
 * 原始 catalog 值（私有文件内容，或不存在时的 undefined）+ 解析后的 editor-state
 * → `mediaCatalog.ts` 今天的全部派生导出（`getMediaSource` 是上面的纯函数，单独导出）。
 */
export const deriveMediaCatalog = (catalog: unknown, editorState: TravelAtlasEditorState) => {
  const allImportedMediaItems = isCatalog(catalog)
    ? catalog.items
    : []

  const hiddenMediaIds = new Set([
    ...editorState.hiddenMediaIds,
    ...editorState.hiddenDroneMediaIds,
  ])

  const importedMediaItems = allImportedMediaItems.filter((item) => !hiddenMediaIds.has(item.id))

  const getCityPhotos = (cityId?: CityId) =>
    cityId
      ? orderBySavedIds(
          importedMediaItems.filter((item) => item.kind === 'photo' && item.cityId === cityId && item.status === 'ready'),
          editorState.mediaOrderByCity[cityId],
        )
      : []

  const getCityCoverPhoto = (cityId?: CityId) => {
    const cityPhotos = getCityPhotos(cityId)
    const savedCoverId = cityId ? editorState.coverMediaByCity[cityId] : undefined
    return cityPhotos.find((item) => item.id === savedCoverId)
      ?? cityPhotos.find((item) => item.isCover)
      ?? cityPhotos[0]
  }

  const importedDroneMediaCatalogItems = Object.entries(
    importedMediaItems.filter(
      (item) => (
      (item.kind === 'panorama360' || item.kind === 'aerialPhoto')
      && item.status === 'ready'
      && Boolean(item.cityId)
      && Boolean(item.date)
      && Boolean(item.resolution)
      ),
    ).reduce((byCity, item) => {
      byCity[item.cityId] = [...(byCity[item.cityId] ?? []), item]
      return byCity
    }, {} as Record<CityId, ImportedMediaCatalogItem[]>),
  ).flatMap(([cityId, items]) => orderBySavedIds(items, editorState.droneOrderByCity[cityId]))

  return {
    allImportedMediaItems,
    importedMediaItems,
    getCityPhotos,
    getCityCoverPhoto,
    importedDroneMediaCatalogItems,
  }
}

export type MediaCatalogDerived = ReturnType<typeof deriveMediaCatalog>
