import { LocalEditorError } from '../i18n/editorErrors.ts'

declare const mediaImportPermitBrand: unique symbol
/** Identity-only capability, created and accepted by exactly one coordination instance. */
export type MediaImportPermit = { readonly [mediaImportPermitBrand]: true }
export type LocalEditorCoordinationSnapshot = { readonly target?: string; readonly writes: number }
export type LocalEditorCoordination = {
  beginMedia: (target: string) => MediaImportPermit
  releaseMedia: (permit: MediaImportPermit) => void
  withLocalEditorWrite: <T>(operation: () => Promise<T>, permit?: MediaImportPermit) => Promise<T>
  getSnapshot: () => LocalEditorCoordinationSnapshot
  subscribe: (listener: () => void) => () => void
  assertReloadAllowed: () => void
}

const busy = () => new LocalEditorError({ code: 'E_MEDIA_IMPORT_BUSY' })

/** One runtime boundary for the importer (which scans the whole Inbox) and all ordinary editor writes. */
export function createLocalEditorCoordination(): LocalEditorCoordination {
  let state: LocalEditorCoordinationSnapshot = Object.freeze({ writes: 0 })
  let mediaPermit: MediaImportPermit | undefined
  const listeners = new Set<() => void>()
  const publish = (next: LocalEditorCoordinationSnapshot) => {
    state = Object.freeze(next)
    for (const listener of listeners) listener()
  }
  return Object.freeze({
    beginMedia: (target: string) => {
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
  })
}

export const localEditorCoordination = createLocalEditorCoordination()
export const withLocalEditorWrite = localEditorCoordination.withLocalEditorWrite
export const getLocalEditorCoordinationSnapshot = localEditorCoordination.getSnapshot
export const subscribeLocalEditorCoordination = localEditorCoordination.subscribe
export const assertLocalEditorReloadAllowed = localEditorCoordination.assertReloadAllowed
