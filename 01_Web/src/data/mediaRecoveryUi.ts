export const MEDIA_RECOVERY_OPEN_EVENT = 'starmap:open-media-recovery'

/** Carries a display hint only. Task facts always come from the local server. */
export function requestMediaRecovery(jobId?: string) {
  window.dispatchEvent(new CustomEvent(MEDIA_RECOVERY_OPEN_EVENT, { detail: { jobId } }))
}
