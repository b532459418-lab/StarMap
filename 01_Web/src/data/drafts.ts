/**
 * Drafts without page reloads (3C-5 sub-batch D, design §1 and §2; external review §5-4; the author's decisions of
 * 2026-10-22).
 *
 * A save no longer reloads the page, so an editor's draft lives as long as its editor is open, while the data on the
 * page move on (this page's saves, pushes from other pages and from other processes). `useDraft(probe)` keeps what a
 * draft needs for that:
 * - `begin()` starts a draft: it remembers the revision of the data on the page (the draft's writes are sent with it,
 *   `writeOptions()`, not with the page's later revision) and `probe(snapshot)`, what the draft concerns as the page
 *   shows it then (./draftProbes.ts: the whole record, or the part of a list its editor shows). `end()` drops it.
 * - The draft's values stay the component's; new data never overwrite them. When the data the draft concerns change
 *   (another tab, a command-line import), the draft's `status` turns `changed` (or `deleted` when the record is gone)
 *   and the editor shows the conflict (../components/DraftConflictNotice.tsx) and holds the save until the user chooses:
 *   `keepMine()` takes the new data as the draft's base (the save then writes the draft's own fields over them, nothing
 *   else), or the component starts its draft again from the new data (`begin()`), or drops it (`end()`).
 * - A save that meets E_STALE fetches the changes first; `writeOptions().changedMeanwhile` then says whether the draft's
 *   record changed meanwhile (no retry: E_DRAFT_CONFLICT, the editor shows the conflict) or not (sent again on the new
 *   revision; ./localEditorApi.ts).
 *
 * Constraint: browser only (it reads the page's data store).
 */
import { useCallback, useMemo, useState } from 'react'
import { appStore, useAppSnapshot } from './appStore.ts'
import type { AppSnapshot } from './appStoreCore.ts'
import type { EditorWriteOptions } from './localEditorApi.ts'

/** What a draft concerns, as the page's data show it (plain values, compared as JSON; undefined: the record is gone). */
export type DraftProbe<V> = (snapshot: AppSnapshot) => V

export type DraftStatus = 'editing' | 'changed' | 'deleted'

export interface Draft<V> {
  /** A draft is open. */
  readonly active: boolean
  /** The revision of the data the draft is based on. */
  readonly baseRevision?: number
  /** What the draft concerns, when it started (or when the user last kept their changes). */
  readonly baseValue?: V
  /** What the draft concerns in the data on the page now. */
  readonly current?: V
  /** `editing`, or `changed` / `deleted` when the data the draft concerns changed meanwhile; undefined without a draft. */
  readonly status?: DraftStatus
  begin(): void
  end(): void
  /** Keep the draft: the data on the page now become its base (its save writes its own fields over them). */
  keepMine(): void
  /** The options of the draft's writes: its base revision, and whether its record changed meanwhile. */
  writeOptions(): EditorWriteOptions
}

interface DraftState<V> {
  readonly baseRevision: number
  readonly baseValue: V
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** `open`: the draft starts with the component (a dialog that is itself the draft). */
export function useDraft<V>(probe: DraftProbe<V>, { open = false }: { readonly open?: boolean } = {}): Draft<V> {
  // Subscribed, so the component renders again (and the status is checked) when the data move on.
  const snapshot = useAppSnapshot()
  const [state, setState] = useState<DraftState<V> | undefined>(() => (open ? { baseRevision: snapshot.revision, baseValue: probe(snapshot) } : undefined))
  const start = useCallback(() => {
    const now = appStore.getSnapshot()
    setState({ baseRevision: now.revision, baseValue: probe(now) })
  }, [probe])
  const end = useCallback(() => setState(undefined), [])
  const current = useMemo(() => (state ? probe(snapshot) : undefined), [state, probe, snapshot])
  const status: DraftStatus | undefined = !state ? undefined
    : current === undefined && state.baseValue !== undefined ? 'deleted'
      : sameValue(current, state.baseValue) ? 'editing' : 'changed'
  return {
    active: state !== undefined,
    ...(state ? { baseRevision: state.baseRevision, baseValue: state.baseValue, current, status } : {}),
    begin: start,
    end,
    keepMine: start,
    writeOptions: () => (state
      ? { baseRevision: state.baseRevision, changedMeanwhile: () => !sameValue(probe(appStore.getSnapshot()), state.baseValue) }
      : {}),
  }
}
