/**
 * 3C-5 F: opening the re-read and re-import dialogs. The entries only send an open request (a window event); the
 * dialogs, which App loads on demand in the local personal editor, answer it (as ./mediaRecoveryUi.ts does for the
 * media task center), so the cards do not pull the dialogs in statically. Pure apart from the events.
 */
import type { MediaRereadScope } from './mediaMaintenance.ts'

export const MEDIA_REREAD_OPEN_EVENT = 'starmap:open-media-reread'
export const MEDIA_REIMPORT_OPEN_EVENT = 'starmap:open-media-reimport'

/** A re-read of one item or of a city's items; `name` titles the dialog (the city, or the item's file). */
export interface MediaRereadRequest {
  readonly scope: MediaRereadScope
  readonly name: string
}

/** The files to re-import, listed for one city (`cityId`); `name` titles the dialog. */
export interface MediaReimportRequest {
  readonly cityId: string
  readonly name: string
}

export function requestMediaReread(detail: MediaRereadRequest) {
  window.dispatchEvent(new CustomEvent(MEDIA_REREAD_OPEN_EVENT, { detail }))
}

export function requestMediaReimport(detail: MediaReimportRequest) {
  window.dispatchEvent(new CustomEvent(MEDIA_REIMPORT_OPEN_EVENT, { detail }))
}

export type MediaMaintenanceBlock = 'readOnly' | 'migration' | 'recovery' | 'mediaTask' | 'otherWriting'

/**
 * Why re-reading and re-importing cannot start now, as the other writes refuse: a read-only (damaged) library, data
 * waiting for migration (the legacy format too) or recovery, an unfinished media task (or its state not known yet), or
 * another page writing. Undefined when they can.
 */
export function mediaMaintenanceBlockOf(state: {
  readonly storeReadOnly: boolean
  readonly storeMigrationRequired: boolean
  readonly legacyUnmigrated: boolean
  readonly storeRecoveryRequired: boolean
  readonly mediaTaskOpen: boolean
  readonly otherWriting: boolean
}): MediaMaintenanceBlock | undefined {
  if (state.storeReadOnly) return 'readOnly'
  if (state.storeMigrationRequired || state.legacyUnmigrated) return 'migration'
  if (state.storeRecoveryRequired) return 'recovery'
  if (state.mediaTaskOpen) return 'mediaTask'
  if (state.otherWriting) return 'otherWriting'
  return undefined
}
