/**
 * 无人机媒体的纯派生（RFC-LOC-1 PR1）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * 这里的逻辑原样搬自 `src/data/droneMedia.ts`。输入是媒体目录派生出的
 * `importedDroneMediaCatalogItems`（见 `./mediaCatalog.ts`）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { CityId } from '../../types/travel.ts'
import { getMediaSource, type ImportedMediaCatalogItem } from './mediaCatalog.ts'

export type DroneMediaType = 'panorama360' | 'aerialPhoto'

export type DroneMediaItem = {
  id: string
  cityId: CityId
  type: DroneMediaType
  titleZh: string
  titleEn: string
  src: string
  previewSrc: string
  thumbSrc: string
  date: string
  resolution: string
  captureType: string
  fileName: string
  city: string
  country: string
  description?: string
  altitudeMeters?: number
  relativeAltitudeMeters?: number
  position?: {
    lat: number
    lng: number
    altitudeMeters?: number
  }
}

/** `importedDroneMediaCatalogItems` → `droneMedia.ts` 今天的全部导出。 */
export const deriveDroneMedia = (importedDroneMediaCatalogItems: ImportedMediaCatalogItem[]) => {
  const importedDroneMediaItems: DroneMediaItem[] = importedDroneMediaCatalogItems.flatMap((item) => {
    if (
      (item.kind !== 'panorama360' && item.kind !== 'aerialPhoto')
      || !item.cityId
      || !item.date
      || !item.resolution
    ) return []

    return [{
      id: item.id,
      cityId: item.cityId,
      type: item.kind,
      titleZh: item.titleZh ?? item.titleEn ?? item.cityName ?? '无人机影像',
      titleEn: item.titleEn ?? item.titleZh ?? item.cityName ?? 'Drone Media',
      src: getMediaSource(item, 'original'),
      previewSrc: getMediaSource(item, 'preview'),
      thumbSrc: getMediaSource(item, 'thumb'),
      date: item.date,
      resolution: item.resolution,
      captureType: item.captureType ?? (item.kind === 'panorama360' ? 'Drone 360 Panorama' : 'Aerial Photo'),
      fileName: item.originalFileName,
      city: item.cityName ?? item.cityId,
      country: item.countryName,
      description: item.description,
      altitudeMeters: item.altitudeMeters ?? item.position?.altitudeMeters,
      relativeAltitudeMeters: item.relativeAltitudeMeters,
      position: item.position,
    }]
  })

  const droneMediaItems: DroneMediaItem[] = importedDroneMediaItems

  const droneMediaByCity = droneMediaItems.reduce(
    (acc, item) => {
      acc[item.cityId] = [...(acc[item.cityId] ?? []), item]
      return acc
    },
    {} as Partial<Record<CityId, DroneMediaItem[]>>,
  )

  const getDroneMediaForCity = (cityId?: CityId) =>
    cityId ? droneMediaByCity[cityId] ?? [] : []

  const hasDroneMedia = (cityId?: CityId) =>
    getDroneMediaForCity(cityId).length > 0

  const droneMediaById = droneMediaItems.reduce(
    (acc, item) => {
      acc[item.id] = item
      return acc
    },
    {} as Record<string, DroneMediaItem>,
  )

  return {
    droneMediaItems,
    droneMediaByCity,
    getDroneMediaForCity,
    hasDroneMedia,
    droneMediaById,
  }
}

export type DroneMediaDerived = ReturnType<typeof deriveDroneMedia>
