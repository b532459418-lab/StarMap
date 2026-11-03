/**
 * The status of an editor's draft (3C-5 D drafts, ./drafts.ts; 性能续 P5, the author's decision of 2026-10-23: a draft
 * without local edits follows the new data without a notice; one with local edits shows the conflict as before).
 *
 * - `editing`: the data the draft concerns are what they were when it started (or was last kept).
 * - `deleted`: the record is gone. Shown whether or not the draft has local edits (the author decided only about data
 *   that changed while nothing was edited).
 * - `changed`: the data changed elsewhere and the draft has local edits: the editor shows the conflict.
 * - `follow`: the data changed elsewhere and the draft has no local edits: the editor starts its draft again from the
 *   new data, without a notice.
 *
 * "No local edits" is the editor's own values now, field by field, equal to what they were when the draft started (as
 * JSON, as the probes are compared): not whether an editor is open. Moving a row and back is no edit; a new cover is.
 * Without local values (`local` undefined) a draft is judged as before: any change elsewhere is `changed`.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, no DOM, no React).
 */
export type DraftJudgement = 'editing' | 'changed' | 'deleted' | 'follow'

export const sameDraftValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function draftStatusOf({ base, current, localAtStart, local }: {
  /** What the draft concerns when it started (or was last kept); undefined only for a record that was gone then. */
  readonly base: unknown
  /** What it concerns in the data now (undefined: the record is gone). */
  readonly current: unknown
  /** The editor's own values when the draft started, and now (both undefined: the editor does not tell). */
  readonly localAtStart?: unknown
  readonly local?: unknown
}): DraftJudgement {
  if (current === undefined && base !== undefined) return 'deleted'
  if (sameDraftValue(current, base)) return 'editing'
  if (local === undefined) return 'changed'
  return sameDraftValue(local, localAtStart) ? 'follow' : 'changed'
}
