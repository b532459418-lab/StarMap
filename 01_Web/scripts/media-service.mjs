/**
 * The new library's media service (3C-4c, design v2 §3 and §4; review §8): import and deletion, one implementation for
 * the dev server's endpoints, media tasks and the command line. Store-native: no V2 write function, no
 * diffV2ToCommands. Every write runs under the library lease its caller holds and commits with that `leaseToken`.
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
 *
 * `store` is the media store adapter: { readOnly, meta(), view() → { files, revision }, mediaRegistry(), mediaEntities(),
 * read(reader → value), lookup(requestId), commit(request, { leaseToken }), settleFileOps(work, { leaseToken }) }:
 * store-session.mjs mediaStore() for the dev server, handleMediaStore(handle) for a command line.
 */
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { sha256File } from './file-hash.mjs'
import { atomicJsonWrite } from './json-file.mjs'
import { IMPORT_BLOCKING_PATTERN } from './local-editor-importer.mjs'
import { runPendingFileOps } from './media-file-ops.mjs'
import { classifyScan, liveRecordsOf, pinsFor, registryDeltaOf, resolveClassification } from './media-registry.mjs'
import { describeMediaFile, scanInbox } from './media-scan.mjs'
import { directoryOf, pathKeyOf } from './store-media-registry.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { publishGeneratedFiles } from './v2-media-import.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { createMediaRecordCommands, removeMediaRecordCommands } from '../src/data/store/mediaRecords.ts'
import { deletableMediaOf, generatedDirectoriesOf } from '../src/data/v2media/editorWrites.ts'
import { placeConfigOf } from '../src/data/v2media/importPlan.ts'
import { V2WriteError } from '../src/data/v2write/errors.ts'

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
export const MEDIA_KINDS = Object.freeze({ import: 'starmap.media.import', delete: 'starmap.media.delete', task: 'starmap.media.task-import', cli: 'starmap.media.cli-import' })

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

/** The media store adapter of an open store handle (a command line, tests): the view is projected on each call. */
export function handleMediaStore(handle) {
  return {
    get readOnly() { return handle.readOnly },
    meta: () => handle.meta(),
    async view() {
      const rows = handle.readRowsUnchecked()
      return { files: projectToV2Files(rows).files, revision: rows.revision }
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
 * The service for one private root. `now` gives the time of the V2 rules (deletion) and `allocateId` the UUIDv7 of new
 * rows (tests inject both); `hashFile` is injectable.
 */
export function createMediaService({ privatePaths, store, allocateId = () => uuidv7(), now = () => new Date(), hashFile = sha256File }) {
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
   */
  async function planImport({ explicitPaths = [], acceptSourceMatches = false, acceptFolderBindings = false, blockOnWarnings = true } = {}) {
    const view = await store.view()
    const registry = store.mediaRegistry()
    const records = liveRecordsOf({ entities: store.mediaEntities() }, registry.assetFiles)
    const scan = await scanInbox({ privatePaths, places: view.files.places, cache: registry.scanCache, hashFile })
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
    return { revision: view.revision, files: view.files, scan, classification, decisions, newRecords, pins, warnings, blockers, blocked, nothingToWrite, registry, records }
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
    const view = await store.view()
    if (baseRevision !== undefined && view.revision !== baseRevision) fail('E_STALE')
    const { ids, items } = deletableMediaOf(view.files, input, now())
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
    const result = await store.commit({ requestId, baseRevision: view.revision, kind, actor, commands: [...commands], media }, { leaseToken })
    const drained = await runPendingFileOps({ privatePaths, store, leaseToken, hashFile })
    return { deletedIds: ids, revision: result.revision, receipt: result.receipt, drained }
  }

  return {
    planImport, importInbox, deleteMedia, reportLines,
    drain: (leaseToken) => runPendingFileOps({ privatePaths, store, leaseToken, hashFile }),
  }
}
