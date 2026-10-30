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
 *
 * 性能续 P5 (the author's decision of 2026-10-23): an editor that tells its own values (`local`, plain data, and the
 * values it started from, `begin(localAtStart)`) follows new data when it has no local edits: instead of `changed`, the
 * hook calls `onFollow` in a layout effect (the editor starts its draft again from the new data; nothing is shown in
 * between) and reports `editing`. With local edits the conflict is shown as before; a record gone is `deleted` as before
 * (./draftStatus.ts). An editor that does not tell its values is judged as before.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { appStore, useAppSelector } from './appStore.ts'
import type { AppSnapshot } from './appStoreCore.ts'
import { draftStatusOf, sameDraftValue } from './draftStatus.ts'
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
  /** Start the draft from the data on the page now; `localAtStart`: the editor's own values it starts with (P5). */
  begin(localAtStart?: unknown): void
  end(): void
  /** Keep the draft: the data on the page now become its base (its save writes its own fields over them). */
  keepMine(): void
  /** The options of the draft's writes: its base revision, and whether its record changed meanwhile. */
  writeOptions(): EditorWriteOptions
}

interface DraftState<V> {
  readonly baseRevision: number
  readonly baseValue: V
  readonly localAtStart?: unknown
}

export interface DraftOptions {
  /** The draft starts with the component (a dialog that is itself the draft). */
  readonly open?: boolean
  /** 性能续 P5: the editor's own values now (plain data); with `open`, its first values are where the draft starts. */
  readonly local?: unknown
  /** 性能续 P5: the data changed and the editor has no local edits: start the draft again from the new data. */
  readonly onFollow?: () => void
}

/**
 * 3C-5 D (review F): the end of a save, run once: it is passed as the write's `onApplied` (so it renders with the
 * saved data) and called again when the write resolves (for a write that applied nothing on the page).
 */
export function once(end: () => void): () => void {
  let ended = false
  return () => {
    if (ended) return
    ended = true
    end()
  }
}

/** The selected JSON when the record is gone (JSON.stringify(undefined) is undefined), and without a draft. */
const GONE = 'starmap:draft:gone'
const NO_DRAFT = 'starmap:draft:none'

export function useDraft<V>(probe: DraftProbe<V>, { open = false, local, onFollow }: DraftOptions = {}): Draft<V> {
  const [state, setState] = useState<DraftState<V> | undefined>(() => {
    if (!open) return undefined
    const now = appStore.getSnapshot()
    return { baseRevision: now.revision, baseValue: probe(now), localAtStart: local }
  })
  // Subscribed only while a draft is open, and only to what it concerns (as JSON): an editor without a draft does not
  // render again when the data move on, and one with a draft only when its record changes.
  const selectCurrent = useCallback((snapshot: AppSnapshot) => (state ? JSON.stringify(probe(snapshot)) ?? GONE : NO_DRAFT), [state, probe])
  const currentJson = useAppSelector(selectCurrent)
  const start = useCallback((localAtStart?: unknown) => {
    const now = appStore.getSnapshot()
    setState({ baseRevision: now.revision, baseValue: probe(now), localAtStart })
  }, [probe])
  const keep = useCallback(() => {
    const now = appStore.getSnapshot()
    setState((last) => ({ baseRevision: now.revision, baseValue: probe(now), localAtStart: last?.localAtStart }))
  }, [probe])
  const end = useCallback(() => setState(undefined), [])
  const current = useMemo(() => (currentJson === GONE || currentJson === NO_DRAFT ? undefined : JSON.parse(currentJson) as V), [currentJson])
  const judgement = !state ? undefined : draftStatusOf({ base: state.baseValue, current, localAtStart: state.localAtStart, local })
  // P5: following, the editor starts again from the new data before the browser paints (no notice in between).
  const following = judgement === 'follow'
  const onFollowRef = useRef(onFollow)
  useLayoutEffect(() => { onFollowRef.current = onFollow })
  useLayoutEffect(() => {
    if (!following) return
    if (onFollowRef.current) onFollowRef.current()
    else keep()
  }, [following, currentJson, keep])
  const status: DraftStatus | undefined = judgement === undefined ? undefined : judgement === 'follow' ? 'editing' : judgement
  return {
    active: state !== undefined,
    ...(state ? { baseRevision: state.baseRevision, baseValue: state.baseValue, current, status } : {}),
    begin: start,
    end,
    keepMine: keep,
    writeOptions: () => (state
      ? { baseRevision: state.baseRevision, changedMeanwhile: () => !sameDraftValue(probe(appStore.getSnapshot()), state.baseValue) }
      : {}),
  }
}
