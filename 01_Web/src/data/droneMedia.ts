import { useAppData } from './appStore.ts'

// 无人机媒体的派生在纯派生层 ./derive/droneMedia.ts（RFC-LOC-1 PR1），数据经 ./appStore.ts 的快照。
// 3C-5 D: the data are no module constants any more: components read them through the hook below (./appStore.ts), so a
// save moves them on without a reload and react-hooks/exhaustive-deps sees every dependency on them. 
export type { DroneMediaItem, DroneMediaType } from './derive/droneMedia.ts'

/** droneMediaItems、droneMediaByCity、getDroneMediaForCity、hasDroneMedia、droneMediaById。 */
export const useDroneMedia = () => useAppData().droneMedia
