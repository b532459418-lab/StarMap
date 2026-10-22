/**
 * Drafts without page reloads (3C-5 sub-batch D, design §1 and §2; external review §5-4).
 *
 * A save no longer reloads the page, so an editor's draft lives as long as its editor is open, while the data on the
 * page move on (this page's saves, pushes from other pages and from other processes). `useDraft(probe)` keeps what a
 * draft needs for that:
 * - `begin()` starts a draft: it remembers the revision of the data on the page (the draft's writes are sent with it,
 *   `writeOptions()`, not with the page's later revision) and `probe(snapshot)`, what the draft concerns as the page
 *   shows it then (a record's fields, or the part of a list the editor shows). `end()` drops it.
 * - While a draft is open, the data the editor shows still come from the draft; the component starts its draft values
 *   from the data at `begin` and renders the data themselves when no draft is open.
 *
 * Constraint: browser only (it reads the page's data store).
 */
import { useCallback, useState } from 'react'
import { appStore, useAppSnapshot } from './appStore.ts'
import type { AppSnapshot } from './appStoreCore.ts'
import type { EditorWriteOptions } from './localEditorApi.ts'

/** What a draft concerns, as the page's data show it (plain values, compared as JSON). */
export type DraftProbe<V> = (snapshot: AppSnapshot) => V

export interface Draft<V> {
  /** A draft is open. */
  readonly active: boolean
  /** The revision of the data the draft started from. */
  readonly baseRevision?: number
  /** What the draft concerns, when it started. */
  readonly baseValue?: V
  begin(): void
  end(): void
  /** The options of the draft's writes: its own base revision. */
  writeOptions(): EditorWriteOptions
}

interface DraftState<V> {
  readonly baseRevision: number
  readonly baseValue: V
}

export function useDraft<V>(probe: DraftProbe<V>): Draft<V> {
  // Subscribed, so the component renders again when the data move on.
  useAppSnapshot()
  const [state, setState] = useState<DraftState<V>>()
  const begin = useCallback(() => {
    const snapshot = appStore.getSnapshot()
    setState({ baseRevision: snapshot.revision, baseValue: probe(snapshot) })
  }, [probe])
  const end = useCallback(() => setState(undefined), [])
  return {
    active: state !== undefined,
    ...(state ? { baseRevision: state.baseRevision, baseValue: state.baseValue } : {}),
    begin,
    end,
    writeOptions: () => (state ? { baseRevision: state.baseRevision } : {}),
  }
}
