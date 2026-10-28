/**
 * The media endpoints in the new-library mode (3C-4c, design v2 §3 and §4): upload, import, and deletion of hidden
 * media; 3C-5 F re-reading descriptions and re-importing. The plugin calls the writes under the library lease (its
 * `leaseToken`), after checking that no media task is unfinished and that the store is not read-only; the previews
 * (handleStoreMediaPreview) without it. Kept apart from the plugin so the tests drive them on temporary roots.
 *
 * - Upload writes only the Inbox (the file, a new folder's place.json, a drone sidecar entry), exactly as in V2; the
 *   places come from the store's official reader (3C-5 E). It commits nothing.
 * - Import and deletion are store writes with the client protocol of 3C-3 (x-starmap-request-id, x-starmap-base-revision).
 *   A retried request answers with its receipt. Import: the paths in `sourcePaths` (what the page just uploaded) are
 *   explicit additions (review §8-3); the rest of the Inbox is scanned. Source matches that need confirming refuse the
 *   import (409 E_MEDIA_SOURCE_MATCHES_UNCONFIRMED) unless the body says `acceptSourceMatches: true`; folder bindings
 *   and uncertain information refuse it as in V2 (400 E_MEDIA_IMPORT_BLOCKED, the report in `details`).
 * Responses keep V2's shapes ({ ok, output, restoredMediaIds } / { ok, deletedIds, deletedSourceFiles, output }) plus the
 * revision and the receipt, so the page moves its base revision forward. 3C-5 F: an import's answer also counts the
 * files deleted for good it skipped (`deletedSkipped`), so the page can point at re-importing them.
 * - 3C-5 F re-reading (`reread-preview`, `reread`) and re-importing (`reimport-candidates`, `reimport-preview`,
 *   `reimport`): a preview answers what would change and its `planDigest`; the write carries the protocol headers,
 *   the same scope or path and that digest, and the media service computes the plan again under the lease: a
 *   different digest is 409 E_MEDIA_PREVIEW_STALE, nothing written. A re-import restores only a file deleted for good
 *   and back in the Inbox (409 E_MEDIA_REIMPORT_NOT_DELETED) and imports nothing else.
 */
import { inspectLibraryOperation } from './library-operation-lock.mjs'
import { isPlanDigest } from './media-digest.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { MEDIA_KINDS, assetsOfPaths, createMediaService, releaseImageFiles } from './media-service.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { storeFailureResponse, storeProtocolOf, storeRequestKind } from './store-session.mjs'
import { handleV2Upload } from './v2-media-store.mjs'
import { V2WriteError, errorBody } from '../src/data/editor/errors.ts'

const withDetails = (code, lines, status = 400) => {
  const body = errorBody(new V2WriteError(code))
  return { status, body: lines.length ? { ...body, details: lines.join('\n') } : body }
}

/** The portable paths of an import request's `sourcePaths` (normalized like V2's), or a refusal. */
function explicitPathsOf(input, normalize) {
  if (!Array.isArray(input?.sourcePaths) || !input.sourcePaths.every((item) => typeof item === 'string')) return []
  try {
    return [...new Set(input.sourcePaths.map(normalize).filter(Boolean))].map((relative) => `MediaInbox/${relative}`)
  } catch {
    throw new V2WriteError('E_MEDIA_IMPORT_PATH_INVALID')
  }
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys, required = keys) => plain(value) && Object.keys(value).every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key))
const invalid = (reason) => new V2WriteError('E_REQUEST_INVALID', { reason })

/** A re-read scope from the page: `{ mediaId }` or `{ cityId }`, as the media service takes it. */
function rereadScopeOf(scope) {
  if (exactKeys(scope, ['mediaId']) && typeof scope.mediaId === 'string' && scope.mediaId) return { mediaIds: [scope.mediaId] }
  if (exactKeys(scope, ['cityId']) && typeof scope.cityId === 'string' && scope.cityId) return { cityId: scope.cityId }
  throw invalid('重新读取说明的范围要么是一条媒体（mediaId），要么是一个城市（cityId）。')
}

/** The portable path of a re-import request's `path` (normalized like an import's), or a refusal. */
function reimportPathOf(value, normalize) {
  if (typeof value !== 'string' || !value) throw invalid('要重新导入的文件路径无效。')
  let relative
  try { relative = normalize(value) } catch { throw new V2WriteError('E_MEDIA_IMPORT_PATH_INVALID') }
  if (!relative) throw new V2WriteError('E_MEDIA_IMPORT_PATH_INVALID')
  return `MediaInbox/${relative}`
}

/** A re-read plan as the page sees it: the records with changes, the others counted, conflicts and problems with reasons. */
function rereadPreviewBody(plan, scope) {
  const changed = plan.records.filter((record) => record.changes.length)
  return {
    ok: true, libraryId: plan.libraryId, revision: plan.revision, planDigest: plan.digest, scope,
    records: changed.map((record) => ({
      mediaId: record.assetId, cityId: record.placeId ?? null, changes: record.diff,
      sources: record.sourceFacts.map(({ path, sha256, descriptionDigest }) => ({ path, sha256, descriptionDigest })),
    })),
    unchanged: plan.records.length - changed.length,
    registryOnly: plan.records.filter((record) => !record.changes.length && record.seqs.length).length,
    withoutSource: plan.withoutSource.length,
    conflicts: plan.conflicts.map((conflict) => ({ mediaId: conflict.assetId, sources: conflict.sources.map(({ path, descriptionDigest }) => ({ path, descriptionDigest })) })),
    problems: plan.problems.map((problem) => ({ mediaId: problem.assetId, path: problem.path, reason: problem.reason, detail: problem.line })),
  }
}

/** The answer of one preview route (see handleStoreMediaPreview). */
async function previewBody(routeName, service, input, deps) {
  if (routeName === 'reread-preview') {
    if (!exactKeys(input, ['scope'])) throw invalid('请求只能有 scope。')
    return rereadPreviewBody(await service.planReread({ scope: rereadScopeOf(input.scope) }), input.scope)
  }
  if (routeName === 'reimport-candidates') {
    if (!exactKeys(input ?? {}, ['cityId'], []) || (input?.cityId !== undefined && (typeof input.cityId !== 'string' || !input.cityId))) throw invalid('请求只能有 cityId。')
    const listed = await service.listReimportable({ cityId: input?.cityId })
    return {
      ok: true, libraryId: listed.libraryId, revision: listed.revision, scannedFiles: listed.scannedFiles, hashedFiles: listed.hashedFiles,
      candidates: listed.candidates.map(({ relativePath, cityId, kind, bytes, sha256, reason, pendingDeletion }) => ({ path: relativePath, cityId, kind, bytes, sha256, reason, pendingDeletion })),
      otherCities: listed.otherCities,
    }
  }
  if (!exactKeys(input, ['path'])) throw invalid('请求只能有 path。')
  const preview = await service.planReimport({ paths: [reimportPathOf(input.path, deps.normalizeInboxRelativePath)] })
  const [file] = preview.files
  return {
    ok: true, libraryId: preview.libraryId, revision: preview.revision, planDigest: preview.digest,
    file: { path: file.path, sha256: file.sha256, bytes: file.bytes, reason: file.reason, pendingDeletion: file.pendingDeletion },
    record: preview.records[0] ? { cityId: preview.records[0].cityId, kind: preview.records[0].kind, title: preview.records[0].title, date: preview.records[0].date, reusesFiles: preview.records[0].reusesFiles, orderPosition: 'end' } : null,
    otherNewFiles: preview.otherNewFiles,
    blockers: { errors: preview.blockers.errors, uncertain: preview.blockers.uncertain },
    folderBindings: preview.pins.map((pin) => ({ folder: pin.folder.slice('MediaInbox/'.length), placeId: pin.placeId, names: pin.names ?? {} })),
  }
}

/**
 * A preview route of 3C-5 F (`routeName`: reread-preview | reimport-candidates | reimport-preview): it only reads, so
 * the plugin calls it without the library lease and without the protocol headers, as a media task's preview. Refused
 * while a media task is unfinished (409 E_MEDIA_JOB_PENDING) or an operation holds the lease (409 E_LIBRARY_BUSY); when
 * an operation ran meanwhile (the lease's generation moved), 409 E_MEDIA_PREVIEW_STALE: preview again. A write always
 * computes its plan again under the lease, so a preview never needs to hold it. Resolves { status, body }.
 */
export async function handleStoreMediaPreview({ routeName, privatePaths, mediaStore, input, deps }) {
  releaseImageFiles()
  try {
    await assertMediaJobsClear(privatePaths)
    const before = await inspectLibraryOperation(privatePaths)
    if (before.state !== 'idle') throw new V2WriteError('E_LIBRARY_BUSY')
    const body = await previewBody(routeName, createMediaService({ privatePaths, store: mediaStore }), input, deps)
    const after = await inspectLibraryOperation(privatePaths)
    if (after.state !== 'idle' || after.generation !== before.generation) throw new V2WriteError('E_MEDIA_PREVIEW_STALE')
    return { status: 200, body }
  } catch (error) {
    const failure = storeFailureResponse(error)
    return error?.code === 'E_MEDIA_JOB_PENDING' ? { ...failure, status: 409 } : failure
  }
}

/**
 * One media endpoint (`routeName`: upload | import | delete | reread | reimport) on the new library. `mediaStore` is the session's
 * mediaStore(); `deps` the plugin's helpers (as for V2: safeSegment, reserveDestination, writeUpload, updateDroneSidecar,
 * normalizeInboxRelativePath). Resolves { status, body }.
 */
export async function handleStoreMediaRoute({ routeName, privatePaths, mediaStore, query, request, input, headers, deps, leaseToken, allocateId }) {
  // An upload decodes the file with sharp too: no Inbox file stays open (see releaseImageFiles).
  releaseImageFiles()
  // 3C-5 E: the upload target from the official reader (read at once by handleV2Upload, before any other await).
  if (routeName === 'upload') return handleV2Upload({ privatePaths, query, request, deps, reader: (await mediaStore.official()).reader })
  const protocol = storeProtocolOf(headers)
  if (protocol.failure) return protocol.failure
  const service = createMediaService({ privatePaths, store: mediaStore, ...(allocateId ? { allocateId } : {}) })
  try {
    if (routeName === 'import') {
      const explicitPaths = explicitPathsOf(input, deps.normalizeInboxRelativePath)
      const explicitKeys = explicitPaths.map((value) => pathKeyOf(value))
      const result = await service.importInbox({
        requestId: protocol.requestId, baseRevision: protocol.baseRevision, leaseToken, explicitPaths, blockOnWarnings: true,
        kind: storeRequestKind(MEDIA_KINDS.import, input ?? null), acceptSourceMatches: input?.acceptSourceMatches === true,
        // An uploaded path the scan does not find (removed meanwhile) would give no record: refused before anything is
        // written (V2 found out after its import, with the same code).
        expect: (plan) => {
          const scanned = new Set(plan.scan.facts.map((fact) => fact.pathKey))
          if (!plan.blocked && explicitKeys.some((key) => !scanned.has(key))) throw new V2WriteError('E_MEDIA_IMPORT_NO_RECORD')
        },
      })
      if (result.duplicate) {
        return {
          status: 200,
          body: { ok: true, output: '这个导入请求已经完成。', restoredMediaIds: assetsOfPaths(mediaStore, explicitKeys), revision: result.revision, duplicate: true, receipt: result.receipt },
        }
      }
      if (result.blocked) {
        const lines = service.reportLines(result.plan)
        const { blockers } = result.plan
        if (blockers.errors.length || blockers.uncertain.length || blockers.bindings.length) return withDetails('E_MEDIA_IMPORT_BLOCKED', lines)
        return withDetails('E_MEDIA_SOURCE_MATCHES_UNCONFIRMED', lines, 409)
      }
      const restoredMediaIds = assetsOfPaths(mediaStore, explicitKeys, result.created)
      return {
        status: 200,
        body: {
          ok: true, output: service.reportLines(result.plan).join('\n'), restoredMediaIds, revision: result.revision, duplicate: false,
          deletedSkipped: result.plan.classification.deletedSkips.length, ...(result.receipt ? { receipt: result.receipt } : {}),
        },
      }
    }
    if (routeName === 'reread') {
      if (!exactKeys(input, ['scope', 'planDigest'])) throw invalid('请求只能有 scope 和 planDigest。')
      const scope = rereadScopeOf(input.scope)
      if (!isPlanDigest(input.planDigest)) throw invalid('预览摘要必须是 64 位小写十六进制。')
      const result = await service.rereadDescriptions({
        scope, planDigest: input.planDigest, requestId: protocol.requestId, baseRevision: protocol.baseRevision, leaseToken,
        kind: storeRequestKind(MEDIA_KINDS.reread, input), actor: 'local-editor',
      })
      if (result.duplicate) return { status: 200, body: { ok: true, duplicate: true, revision: result.revision, receipt: result.receipt, updatedMediaIds: [] } }
      return {
        status: 200,
        body: { ok: true, duplicate: false, revision: result.revision, updatedMediaIds: result.updatedIds, ...(result.receipt ? { receipt: result.receipt } : {}) },
      }
    }
    if (routeName === 'reimport') {
      if (!exactKeys(input, ['path', 'planDigest', 'acceptFolderBindings'], ['path', 'planDigest'])
        || (input.acceptFolderBindings !== undefined && typeof input.acceptFolderBindings !== 'boolean')) throw invalid('请求只能有 path、planDigest 和 acceptFolderBindings。')
      const portable = reimportPathOf(input.path, deps.normalizeInboxRelativePath)
      if (!isPlanDigest(input.planDigest)) throw invalid('预览摘要必须是 64 位小写十六进制。')
      const keys = [pathKeyOf(portable)]
      const result = await service.reimportFiles({
        paths: [portable], planDigest: input.planDigest, requestId: protocol.requestId, baseRevision: protocol.baseRevision, leaseToken,
        kind: storeRequestKind(MEDIA_KINDS.reimport, input), actor: 'local-editor', acceptFolderBindings: input.acceptFolderBindings === true,
      })
      if (result.duplicate) return { status: 200, body: { ok: true, duplicate: true, revision: result.revision, receipt: result.receipt, mediaIds: assetsOfPaths(mediaStore, keys) } }
      if (result.blocked) {
        const { blockers } = result.plan
        if (blockers.errors.length || blockers.uncertain.length) return withDetails('E_MEDIA_IMPORT_BLOCKED', [...blockers.errors, ...blockers.uncertain])
        return withDetails('E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED', [], 409)
      }
      return {
        status: 200,
        body: { ok: true, duplicate: false, revision: result.revision, mediaIds: assetsOfPaths(mediaStore, keys, result.created), ...(result.receipt ? { receipt: result.receipt } : {}) },
      }
    }
    const result = await service.deleteMedia({ input, requestId: protocol.requestId, baseRevision: protocol.baseRevision, leaseToken, kind: storeRequestKind(MEDIA_KINDS.delete, input ?? null) })
    if (result.duplicate) {
      const deletedIds = Array.isArray(input?.ids) ? input.ids.filter((id) => typeof id === 'string') : []
      return { status: 200, body: { ok: true, deletedIds, deletedSourceFiles: 0, output: '这个删除请求已经完成。', revision: result.revision, receipt: result.receipt, duplicate: true } }
    }
    const { drained } = result
    const output = [
      `已彻底删除 ${result.deletedIds.length} 条媒体；删除了 ${drained.deletedSources} 个源文件、${drained.deletedDirectories} 个生成目录。`,
      ...(drained.paused ? ['备份正在复制媒体，文件的删除已登记，备份完成后的下一次媒体操作会完成它。'] : []),
      ...(drained.kept && !drained.paused ? [`有 ${drained.kept} 个文件暂时删不掉（被占用），已登记，下一次媒体操作会再试。`] : []),
    ].join('\n')
    return {
      status: 200,
      body: { ok: true, deletedIds: result.deletedIds, deletedSourceFiles: drained.deletedSources, output, revision: result.revision, receipt: result.receipt, duplicate: false },
    }
  } catch (error) {
    return storeFailureResponse(error)
  }
}
