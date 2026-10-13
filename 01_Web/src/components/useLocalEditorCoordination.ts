import { useSyncExternalStore } from 'react'
import {
  getLocalEditorCoordinationSnapshot,
  subscribeLocalEditorCoordination,
} from '../data/localEditorCoordination.ts'

const emptySnapshot = Object.freeze({ target: undefined, writes: 0 })
const serverSnapshot = () => emptySnapshot

/**
 * Observe the shared editor lease without changing it or issuing a request. `reloadRequired` is the page-wide state set
 * after a write with an unconfirmed result: every write on the page is refused until a reload.
 */
export function useLocalEditorCoordination(target?: string) {
  const snapshot = useSyncExternalStore(
    subscribeLocalEditorCoordination,
    getLocalEditorCoordinationSnapshot,
    serverSnapshot,
  )
  const otherPending = snapshot.target !== undefined && snapshot.target !== target
  const otherWriting = snapshot.writes > 0
  return {
    blocked: otherPending || otherWriting,
    mediaPending: snapshot.target !== undefined,
    otherPending,
    otherWriting,
    reloadRequired: snapshot.reloadRequired === true,
  }
}
