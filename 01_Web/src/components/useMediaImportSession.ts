import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { MediaImportPermit } from '../data/localEditorCoordination.ts'
import { useLocalEditorCoordination } from './useLocalEditorCoordination'
import {
  EMPTY_MEDIA_IMPORT_SESSION_STATE,
  getMediaImportSession,
  MediaImportSessionGuardError,
  type MediaImportSession,
} from '../data/mediaImportSession.ts'

const disabledSnapshot = () => EMPTY_MEDIA_IMPORT_SESSION_STATE
const disabledSubscribe = () => () => {}

export function useMediaImportSession(target?: string) {
  const coordination = useLocalEditorCoordination(target)
  const session = useMemo(() => target === undefined ? undefined : getMediaImportSession(target), [target])
  const activeSession = useRef<{ session: MediaImportSession<File> | undefined } | undefined>(undefined)
  useLayoutEffect(() => {
    activeSession.current = { session }
    return () => { activeSession.current = undefined }
  }, [session])
  const state = useSyncExternalStore(session?.subscribe ?? disabledSubscribe, session?.getSnapshot ?? disabledSnapshot, disabledSnapshot)

  const upload = useCallback(async (files: readonly File[], uploadFn: (file: File, permit?: MediaImportPermit) => Promise<{ sourcePath: string }>) => {
    const activation = activeSession.current
    if (!session || activation?.session !== session) throw new MediaImportSessionGuardError()
    await session.upload(files, uploadFn)
    if (activeSession.current !== activation) throw new MediaImportSessionGuardError()
  }, [session])
  const importMedia = useCallback(async (importFn: (sourcePaths: string[], permit?: MediaImportPermit) => Promise<unknown>) => {
    const activation = activeSession.current
    if (!session || activation?.session !== session) throw new MediaImportSessionGuardError()
    await session.importMedia(importFn)
    if (activeSession.current !== activation) throw new MediaImportSessionGuardError()
  }, [session])
  return { state, upload, importMedia, ...coordination }
}
