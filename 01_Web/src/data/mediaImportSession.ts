import { LocalEditorError } from '../i18n/editorErrors.ts'

export type MediaImportSessionState = {
  readonly phase: 'idle' | 'uploading' | 'pending' | 'importing' | 'uncertain'
  readonly sourcePaths: readonly string[]
  readonly selectedCount: number
  readonly error?: unknown
}

export type MediaImportSession<T = File> = {
  getSnapshot: () => MediaImportSessionState
  subscribe: (listener: () => void) => () => void
  upload: (files: readonly T[], uploadFn: (file: T) => Promise<{ sourcePath: string }>) => Promise<void>
  importMedia: (importFn: (sourcePaths: string[]) => Promise<unknown>) => Promise<void>
}

export class MediaImportSessionGuardError extends Error {
  constructor() {
    super('Media import session is not available for this action.')
    this.name = 'MediaImportSessionGuardError'
  }
}

export const EMPTY_MEDIA_IMPORT_SESSION_STATE: MediaImportSessionState = Object.freeze({
  phase: 'idle', sourcePaths: Object.freeze([]), selectedCount: 0,
})

const safeUploadCodes = new Set([
  'E_MEDIA_NAME_INVALID', 'E_MEDIA_NAME_EXHAUSTED', 'E_MEDIA_UPLOAD_EMPTY',
  'E_MEDIA_UPLOAD_TOO_LARGE', 'E_MEDIA_IMAGE_INVALID', 'E_MEDIA_PANORAMA_RATIO',
  'E_MEDIA_KIND_INVALID', 'E_MEDIA_LOCATION_NOT_FOUND', 'E_MEDIA_EXTENSION',
  'E_MEDIA_DRONE_DATE', 'E_MEDIA_COORDINATES_RANGE', 'E_MEDIA_FOLDER_CONFLICT',
  'E_COORDINATES_PAIR', 'E_EDITOR_WRITE_FORBIDDEN', 'E_LEGACY_UNMIGRATED', 'E_INTEGRITY',
])

const safeImportCodes = new Set([
  'E_MEDIA_IMPORT_BLOCKED', 'E_MEDIA_IMPORT_FAILED', 'E_MEDIA_IMPORT_PATH_INVALID',
  'E_REQUIRED', 'E_NUMBER_INVALID', 'E_INTEGRITY', 'E_UNKNOWN_PLACE_REF',
  'E_LEGACY_UNMIGRATED', 'E_EDITOR_WRITE_FORBIDDEN', 'E_REQUEST_INVALID',
  'E_REQUEST_TOO_LARGE', 'E_UNKNOWN_ENDPOINT',
])

const isSafeUploadFailure = (error: unknown) => error instanceof LocalEditorError
  && error.code !== undefined && safeUploadCodes.has(error.code)

const isSafeImportFailure = (error: unknown) => {
  if (!(error instanceof LocalEditorError) || !error.code) return false
  if (error.code === 'E_WRITE_FAILED') return Array.isArray(error.params.written) && error.params.written.length === 0
  return safeImportCodes.has(error.code)
}

/** No file bytes or persistent storage: retain only confirmed paths and the original failure. */
export function createMediaImportSession<T = File>(): MediaImportSession<T> {
  let state = EMPTY_MEDIA_IMPORT_SESSION_STATE
  const listeners = new Set<() => void>()
  const publish = (next: MediaImportSessionState) => {
    state = Object.freeze({ ...next, sourcePaths: Object.freeze([...next.sourcePaths]) })
    for (const listener of listeners) listener()
  }

  return Object.freeze({
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    upload: async (files: readonly T[], uploadFn: (file: T) => Promise<{ sourcePath: string }>) => {
      if (state.phase !== 'idle') throw new MediaImportSessionGuardError()
      const selected = [...files]
      if (!selected.length) throw new MediaImportSessionGuardError()
      publish({ phase: 'uploading', sourcePaths: [], selectedCount: selected.length })
      try {
        for (const file of selected) {
          const uploaded = await uploadFn(file)
          if (typeof uploaded?.sourcePath !== 'string' || !uploaded.sourcePath.trim()) {
            throw new LocalEditorError({ code: 'E_MEDIA_UPLOAD_RESULT_UNKNOWN' })
          }
          publish({ phase: 'uploading', sourcePaths: [...state.sourcePaths, uploaded.sourcePath], selectedCount: selected.length })
        }
        publish({ ...state, phase: 'pending' })
      } catch (error) {
        const phase = isSafeUploadFailure(error) ? (state.sourcePaths.length ? 'pending' : 'idle') : 'uncertain'
        publish({ ...state, phase, error })
        throw error
      }
    },
    importMedia: async (importFn: (sourcePaths: string[]) => Promise<unknown>) => {
      if (state.phase !== 'pending' || !state.sourcePaths.length) throw new MediaImportSessionGuardError()
      publish({ phase: 'importing', sourcePaths: state.sourcePaths, selectedCount: state.selectedCount })
      try {
        await importFn([...state.sourcePaths])
        publish(EMPTY_MEDIA_IMPORT_SESSION_STATE)
      } catch (error) {
        publish({ ...state, phase: isSafeImportFailure(error) ? 'pending' : 'uncertain', error })
        throw error
      }
    },
  })
}

// Pending paths survive remounts in this page lifetime only; nothing persists across a page reload.
const sessions = new Map<string, MediaImportSession<File>>()
export function getMediaImportSession(target: string): MediaImportSession<File> {
  let session = sessions.get(target)
  if (!session) {
    session = createMediaImportSession<File>()
    sessions.set(target, session)
  }
  return session
}
