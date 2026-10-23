/**
 * Media tasks in the new-library mode (3C-4c, design v2 §6): what a task previews and imports, from the media service's
 * plan (./media-service.mjs planImport). ./media-job-service.mjs calls these with `storeMedia` (the plugin's session);
 * since 3C-4d media tasks run in the new library only (the V2 importer's task plan is removed).
 *
 * - A task's files are explicit additions (review §8-3): each becomes a new record, appended to its city order.
 * - The plan digest covers the store ([library id, revision, registry digest]: a commit that only changes the registry,
 *   such as a move, keeps the revision), every scanned file (path, size, content, place, kind, description), the
 *   scan's problems, the folder bindings and the summary. It does not depend on the confirmations a request carries.
 * - The summary keeps the shape of the V2 preview (the page's validator): records the import would create get
 *   provisional ids (`new-1`, …: labels only, the import allocates UUIDv7 ids), records whose source moves are
 *   `updatedIds`, nothing is removed (a file gone from the Inbox leaves its record). Generated files are listed with
 *   `sha256: null` until they exist, except an original (the source's own content). New in the store: `sourceMatches`
 *   (confirmed with `acceptSourceMatches`) and `missing` (sources the import marks missing).
 * - Blockers: scan and file errors (E_MEDIA_PLAN_SCAN) and uncertain information (E_MEDIA_PLAN_UNCERTAIN), as in V2.
 */
import { createHash } from 'node:crypto'
import { resolveClassification } from './media-registry.mjs'
import { INBOX_PREFIX, pathKeyOf } from './store-media-registry.mjs'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]))
  return value
}
const stable = (value) => JSON.stringify(normalized(value) ?? null)
const inboxRelative = (portable) => portable.slice(INBOX_PREFIX.length)

/** The Inbox paths (portable, `MediaInbox/…`) of a task's selected files. */
export const taskPathsOf = (job, selectedFileIds) => job.files.filter((file) => selectedFileIds.includes(file.fileId)).map((file) => `${INBOX_PREFIX}${file.sourcePath}`)

/**
 * The registry in a digest: the sources and the asset links. Generated-file rows and queued deletions are left out
 * (the deletions an import runs first remove only rows no record links), and so is the scan cache (it only saves
 * hashing).
 */
export function registryDigestOf(registry) {
  return hash(stable({
    sources: registry.sources.map((source) => [source.seq, source.pathKey, source.sha256, source.recordId, source.state, source.descriptionDigest ?? null]),
    assetFiles: registry.assetFiles.map((link) => [link.assetId, link.sha256]),
  }))
}

/** One digest of the library a receipt was sealed against (the V2 receipt digests the catalog and the index). */
export const storeLibraryDigestOf = ({ libraryId, revision, registry }) => hash(stable({ store: [libraryId, revision, registryDigestOf(registry)] }))

/**
 * The preview of a task in the store: { digest, summary, blockers }. `plan` is the service's plan (planImport with the
 * task's paths explicit), `meta` the store's meta, `job` and `selectedFileIds` the task. A selected file the scan does
 * not find as it was received, or that resolves to another place or kind, is E_MEDIA_JOB_REVIEW (as in V2).
 */
export function storeTaskPlanOf({ plan, meta, job, selectedFileIds }) {
  const records = new Map(plan.records.map((record) => [record.recordId, record]))
  const proposed = resolveClassification(plan.classification, { accept: true })
  const provisional = new Map(plan.newRecords.map((item, index) => [item.fact.pathKey, `new-${index + 1}`]))
  const newByKey = new Map(plan.newRecords.map((item) => [item.fact.pathKey, item]))

  for (const file of job.files.filter((candidate) => selectedFileIds.includes(candidate.fileId))) {
    const item = newByKey.get(pathKeyOf(`${INBOX_PREFIX}${file.sourcePath}`))
    if (!item || item.fact.sha256 !== file.sha256 || item.fact.size !== file.bytes) throw new V2WriteError('E_MEDIA_JOB_REVIEW')
    const described = item.described.item
    if (described && (described.placeId !== job.cityId || described.kind !== job.kind)) throw new V2WriteError('E_MEDIA_JOB_REVIEW')
  }

  const source = (fact, id, placeId, kind) => ({ id, sourcePath: inboxRelative(fact.path), sha256: fact.sha256, bytes: fact.size, kind, placeId })
  const sources = [
    ...plan.newRecords.map((item) => source(item.fact, provisional.get(item.fact.pathKey), item.described.item?.placeId ?? item.fact.placeId, item.described.item?.kind ?? item.fact.kind)),
    ...proposed.moves.map((move) => source(move.fact, records.get(move.recordId)?.assetId ?? move.recordId, records.get(move.recordId)?.placeId ?? move.fact.placeId, move.fact.kind)),
    ...[...plan.classification.unchanged, ...plan.classification.reappeared]
      .filter(({ source: registered }) => records.has(registered.recordId))
      .map(({ fact, source: registered }) => source(fact, records.get(registered.recordId).assetId, records.get(registered.recordId).placeId, fact.kind)),
  ]
  const registered = new Set(plan.registry.files.map((file) => file.sha256))
  const generated = new Set()
  const outputs = []
  for (const item of plan.newRecords) {
    const files = item.described.generated
    if (!files || registered.has(item.fact.sha256) || generated.has(item.fact.sha256)) continue
    generated.add(item.fact.sha256)
    const id = provisional.get(item.fact.pathKey)
    outputs.push({ id, path: files.original, sha256: item.fact.sha256 }, ...files.derivatives.map((derivative) => ({ id, path: derivative.file, sha256: null })))
  }
  // A task's files are appended to their city's order (as the V2 import did; that code is removed in 3C-4d).
  const explicit = taskPathsOf(job, selectedFileIds).map((value) => pathKeyOf(value))
  const restoredMediaIds = explicit.map((key) => provisional.get(key)).filter(Boolean)
  const tables = { photos: structuredClone(plan.editorLists.mediaOrderByCity), drone: structuredClone(plan.editorLists.droneOrderByCity) }
  const touched = { photos: new Set(), drone: new Set() }
  for (const key of explicit) {
    const item = newByKey.get(key)?.described.item
    if (!item) continue
    const kind = item.kind === 'photo' ? 'photos' : 'drone'
    tables[kind][item.placeId] = [...(tables[kind][item.placeId] ?? []), provisional.get(key)]
    touched[kind].add(item.placeId)
  }
  const orders = Object.fromEntries(Object.entries(tables).map(([kind, table]) => [kind, Object.fromEntries([...touched[kind]].map((city) => [city, table[city]]))]))
  const summary = {
    addedIds: plan.newRecords.map((item) => provisional.get(item.fact.pathKey)),
    updatedIds: [...new Set(proposed.moves.map((move) => records.get(move.recordId)?.assetId).filter(Boolean))],
    removedIds: [],
    sources,
    pins: plan.pins.map((pin) => ({
      sourcePath: `${inboxRelative(pin.folder)}/place.json`, placeId: pin.placeId, folder: inboxRelative(pin.folder), subtype: pin.subtype, names: { ...pin.names }, source: pin.source,
    })),
    outputs,
    editorEffects: { restoredMediaIds, orders },
    sourceMatches: plan.classification.confirmations.flatMap((group) => group.entries.map((entry) => ({
      sourcePath: inboxRelative(entry.fact.path), kind: group.kinds[0], proposal: entry.proposal.action,
      ...(entry.proposal.action === 'move' ? { mediaId: records.get(entry.proposal.recordId)?.assetId ?? entry.proposal.recordId } : {}),
    }))),
    missing: proposed.gone.length,
  }
  const blockers = [
    ...plan.blockers.errors.map(() => ({ code: 'E_MEDIA_PLAN_SCAN' })),
    ...plan.blockers.uncertain.map(() => ({ code: 'E_MEDIA_PLAN_UNCERTAIN' })),
  ]
  const digest = hash(stable({
    store: [meta.libraryId, plan.revision, registryDigestOf(plan.registry)],
    facts: plan.scan.facts.map((fact) => [fact.pathKey, fact.size, fact.sha256, fact.placeId, fact.kind, fact.descriptionDigest]),
    errors: plan.scan.errors, warnings: plan.warnings,
    pins: plan.scan.pins.map((pin) => [pin.folder, pin.placeId, pin.subtype, pin.source]),
    summary, blockers,
  }))
  return { digest, summary, blockers }
}
