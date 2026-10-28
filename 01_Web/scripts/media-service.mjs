/**
 * The new library's media service (3C-4c, design v2 §3 and §4; review §8): import and deletion, one implementation for
 * the dev server's endpoints, media tasks and the command line. Store-native: no V2 write function, no
 * diffV2ToCommands (both retired in 3C-5 E). Every write runs under the library lease its caller holds and commits with that `leaseToken`.
 *
 * Import (importInbox):
 *   pending deletions first (media-file-ops.mjs) → the Inbox scan (media-scan.mjs) against the registry and the live
 *   records (media-registry.mjs classifyScan) → the files that become records described (dimensions, the importer's
 *   checks) → blockers: scan or file errors, uncertain information (the editor importer's rule, for the endpoint and
 *   tasks), folder bindings and source matches not confirmed → nothing written while anything blocks → generated files
 *   of new content (temporary file, fsync, publication without overwriting, then the directory synced where the system
 *   allows) → confirmed folder bindings (place.json) → one commit: records and their view rows (mediaRecords.ts), the
 *   registry, the scan cache and the receipt. Files written before a commit that never happens are unreferenced only.
 * Deletion (deleteMedia): the V2 rule decides what may be deleted (hidden photos or drone media of the city) → one
 * commit: the records and every view row naming them gone (tombstoned), their sources deleted, the links gone, the
 * source files and the directories no record links any more queued in pending_file_ops → the queued files removed.
 * The Inbox is not scanned.
 * Re-reading descriptions (planReread / rereadDescriptions, design v2 §5, the command line's --reread, 3C-5 F the page):
 * the records in a scope take the place, kind, title and sidecar values their folder and sidecar give now (mediaRecords.ts
 * rereadMediaRecordCommands), and their sources the new description digest. A record whose present sources describe it
 * differently is refused and listed; a source whose file is gone or changed is listed. A preview gives a digest; the
 * write computes the plan again under the lease and writes only when the digest is the same (E_MEDIA_PREVIEW_STALE).
 *
 * `store` is the media store adapter: { readOnly, meta(), official() → { revision, reader } (3C-5 E: the official reader at the
 * store's current revision, ../src/data/store/officialReader.ts; the media rules read their places, editor lists and media
 * items from it, never a V2 shape), mediaRegistry(), mediaEntities(), read(reader → value), lookup(requestId),
 * commit(request, { leaseToken }), settleFileOps(work, { leaseToken }) }: store-session.mjs mediaStore() for the dev server,
 * handleMediaStore(handle) for a command line. The session's reader answers from its live index, which moves on with the
 * next commit: what an operation needs is read from it at once, before any await, and every commit carries the
 * reader's revision as its base (a plan made before another commit is refused, E_STALE).
 */
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { sha256File } from './file-hash.mjs'
import { atomicJsonWrite } from './json-file.mjs'
import { hash, isPlanDigest, stable } from './media-digest.mjs'
import { runPendingFileOps } from './media-file-ops.mjs'
import { classifyScan, liveRecordsOf, pinsFor, registryDeltaOf, resolveClassification } from './media-registry.mjs'
import { IMPORT_BLOCKING_PATTERN, describeMediaFile, scanInbox } from './media-scan.mjs'
import { directoryOf, pathKeyOf } from './store-media-registry.mjs'
import { publishGeneratedFiles } from './media-inbox.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { officialReader } from '../src/data/store/officialReader.ts'
import { indexReadModel } from '../src/worldgraph/readModel/lookup.ts'
import { createMediaRecordCommands, removeMediaRecordCommands, rereadDiff, rereadMediaRecordCommands } from '../src/data/store/mediaRecords.ts'
import { deletableMediaOf, generatedDirectoriesOf } from '../src/data/v2media/editorWrites.ts'
import { placeConfigOf } from '../src/data/v2media/importPlan.ts'
import { V2WriteError } from '../src/data/editor/errors.ts'

/**
 * libvips keeps recently read files open through its operation cache. On Windows a file it holds can then not be
 * rewritten until it is released. `sharp.cache({ files: 0 })` is not enough: it releases what a pipeline writing a file
 * read, but an input decoded into a buffer (an upload's or a task reception's full decode, whose staging file becomes
 * the Inbox file by a hard link) stays open. `sharp.cache(false)` turns the operation cache off, which releases every
 * input, held ones included (observed on Windows with sharp 0.35). These pipelines read each file a few times at most
 * and gain little from the cache. Called before the media service or a store-mode media endpoint uses sharp; it
 * affects the whole process (V2 results do not change).
 */
export const releaseImageFiles = () => sharp.cache(false)

/** `kind` prefixes of the service's requests (the host's receipts and op_log). */
export const MEDIA_KINDS = Object.freeze({
  import: 'starmap.media.import', delete: 'starmap.media.delete', task: 'starmap.media.task-import', cli: 'starmap.media.cli-import',
  // 3C-5 F: the page's re-reading and re-importing (the command line keeps cli-import.reread and cli-import).
  reread: 'starmap.media.reread', reimport: 'starmap.media.reimport',
})

const fail = (code, params) => { throw new V2WriteError(code, params) }
const nonEmpty = (block) => Object.fromEntries(Object.entries(block).filter(([, list]) => list.length > 0))

/**
 * The asset of each path key (deduplicated, in order): the record `created` names for it (an import just now),
 * otherwise the record of the present source at that path (a file already imported, a retried request). The answer of
 * an import's explicit paths (V2 answered with the media of these paths too) and of a task's receipt.
 */
export function assetsOfPaths(store, keys, created) {
  const { sources } = store.mediaRegistry()
  const assetOf = new Map(store.mediaEntities().map((row) => [row.id, row.fields.asset]))
  const ids = []
  for (const key of keys) {
    const made = created?.get(key)?.assetId
    const source = made ? undefined : sources.find((item) => item.pathKey === key && item.state === 'present')
    const id = made ?? (source ? assetOf.get(source.recordId) : undefined)
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The media store adapter of an open store handle (a command line, tests): the official reader of a fresh read model on each call. */
export function handleMediaStore(handle) {
  return {
    get readOnly() { return handle.readOnly },
    meta: () => handle.meta(),
    async official() {
      const model = handle.readModel()
      return { revision: model.revision, reader: officialReader(indexReadModel(model)) }
    },
    mediaRegistry: () => handle.mediaRegistry(),
    mediaEntities: () => handle.mediaEntities(),
    read: (callback) => handle.read(callback),
    lookup: (requestId) => handle.lookup(requestId),
    commit: (request, options) => handle.commit(request, options),
    settleFileOps: (work, options) => handle.settleFileOps(work, options),
  }
}

/** fsync a directory after a publication where the system allows it (Windows does not open directories: ignored). */
async function syncDirectory(directory) {
  let handle
  try { handle = await open(directory, 'r'); await handle.sync() } catch { /* Not supported here; every file is fsynced. */ } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * The service for one private root. `allocateId` gives the UUIDv7 of new rows (tests inject it); `hashFile` is injectable,
 * and so is `readImage` (the image reader of a re-read when the stored dimensions do not apply; tests count it).
 */
export function createMediaService({ privatePaths, store, allocateId = () => uuidv7(), hashFile = sha256File, readImage }) {
  releaseImageFiles()

  /** A request already committed: its receipt (a retry); the same id with another body or base is E_OPERATION_CONFLICT. */
  function replayOf(requestId, kind, baseRevision) {
    const previous = store.lookup(requestId)
    if (!previous.found) return undefined
    if (previous.receipt.kind !== kind || (baseRevision !== undefined && previous.receipt.baseRevision !== baseRevision)) fail('E_OPERATION_CONFLICT')
    return { duplicate: true, receipt: previous.receipt, revision: previous.receipt.revision }
  }

  /**
   * What an import would do now, without writing: { revision, scan, classification, decisions, newRecords (each
   * { fact, explicit, described }), pins (bindings of folders with new records), blockers { errors, uncertain, bindings,
   * matches }, blocked, nothingToWrite, registry, records }. `explicitPaths` are portable `MediaInbox/…` paths added on
   * purpose (§8-3); confirmations apply only with `acceptSourceMatches` and `acceptFolderBindings`; `blockOnWarnings`
   * applies the editor importer's rule for uncertain information (the endpoint and tasks; the command line imports with it).
   * `editorLists` are the official editor lists at the plan's revision (a task's preview appends to its city's order).
   */
  async function planImport({ explicitPaths = [], acceptSourceMatches = false, acceptFolderBindings = false, blockOnWarnings = true } = {}) {
    const { revision, reader } = await store.official()
    // Read at once (see the file header): the places of the scan and the editor lists.
    const places = reader.places()
    const editorLists = reader.editorLists()
    const registry = store.mediaRegistry()
    const records = liveRecordsOf({ entities: store.mediaEntities() }, registry.assetFiles)
    const scan = await scanInbox({ privatePaths, places, cache: registry.scanCache, hashFile })
    const explicit = new Set(explicitPaths.map((value) => pathKeyOf(value)))
    const classification = classifyScan({ sources: registry.sources, records, facts: scan.facts, explicit })
    // Describe what would be created once every match is confirmed, so the preview shows its problems too.
    const proposed = resolveClassification(classification, { accept: true })
    const newRecords = []
    const errors = [...scan.errors]
    const warnings = [...scan.warnings]
    const advisory = new Set()
    for (const item of proposed.newRecords) {
      const described = await describeMediaFile(item.fact)
      errors.push(...described.errors)
      warnings.push(...described.warnings)
      for (const warning of described.advisoryWarnings) advisory.add(warning)
      newRecords.push({ ...item, described })
    }
    const pins = pinsFor(scan.pins, proposed.newRecords.map((item) => item.fact))
    const decisions = resolveClassification(classification, { accept: acceptSourceMatches })
    const blockers = {
      errors,
      uncertain: blockOnWarnings ? warnings.filter((warning) => !advisory.has(warning) && IMPORT_BLOCKING_PATTERN.test(warning)) : [],
      bindings: acceptFolderBindings ? [] : pins,
      matches: decisions.blocked ? classification.confirmations : [],
    }
    const blocked = Object.values(blockers).some((list) => list.length > 0)
    const cacheChanged = registryDeltaOf({ newRecords: [], moves: [], reappeared: [], gone: [] }, { created: new Map(), files: new Map(), registeredFiles: new Set(), facts: scan.facts, cache: registry.scanCache }).scanCache.length > 0
    const nothingToWrite = proposed.newRecords.length === 0 && classification.moves.length === 0 && classification.confirmations.length === 0
      && classification.reappeared.length === 0 && classification.gone.length === 0 && !cacheChanged
    return { revision, editorLists, scan, classification, decisions, newRecords, pins, warnings, blockers, blocked, nothingToWrite, registry, records }
  }

  /** Lines of a plan (the endpoint's `output`, the command line's report). Paths only where the importer printed them. */
  function reportLines(plan) {
    const c = plan.classification
    const lines = [
      `StarMap 媒体导入（新库）：投递箱 ${plan.scan.facts.length} 个文件；新资料 ${plan.newRecords.length}，移动 ${c.moves.length}，不在投递箱中 ${plan.decisions.gone.length}，已删除不再导入 ${c.deletedSkips.length}。`,
    ]
    if (plan.warnings.length) lines.push(`\n提醒（${plan.warnings.length}）：`, ...plan.warnings.map((warning) => `- ${warning}`))
    if (plan.blockers.errors.length) lines.push(`\n需要处理（${plan.blockers.errors.length}）：`, ...plan.blockers.errors.map((error) => `- ${error}`))
    if (plan.blockers.bindings.length) {
      lines.push(`\n待确认的文件夹绑定（${plan.blockers.bindings.length}）：以下文件夹按名称匹配到地点，确认之后才会写入 place.json 并按它导入：`,
        ...plan.blockers.bindings.map((pin) => `- ${pin.folder.slice('MediaInbox/'.length)} → ${pin.names?.['zh-Hans'] ?? ''} / ${pin.names?.en ?? ''}`))
    }
    if (c.confirmations.length) {
      lines.push(`\n待确认的来源匹配（${c.confirmations.length}）：`)
      for (const group of c.confirmations) {
        const reason = group.kinds.includes('deleted-content') ? '这张照片之前被彻底删除过' : group.kinds.includes('replaced') ? '同一路径的文件内容变了，会作为新资料，旧的保留' : '同一内容对应多条资料，按建议配对'
        for (const entry of group.entries) {
          lines.push(`- ${entry.fact.path.slice('MediaInbox/'.length)}：${reason}；建议${entry.proposal.action === 'move' ? '作为原有资料的移动' : '作为新资料导入'}`)
        }
      }
    }
    if (c.crossCity.length) lines.push(`\n移到了另一个城市的文件夹（${c.crossCity.length}）：地点没有改变，可以用 npm run media:import -- --reread <路径> 更新。`, ...c.crossCity.map((item) => `- ${item.fact.path.slice('MediaInbox/'.length)}`))
    if (c.descriptionChanged.length) lines.push(`\n说明有变化、没有生效（${c.descriptionChanged.length}）：可以用 --reread 更新。`, ...c.descriptionChanged.map((item) => `- ${item.fact.path.slice('MediaInbox/'.length)}`))
    return lines
  }

  /** Generate the files of new content (deduplicated), hash them, and return the media_files entries by content. */
  async function writeGeneratedFiles(newRecords, registered) {
    const entries = new Map()
    for (const { fact, described } of newRecords) {
      if (registered.has(fact.sha256) || entries.has(fact.sha256)) continue
      const absolute = (relative) => path.join(privatePaths.root, ...relative.split('/'))
      const generated = described.generated
      const outputDirectory = absolute(generated.directory)
      if (generated.directory !== directoryOf(fact.sha256)) fail('E_MEDIA_IMPORT_FAILED', { reason: 'generated directory' })
      await publishGeneratedFiles({
        sourcePath: fact.absolutePath, outputDirectory, outputPath: absolute(generated.original),
        derivatives: generated.derivatives.map((derivative) => ({ outputPath: absolute(derivative.file), maxEdge: derivative.maxEdge, quality: derivative.quality })),
      })
      await syncDirectory(outputDirectory)
      const outputs = []
      for (const relative of [generated.original, ...generated.derivatives.map((derivative) => derivative.file)]) {
        const file = absolute(relative)
        const sha256 = await hashFile(file)
        const { size } = await stat(file)
        outputs.push({ name: path.basename(file), sha256, bytes: size })
      }
      // The original must be the source's bytes (a file left by an interrupted import is checked the same way).
      if (outputs[0].sha256 !== fact.sha256) fail('E_MEDIA_IMPORT_FAILED', { reason: `media/user/${generated.directory.slice('media/user/'.length)}/${outputs[0].name} 与源文件不一致` })
      entries.set(fact.sha256, { extension: fact.extension, bytes: outputs[0].bytes, outputs: outputs.sort((a, b) => (a.name < b.name ? -1 : 1)) })
    }
    return entries
  }

  /**
   * Import the Inbox. `requestId` (UUIDv7, kept on retries) and `kind` identify the request; `baseRevision` is checked
   * when given (the page's revision). Resolves:
   * - { duplicate: true, receipt } for a request already committed;
   * - { blocked: true, plan } when anything blocks (nothing written);
   * - { committed: false, plan } when nothing changed;
   * - { committed: true, revision, receipt, plan, created } after the commit (`created`: path key → { assetId, entityId }).
   * Before the commit, `onStage('generated' | 'pins')` is awaited after each step (tasks record their stages).
   */
  async function importInbox({ requestId, kind = MEDIA_KINDS.import, actor = 'local-editor', baseRevision, leaseToken, explicitPaths = [], acceptSourceMatches = false, acceptFolderBindings = false, blockOnWarnings = true, onStage = async () => {}, expect } = {}) {
    if (store.readOnly) fail('E_STORE_READ_ONLY')
    const replay = replayOf(requestId, kind, baseRevision)
    if (replay) return replay
    const drained = await runPendingFileOps({ privatePaths, store, leaseToken, hashFile })
    const plan = await planImport({ explicitPaths, acceptSourceMatches, acceptFolderBindings, blockOnWarnings })
    if (baseRevision !== undefined && plan.revision !== baseRevision) fail('E_STALE')
    if (expect) await expect(plan)
    if (plan.blocked) return { blocked: true, plan, drained }
    if (plan.nothingToWrite) return { committed: false, plan, drained, revision: plan.revision }
    const registered = new Set(plan.registry.files.map((file) => file.sha256))
    const toCreate = plan.newRecords.filter((item) => plan.decisions.newRecords.some((decided) => decided.fact.pathKey === item.fact.pathKey))
    const files = await writeGeneratedFiles(toCreate, registered)
    await onStage('generated')
    for (const pin of acceptFolderBindings ? plan.pins : []) await atomicJsonWrite(path.join(pin.directory, 'place.json'), placeConfigOf(pin.placeId))
    await onStage('pins')
    const created = new Map(toCreate.map((item) => [item.fact.pathKey, { assetId: allocateId(), entityId: allocateId() }]))
    const records = toCreate.map((item) => ({ ...created.get(item.fact.pathKey), item: item.described.item, appendToCityOrder: item.explicit === true }))
    const commands = records.length ? store.read((reader) => createMediaRecordCommands(records, { reader, allocateId })).commands : []
    const media = nonEmpty(registryDeltaOf(plan.decisions, { created, files, registeredFiles: registered, facts: plan.scan.facts, cache: plan.registry.scanCache }))
    const result = await store.commit({ requestId, baseRevision: plan.revision, kind, actor, commands: [...commands], media }, { leaseToken })
    return { committed: true, revision: result.revision, receipt: result.receipt, plan, created, drained }
  }

  /**
   * Delete hidden media of a city for good (`{ cityId, ids }`, the V2 rule). Resolves { duplicate, receipt } for a
   * request already committed, otherwise { deletedIds, revision, receipt, drained } after the commit and the file run.
   */
  async function deleteMedia({ input, requestId, kind = MEDIA_KINDS.delete, actor = 'local-editor', baseRevision, leaseToken }) {
    if (store.readOnly) fail('E_STORE_READ_ONLY')
    const replay = replayOf(requestId, kind, baseRevision)
    if (replay) return replay
    const { revision, reader } = await store.official()
    if (baseRevision !== undefined && revision !== baseRevision) fail('E_STALE')
    const { ids, items } = deletableMediaOf(reader, input)
    generatedDirectoriesOf(items)
    const registry = store.mediaRegistry()
    const entities = store.mediaEntities()
    const linkOf = new Map(registry.assetFiles.map((link) => [link.assetId, link.sha256]))
    const records = ids.map((assetId) => {
      const entity = entities.find((row) => row.fields.asset === assetId)
      if (!entity) fail('E_MEDIA_DELETE_NOT_HIDDEN', { id: assetId })
      return { assetId, recordId: entity.id, sha256: linkOf.get(assetId) }
    })
    const commands = store.read((reader) => removeMediaRecordCommands(ids, { reader })).commands
    const removing = new Set(ids)
    const recordIds = new Set(records.map((record) => record.recordId))
    const sources = registry.sources.filter((source) => recordIds.has(source.recordId) && source.state !== 'deleted')
    const contents = [...new Set(records.map((record) => record.sha256).filter(Boolean))]
    const media = nonEmpty({
      assetFiles: records.filter((record) => record.sha256).map((record) => ({ op: 'remove', assetId: record.assetId })),
      sources: sources.map((source) => ({ op: 'update', seq: source.seq, state: 'deleted' })),
      fileOps: [
        ...sources.filter((source) => source.state === 'present').map((source) => ({ kind: 'delete-source', target: source.path, detail: { sha256: source.sha256 } })),
        ...contents.filter((sha256) => !registry.assetFiles.some((link) => link.sha256 === sha256 && !removing.has(link.assetId)))
          .map((sha256) => ({ kind: 'delete-generated', target: directoryOf(sha256), detail: { sha256 } })),
      ],
    })
    const result = await store.commit({ requestId, baseRevision: revision, kind, actor, commands: [...commands], media }, { leaseToken })
    const drained = await runPendingFileOps({ privatePaths, store, leaseToken, hashFile })
    return { deletedIds: ids, revision: result.revision, receipt: result.receipt, drained }
  }

  /**
   * A re-read scope, normalized (it is part of the digest): { paths } (portable `MediaInbox/…` files or folders, path
   * keys; the command line), { mediaIds } (media ids, which are asset ids) or { cityId } (a city place). Media the reader
   * does not have: E_MEDIA_NOT_FOUND; a place that is not a city: E_UNKNOWN_PLACE_REF.
   */
  function rereadScopeOf(scope, reader) {
    if (Array.isArray(scope?.paths) && scope.paths.length && scope.paths.every((value) => typeof value === 'string')) {
      return { paths: [...new Set(scope.paths.map((value) => pathKeyOf(value).replace(/\/+$/, '')))].sort() }
    }
    if (Array.isArray(scope?.mediaIds) && scope.mediaIds.length && scope.mediaIds.every((value) => typeof value === 'string')) {
      const mediaIds = [...new Set(scope.mediaIds)].sort()
      for (const id of mediaIds) if (!reader.mediaItem(id)) fail('E_MEDIA_NOT_FOUND')
      return { mediaIds }
    }
    if (typeof scope?.cityId === 'string' && scope.cityId) {
      if (reader.place(scope.cityId)?.subtype !== 'city') fail('E_UNKNOWN_PLACE_REF')
      return { cityId: scope.cityId }
    }
    return fail('E_REQUEST_INVALID', { reason: '重新读取说明的范围无效。' })
  }

  /**
   * What re-reading descriptions would do, without writing (3C-5 F: the preview the page and the command line show, and
   * the plan a write computes again under the lease). `scope` (see rereadScopeOf): the records of the present sources under
   * some paths, some records by media id, or a city's records together with those whose present source now lies in a
   * folder of that city. Every present source of a record counts, also one outside the scope: all must describe it alike.
   * Resolves { libraryId, revision, scope, records, conflicts, problems, withoutSource, digest }:
   * - records (sorted by record id): { recordId, assetId, placeId, sources (Inbox-relative paths), sourceFacts (path,
   *   pathKey, seq, sha256, descriptionDigest, registered), diff ([{ field, from, to }], rereadDiff), changes (the fields),
   *   item, digest (the description digest), seqs (sources whose registered digest differs) };
   * - conflicts: { recordId, assetId, sources [{ path, pathKey, sha256, descriptionDigest }] } (sources disagree: not written);
   * - problems: { recordId, assetId, path, pathKey, reason (missing | content-changed | unreadable), line } (not written);
   * - withoutSource: { recordId, assetId } (no present source: nothing to read);
   * - digest: what a write must confirm (see the file header of ./media-digest.mjs): the library id and revision, the
   *   scope, and per record its field changes and its sources (sequence, path, content, scanned and registered
   *   description digests), the conflicts, the problems and the records without source.
   * Dimensions: a record whose source has the content its asset links takes the asset's stored width and height (the
   * same file, already oriented) instead of reading the image again; any other reads the file.
   */
  async function planReread({ scope }) {
    const { revision, reader } = await store.official()
    // Read at once (see the file header): the places, the scope and the stored dimensions of the media.
    const places = reader.places()
    const normalized = rereadScopeOf(scope, reader)
    const entities = store.mediaEntities().filter((row) => row.typeId === 'starmap:media' && typeof row.fields?.asset === 'string')
    const stored = new Map()
    for (const row of entities) {
      const media = reader.mediaItem(row.fields.asset)
      if (media && Number.isFinite(media.width) && Number.isFinite(media.height) && media.width > 0 && media.height > 0) stored.set(row.fields.asset, { width: media.width, height: media.height })
    }
    const { libraryId } = store.meta()
    const registry = store.mediaRegistry()
    const assetOf = new Map(entities.map((row) => [row.id, row.fields.asset]))
    const placeOf = new Map(entities.map((row) => [row.id, row.fields.place]))
    const linked = new Map(registry.assetFiles.map((link) => [link.assetId, link.sha256]))
    const scan = await scanInbox({ privatePaths, places, cache: registry.scanCache, hashFile })
    const facts = new Map(scan.facts.map((fact) => [fact.pathKey, fact]))
    const present = registry.sources.filter((source) => source.state === 'present')
    const presentOf = new Map()
    for (const source of present) presentOf.set(source.recordId, [...(presentOf.get(source.recordId) ?? []), source])
    let inScope
    if (normalized.paths) {
      const within = (key) => normalized.paths.some((prefix) => key === prefix || key.startsWith(`${prefix}/`))
      inScope = present.filter((source) => within(source.pathKey)).map((source) => source.recordId)
    } else if (normalized.mediaIds) {
      const wanted = new Set(normalized.mediaIds)
      inScope = entities.filter((row) => wanted.has(row.fields.asset)).map((row) => row.id)
      if (new Set(inScope.map((id) => assetOf.get(id))).size !== wanted.size) fail('E_MEDIA_NOT_FOUND')
    } else {
      inScope = [
        ...entities.filter((row) => row.fields.place === normalized.cityId).map((row) => row.id),
        ...present.filter((source) => facts.get(source.pathKey)?.placeId === normalized.cityId).map((source) => source.recordId),
      ]
    }
    const recordIds = [...new Set(inScope)].filter((id) => assetOf.has(id)).sort()
    const relative = (value) => value.slice('MediaInbox/'.length)
    const byPath = (a, b) => (a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : a.seq - b.seq)
    const pending = []
    const conflicts = []
    const problems = []
    const withoutSource = []
    for (const recordId of recordIds) {
      const assetId = assetOf.get(recordId)
      const sources = [...(presentOf.get(recordId) ?? [])].sort(byPath)
      if (sources.length === 0) {
        withoutSource.push({ recordId, assetId })
        continue
      }
      const described = []
      for (const source of sources) {
        const fact = facts.get(source.pathKey)
        const problem = { recordId, assetId, path: relative(source.path), pathKey: source.pathKey }
        if (!fact) problems.push({ ...problem, reason: 'missing', line: `${problem.path}：不在投递箱中。请先运行 npm run media:import。` })
        else if (fact.sha256 !== source.sha256) problems.push({ ...problem, reason: 'content-changed', line: `${problem.path}：内容变了。请先运行 npm run media:import。` })
        else described.push({ source, fact })
      }
      if (described.length === 0) continue
      if (new Set(described.map(({ fact }) => fact.descriptionDigest)).size > 1) {
        conflicts.push({ recordId, assetId, sources: described.map(({ source, fact }) => ({ path: relative(source.path), pathKey: source.pathKey, sha256: fact.sha256, descriptionDigest: fact.descriptionDigest })) })
        continue
      }
      const { fact } = described[0]
      const dimensions = linked.get(assetId) === fact.sha256 ? stored.get(assetId) : undefined
      const result = await describeMediaFile(fact, { readImage: dimensions ? async () => dimensions : readImage })
      if (!result.item) {
        for (const line of result.errors) problems.push({ recordId, assetId, path: relative(described[0].source.path), pathKey: described[0].source.pathKey, reason: 'unreadable', line })
        continue
      }
      pending.push({ recordId, assetId, described, item: result.item })
    }
    // The differences in one read of the store.
    const diffs = store.read((scopeReader) => pending.map(({ assetId, item }) => rereadDiff({ assetId, item }, { reader: scopeReader })))
    const records = pending.map(({ recordId, assetId, described, item }, index) => {
      const digest = described[0].fact.descriptionDigest
      return {
        recordId, assetId, placeId: placeOf.get(recordId), sources: described.map(({ source }) => relative(source.path)),
        sourceFacts: described.map(({ source, fact }) => ({ path: relative(source.path), pathKey: source.pathKey, seq: source.seq, sha256: fact.sha256, descriptionDigest: fact.descriptionDigest, registered: source.descriptionDigest ?? null })),
        diff: diffs[index], changes: diffs[index].map((entry) => entry.field), item, digest,
        seqs: described.filter(({ source }) => source.descriptionDigest !== digest).map(({ source }) => source.seq),
      }
    })
    const digest = hash(stable({
      kind: 'starmap.media-reread', version: 1, library: [libraryId, revision], scope: normalized,
      records: records.map((record) => [record.recordId, record.assetId, record.diff.map((entry) => [entry.field, entry.from, entry.to]),
        record.sourceFacts.map((source) => [source.seq, source.pathKey, source.sha256, source.descriptionDigest, source.registered])]),
      conflicts: conflicts.map((conflict) => [conflict.recordId, conflict.assetId, conflict.sources.map((source) => [source.pathKey, source.sha256, source.descriptionDigest])]),
      problems: problems.map((problem) => [problem.recordId, problem.pathKey, problem.reason]),
      withoutSource: withoutSource.map((record) => record.recordId),
    }))
    return { libraryId, revision, scope: normalized, records, conflicts, problems, withoutSource, digest }
  }

  /**
   * Re-read descriptions in one commit (3C-5 F): `scope` and `planDigest` are what the preview showed. Under the lease
   * the caller holds, the plan is computed again and must have that digest (E_MEDIA_PREVIEW_STALE otherwise, nothing
   * written); `baseRevision` is checked when given (E_STALE). Only that plan is written: the records with changes, and
   * the registered description digests of their sources; conflicts and problems are not. Resolves { duplicate, receipt }
   * for a request already committed, { committed: false, plan } when nothing changes, otherwise { committed: true,
   * revision, receipt, plan, updatedIds }.
   */
  async function rereadDescriptions({ scope, planDigest, requestId, kind = `${MEDIA_KINDS.cli}.reread`, actor = 'media-import', baseRevision, leaseToken }) {
    if (store.readOnly) fail('E_STORE_READ_ONLY')
    if (!isPlanDigest(planDigest)) fail('E_REQUEST_INVALID', { reason: '预览摘要必须是 64 位小写十六进制。' })
    const replay = replayOf(requestId, kind, baseRevision)
    if (replay) return replay
    const plan = await planReread({ scope })
    if (baseRevision !== undefined && plan.revision !== baseRevision) fail('E_STALE')
    if (plan.digest !== planDigest) fail('E_MEDIA_PREVIEW_STALE')
    const changing = plan.records.filter((record) => record.changes.length > 0)
    const sources = plan.records.flatMap((record) => record.seqs.map((seq) => ({ op: 'update', seq, descriptionDigest: record.digest })))
    if (changing.length === 0 && sources.length === 0) return { committed: false, plan, revision: plan.revision, updatedIds: [] }
    const commands = changing.length ? store.read((reader) => rereadMediaRecordCommands(changing.map(({ assetId, item }) => ({ assetId, item })), { reader })).commands : []
    const result = await store.commit({ requestId, baseRevision: plan.revision, kind, actor, commands: [...commands], media: nonEmpty({ sources }) }, { leaseToken })
    return { committed: true, revision: result.revision, receipt: result.receipt, plan, updatedIds: changing.map((record) => record.assetId) }
  }

  return {
    planImport, importInbox, deleteMedia, reportLines, planReread, rereadDescriptions,
    drain: (leaseToken) => runPendingFileOps({ privatePaths, store, leaseToken, hashFile }),
  }
}
