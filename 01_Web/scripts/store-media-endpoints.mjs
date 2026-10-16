/**
 * The three media endpoints in the new-library mode (3C-4c, design v2 §3 and §4): upload, import, and deletion of hidden
 * media. The plugin calls them under the library lease (its `leaseToken`), after checking that no media task is
 * unfinished and that the store is not read-only. Kept apart from the plugin so the tests drive them on temporary roots.
 *
 * - Upload writes only the Inbox (the file, a new folder's place.json, a drone sidecar entry), exactly as in V2; the
 *   place registry comes from the store's view. It commits nothing.
 * - Import and deletion are store writes with the client protocol of 3C-3 (x-starmap-request-id, x-starmap-base-revision).
 *   A retried request answers with its receipt. Import: the paths in `sourcePaths` (what the page just uploaded) are
 *   explicit additions (review §8-3); the rest of the Inbox is scanned. Source matches that need confirming refuse the
 *   import (409 E_MEDIA_SOURCE_MATCHES_UNCONFIRMED) unless the body says `acceptSourceMatches: true`; folder bindings
 *   and uncertain information refuse it as in V2 (400 E_MEDIA_IMPORT_BLOCKED, the report in `details`).
 * Responses keep V2's shapes ({ ok, output, restoredMediaIds } / { ok, deletedIds, deletedSourceFiles, output }) plus the
 * revision and the receipt, so the page moves its base revision forward.
 */
import { MEDIA_KINDS, createMediaService, releaseImageFiles } from './media-service.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { storeFailureResponse, storeProtocolOf, storeRequestKind } from './store-session.mjs'
import { handleV2Upload } from './v2-media-store.mjs'
import { V2WriteError, errorBody } from '../src/data/v2write/errors.ts'

const withDetails = (code, lines, status = 400) => {
  const body = errorBody(new V2WriteError(code))
  return { status, body: lines.length ? { ...body, details: lines.join('\n') } : body }
}

/**
 * The asset of each explicit path (deduplicated, in order): the record created for it now, otherwise the record its
 * present source names (a file already imported, a retried request). V2 answered with the media of these paths too.
 */
function restoredIdsOf(explicitKeys, created, mediaStore) {
  const { sources } = mediaStore.mediaRegistry()
  const assetOf = new Map(mediaStore.mediaEntities().map((row) => [row.id, row.fields.asset]))
  const ids = []
  for (const key of explicitKeys) {
    const made = created?.get(key)?.assetId
    const source = made ? undefined : sources.find((item) => item.pathKey === key && item.state === 'present')
    const id = made ?? (source ? assetOf.get(source.recordId) : undefined)
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
  }
  return ids
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

/**
 * One media endpoint (`routeName`: upload | import | delete) on the new library. `mediaStore` is the session's
 * mediaStore(); `deps` the plugin's helpers (as for V2: safeSegment, reserveDestination, writeUpload, updateDroneSidecar,
 * normalizeInboxRelativePath). Resolves { status, body }.
 */
export async function handleStoreMediaRoute({ routeName, privatePaths, mediaStore, query, request, input, headers, deps, leaseToken, now, allocateId }) {
  // An upload decodes the file with sharp too: no Inbox file stays open (see releaseImageFiles).
  releaseImageFiles()
  if (routeName === 'upload') return handleV2Upload({ privatePaths, query, request, deps, files: (await mediaStore.view()).files })
  const protocol = storeProtocolOf(headers)
  if (protocol.failure) return protocol.failure
  const service = createMediaService({ privatePaths, store: mediaStore, ...(now ? { now } : {}), ...(allocateId ? { allocateId } : {}) })
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
          body: { ok: true, output: '这个导入请求已经完成。', restoredMediaIds: restoredIdsOf(explicitKeys, undefined, mediaStore), revision: result.revision, duplicate: true, receipt: result.receipt },
        }
      }
      if (result.blocked) {
        const lines = service.reportLines(result.plan)
        const { blockers } = result.plan
        if (blockers.errors.length || blockers.uncertain.length || blockers.bindings.length) return withDetails('E_MEDIA_IMPORT_BLOCKED', lines)
        return withDetails('E_MEDIA_SOURCE_MATCHES_UNCONFIRMED', lines, 409)
      }
      const restoredMediaIds = restoredIdsOf(explicitKeys, result.created, mediaStore)
      return {
        status: 200,
        body: { ok: true, output: service.reportLines(result.plan).join('\n'), restoredMediaIds, revision: result.revision, duplicate: false, ...(result.receipt ? { receipt: result.receipt } : {}) },
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
