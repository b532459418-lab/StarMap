import { appData } from './appData'
import { type DroneMediaItem } from './derive/droneMedia.ts'

// 无人机媒体的派生在纯派生层 ./derive/droneMedia.ts（RFC-LOC-1 PR1），经 ./appData.ts（PR2）计算；本文件以原名导出。
export type { DroneMediaItem, DroneMediaType } from './derive/droneMedia.ts'

const derived = appData.droneMedia

export const droneMediaItems: DroneMediaItem[] = derived.droneMediaItems

export const droneMediaByCity = derived.droneMediaByCity

export const getDroneMediaForCity = derived.getDroneMediaForCity

export const hasDroneMedia = derived.hasDroneMedia

export const droneMediaById = derived.droneMediaById
