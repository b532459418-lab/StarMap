import { useSyncExternalStore } from 'react'
import { mediaJobs } from '../data/mediaJobs.ts'

/** Observe the same server-backed task queue from every panel. Observation does not write. */
export function useMediaJobs() {
  const state = useSyncExternalStore(mediaJobs.subscribe, mediaJobs.getSnapshot, mediaJobs.getSnapshot)
  return {...state, currentPreview: state.preview, refresh: mediaJobs.refresh, uploadBatch: mediaJobs.uploadBatch,
    receiveMissing: mediaJobs.receiveMissing, preview: mediaJobs.preview, importJob: mediaJobs.importJob,
    pause: mediaJobs.pause, close: mediaJobs.close}
}
