import { LocalEditorError } from '../i18n/editorErrors.ts'

declare const mediaImportPermitBrand: unique symbol
/** Identity-only capability, created and accepted by exactly one coordination instance. */
export type MediaImportPermit = { readonly [mediaImportPermitBrand]: true }
export type LocalEditorCoordinationSnapshot = { readonly target?: string; readonly writes: number; readonly reloadRequired?: true }
export type LocalEditorCoordination = {
  beginMedia: (target: string) => MediaImportPermit
  releaseMedia: (permit: MediaImportPermit) => void
  withLocalEditorWrite: <T>(operation: () => Promise<T>, permit?: MediaImportPermit) => Promise<T>
  getSnapshot: () => LocalEditorCoordinationSnapshot
  subscribe: (listener: () => void) => () => void
  assertReloadAllowed: () => void
  requireReload: () => void
}

const busy = () => new LocalEditorError({ code: 'E_MEDIA_IMPORT_BUSY' })
const reloadRequiredError = () => new LocalEditorError({ code: 'E_EDITOR_RELOAD_REQUIRED' })

/**
 * One runtime boundary for the importer (which scans the whole Inbox) and all ordinary editor writes.
 *
 * `requireReload` records, for the whole page, that a write ended with an unconfirmed result. From then on every write
 * and every media session is refused before any request, whichever component starts it, until the page reloads; a
 * reload is the only thing that clears it (a new page builds a new coordination).
 */
export function createLocalEditorCoordination(): LocalEditorCoordination {
  let state: LocalEditorCoordinationSnapshot = Object.freeze({ writes: 0 })
  let mediaPermit: MediaImportPermit | undefined
  let reloadRequired = false
  const listeners = new Set<() => void>()
  const publish = (next: { target?: string; writes: number }) => {
    state = Object.freeze(reloadRequired ? { ...next, reloadRequired: true as const } : next)
    for (const listener of listeners) listener()
  }
  return Object.freeze({
    beginMedia: (target: string) => {
      if (reloadRequired) throw reloadRequiredError()
      if (mediaPermit || state.writes > 0) throw busy()
      mediaPermit = Object.freeze({}) as MediaImportPermit
      publish({ target, writes: 0 })
      return mediaPermit
    },
    releaseMedia: (permit: MediaImportPermit) => {
      if (!mediaPermit || permit !== mediaPermit) throw busy()
      mediaPermit = undefined
      publish({ writes: state.writes })
    },
    withLocalEditorWrite: async <T>(operation: () => Promise<T>, permit?: MediaImportPermit): Promise<T> => {
      if (reloadRequired) throw reloadRequiredError()
      if (permit !== undefined && permit !== mediaPermit) throw busy()
      if (mediaPermit) {
        if (permit !== mediaPermit) throw busy()
        return operation()
      }
      publish({ writes: state.writes + 1 })
      try {
        return await operation()
      } finally {
        publish({ writes: state.writes - 1 })
      }
    },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    assertReloadAllowed: () => {
      if (mediaPermit || state.writes > 0) throw busy()
    },
    requireReload: () => {
      if (reloadRequired) return
      reloadRequired = true
      publish({ ...state })
    },
  })
}

export const localEditorCoordination = createLocalEditorCoordination()
export const withLocalEditorWrite = localEditorCoordination.withLocalEditorWrite
export const getLocalEditorCoordinationSnapshot = localEditorCoordination.getSnapshot
export const subscribeLocalEditorCoordination = localEditorCoordination.subscribe
export const assertLocalEditorReloadAllowed = localEditorCoordination.assertReloadAllowed
export const requireLocalEditorReload = localEditorCoordination.requireReload

/**
 * Reloads the page after a confirmed save, unless another write or a media session is still running.
 * It lives here rather than in ./localEditorApi.ts (which re-exports it) so components can call it synchronously
 * without loading the editor API (batch 5B).
 */
export const reloadAfterLocalSave = () => {
  assertLocalEditorReloadAllowed()
  window.location.reload()
}
