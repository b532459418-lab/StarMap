/**
 * 3C-5 F: what the page knows of re-reading descriptions and re-importing (the answers of the local editor's media
 * endpoints, ../../scripts/store-media-endpoints.mjs): their shapes and the checks the API applies to every answer. A
 * preview carries a `planDigest`; the write hands it back with the same scope or path, and the server refuses it when
 * anything changed since (E_MEDIA_PREVIEW_STALE). Pure and without browser dependencies (unit tests import it).
 */

/** One media item (its media id) or a city's media (the city's place id). */
export type MediaRereadScope = { readonly mediaId: string } | { readonly cityId: string }

/** One field a re-read changes: the value in the app now (`from`, edits made in the app included) and the Inbox's (`to`); null when absent. */
export interface MediaRereadChange {
  readonly field: string
  readonly from: unknown
  readonly to: unknown
}

export interface MediaRereadRecord {
  readonly mediaId: string
  /** The city the item is on now. */
  readonly cityId: string | null
  readonly changes: readonly MediaRereadChange[]
  readonly sources: readonly { readonly path: string; readonly sha256: string; readonly descriptionDigest: string }[]
}

export type MediaRereadProblemReason = 'missing' | 'content-changed' | 'unreadable'

export interface MediaRereadPreview {
  readonly libraryId: string
  readonly revision: number
  readonly planDigest: string
  readonly scope: MediaRereadScope
  /** The items with changes (each written when confirmed). */
  readonly records: readonly MediaRereadRecord[]
  /** Items without a field change (counted only); `registryOnly` of them have a registered description to update. */
  readonly unchanged: number
  readonly registryOnly: number
  /** Items with no source in the Inbox: nothing to read. */
  readonly withoutSource: number
  /** Items whose sources describe them differently: not written. */
  readonly conflicts: readonly { readonly mediaId: string; readonly sources: readonly { readonly path: string; readonly descriptionDigest: string }[] }[]
  /** Sources gone, changed or unreadable: not written. */
  readonly problems: readonly { readonly mediaId: string; readonly path: string; readonly reason: MediaRereadProblemReason; readonly detail: string }[]
}

export interface MediaRereadResult {
  readonly revision: number
  readonly updatedMediaIds: readonly string[]
  readonly duplicate: boolean
}

export type MediaReimportReason = 'same-path' | 'new-path'

export interface MediaReimportCandidate {
  /** Inbox-relative. */
  readonly path: string
  /** The place of its folder (null when the folder resolves to none). */
  readonly cityId: string | null
  readonly kind: string
  readonly bytes: number
  readonly sha256: string
  readonly reason: MediaReimportReason
  /** A deletion of this file still waits (a backup copied media): re-importing it keeps the file. */
  readonly pendingDeletion: boolean
}

export interface MediaReimportCandidates {
  readonly libraryId: string
  readonly revision: number
  readonly scannedFiles: number
  readonly hashedFiles: number
  readonly candidates: readonly MediaReimportCandidate[]
  /** Candidates of other cities (when the list is of one city). */
  readonly otherCities: number
}

export interface MediaReimportPreview {
  readonly libraryId: string
  readonly revision: number
  readonly planDigest: string
  readonly file: { readonly path: string; readonly sha256: string; readonly bytes: number; readonly reason: MediaReimportReason; readonly pendingDeletion: boolean }
  /** The record it becomes (null when it would create none). */
  readonly record: { readonly cityId: string | null; readonly kind: string; readonly title: unknown; readonly date: string | null; readonly reusesFiles: boolean; readonly orderPosition: 'end' } | null
  /** New files elsewhere in the Inbox an ordinary import would take (shown only; a re-import leaves them alone). */
  readonly otherNewFiles: number
  readonly blockers: { readonly errors: readonly string[]; readonly uncertain: readonly string[] }
  /** Folders matched to places by name: confirmed with `acceptFolderBindings`. */
  readonly folderBindings: readonly { readonly folder: string; readonly placeId: string; readonly names: Readonly<Record<string, string>> }[]
}

export interface MediaReimportResult {
  readonly revision: number
  readonly mediaIds: readonly string[]
  readonly duplicate: boolean
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const list = <T>(value: unknown, item: (entry: unknown) => entry is T): value is T[] => Array.isArray(value) && value.every(item)
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const PROBLEMS = new Set(['missing', 'content-changed', 'unreadable'])
const REASONS = new Set(['same-path', 'new-path'])

const isScope = (value: unknown): value is MediaRereadScope => object(value) && Object.keys(value).length === 1 && (text(value.mediaId) || text(value.cityId))
const isChange = (value: unknown): value is MediaRereadChange => object(value) && text(value.field) && 'from' in value && 'to' in value
const isRecord = (value: unknown): value is MediaRereadRecord => object(value) && text(value.mediaId) && nullableText(value.cityId) && list(value.changes, isChange)
  && value.changes.length > 0 && list(value.sources, (source): source is MediaRereadRecord['sources'][number] => object(source) && text(source.path) && text(source.sha256) && text(source.descriptionDigest))

/** A re-read preview as the endpoint answers it. */
export const isMediaRereadPreview = (value: unknown): value is MediaRereadPreview => object(value) && text(value.libraryId) && count(value.revision)
  && digest(value.planDigest) && isScope(value.scope) && list(value.records, isRecord) && count(value.unchanged) && count(value.registryOnly) && count(value.withoutSource)
  && list(value.conflicts, (conflict): conflict is MediaRereadPreview['conflicts'][number] => object(conflict) && text(conflict.mediaId)
    && list(conflict.sources, (source): source is { path: string; descriptionDigest: string } => object(source) && text(source.path) && text(source.descriptionDigest)))
  && list(value.problems, (problem): problem is MediaRereadPreview['problems'][number] => object(problem) && text(problem.mediaId) && text(problem.path)
    && text(problem.reason) && PROBLEMS.has(problem.reason) && text(problem.detail))

/** A re-read write's answer. */
export const isMediaRereadResult = (value: unknown): value is MediaRereadResult => object(value) && count(value.revision)
  && list(value.updatedMediaIds, text) && typeof value.duplicate === 'boolean'

const isCandidate = (value: unknown): value is MediaReimportCandidate => object(value) && text(value.path) && nullableText(value.cityId) && text(value.kind)
  && count(value.bytes) && digest(value.sha256) && text(value.reason) && REASONS.has(value.reason) && typeof value.pendingDeletion === 'boolean'

/** The list of files a re-import may restore. */
export const isMediaReimportCandidates = (value: unknown): value is MediaReimportCandidates => object(value) && text(value.libraryId) && count(value.revision)
  && count(value.scannedFiles) && count(value.hashedFiles) && list(value.candidates, isCandidate) && count(value.otherCities)

/** A re-import preview. */
export const isMediaReimportPreview = (value: unknown): value is MediaReimportPreview => {
  if (!object(value) || !text(value.libraryId) || !count(value.revision) || !digest(value.planDigest) || !count(value.otherNewFiles)) return false
  const { file, record, blockers, folderBindings } = value
  return object(file) && text(file.path) && digest(file.sha256) && count(file.bytes) && text(file.reason) && REASONS.has(file.reason) && typeof file.pendingDeletion === 'boolean'
    && (record === null || (object(record) && nullableText(record.cityId) && text(record.kind) && nullableText(record.date) && typeof record.reusesFiles === 'boolean' && record.orderPosition === 'end'))
    && object(blockers) && list(blockers.errors, text) && list(blockers.uncertain, text)
    && list(folderBindings, (binding): binding is MediaReimportPreview['folderBindings'][number] => object(binding) && text(binding.folder) && text(binding.placeId) && object(binding.names))
}

/** A re-import write's answer. */
export const isMediaReimportResult = (value: unknown): value is MediaReimportResult => object(value) && count(value.revision)
  && list(value.mediaIds, text) && typeof value.duplicate === 'boolean'

/** The fields a re-read can change, in the order the preview lists them (place, the described keys, title). */
export const MEDIA_REREAD_FIELDS = Object.freeze(['place', 'kind', 'date', 'resolution', 'captureType', 'description', 'position', 'altitudeMeters', 'relativeAltitudeMeters', 'status', 'title'] as const)

/** The preview is out of date: the write was refused before anything was written (preview again). */
export const isStalePreviewCode = (code: unknown) => code === 'E_MEDIA_PREVIEW_STALE' || code === 'E_STALE'

/**
 * A field value of a re-read preview as text, or undefined when it is empty (null, an empty string). Titles and other
 * localized values take the page's language first, then English, then any; a place id is named by `placeName`; a
 * position is `lat, lng`; anything else is its JSON.
 */
export function rereadValueText(field: string, value: unknown, locale: string, placeName: (id: string) => string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (field === 'place' && typeof value === 'string') return placeName(value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (object(value) && object(value.names)) {
    const names = value.names as Record<string, unknown>
    const chosen = [names[locale], names.en, ...Object.values(names)].find((name) => typeof name === 'string' && name)
    return typeof chosen === 'string' ? chosen : undefined
  }
  if (object(value) && typeof value.lat === 'number' && typeof value.lng === 'number') return `${value.lat}, ${value.lng}`
  return JSON.stringify(value)
}
