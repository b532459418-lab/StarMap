/**
 * 本地编辑器三个媒体端点的 IO 层（RFC-LOC-1 PR3b-3 规格 §2.4）：上传、导入、彻底删除隐藏媒体。
 *
 * 为什么单独成文件：理由同 v2-editor-store.mjs——插件在模块顶层 import sharp / undici / world-countries 并解析私有资料层路径，
 * 无法在 node --test 下加载。插件把三个媒体端点交给这里（PR5a 起旧格式的上传、导入、删除逻辑已删除）。
 * 插件里的辅助函数（safeSegment、reserveDestination、writeUpload、updateDroneSidecar、runImporter、
 * normalizeInboxRelativePath、removeSidecarEntries、isPathInside）经 `deps` 传进来复用，所以
 * 文件名规则、上传大小与图片校验、无人机 sidecar 的写法、导入器的预检判断都与 PR3b-3 之前的旧模式相同。
 *
 * 判断在纯函数里（src/data/v2media/editorWrites.ts）；这里只做 IO：
 *
 * - 上传：目标（城市地点 id，countryId 必须是它的 partOf）→ 收件箱 `MediaInbox/<国家显示名>/<城市显示名>/photos|drone/`
 *   → 选文件夹：显示名的文件夹已被别的地点占用（place.json 指向别处）时改用 `<显示名> (<地点 id 后缀>)`，两个都被占用才报错、
 *   不写文件 → 接收文件 → 给新用上的文件夹写 place.json → 无人机 sidecar。
 * - 导入：运行导入器（先预检、后应用，同旧）→ 按 V2 源文件索引恢复新导入条目的隐藏状态并追加进排序表（editor-state 走
 *   PR3b-2 的事务与完整性检查）。
 * - 删除：只能删该城市里已隐藏的照片或无人机影像 → 先算好 editor-state 的清理（事务，含完整性检查）→ 删源文件、sidecar 条目、
 *   内容寻址的生成目录（media/user/<哈希>/）→ 写 editor-state → 重新运行导入器。
 *
 * 响应：成功时与旧模式相同的形状；失败为 `{ ok: false, error, code, params?, details? }`（PR3b-2 的形态）。
 */

import { rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { atomicJsonWrite, readJson } from './json-file.mjs'
import { applyV2Writes, readV2Files, v2ErrorBody } from './v2-editor-store.mjs'
import {
  deletableMediaOf,
  droneUploadMetadataOf,
  generatedDirectoriesOf,
  idsMissingFromSourceIndex,
  inboxFolderCandidates,
  mediaSourcesOf,
  pickInboxFolder,
  removeMediaFromEditorState,
  restoreImportedMedia,
  uploadKindOf,
  uploadTargetOf,
} from '../src/data/v2media/editorWrites.ts'
import { placeConfigOf } from '../src/data/v2media/importPlan.ts'
import { V2WriteError, errorBody } from '../src/data/v2write/errors.ts'

/** V2 下的三个媒体端点 → 处理方式。与 v2-editor-store.mjs 的 V2_EDITOR_ROUTES 不相交，两者合起来是全部 11 个写入端点。 */
export const V2_MEDIA_ROUTES = Object.freeze({
  'POST /__travelatlas/editor/upload': 'upload',
  'POST /__travelatlas/editor/import': 'import',
  'POST /__travelatlas/editor/media/delete': 'delete',
})

/** 这个请求是不是媒体端点；是则返回 'upload' | 'import' | 'delete'。 */
export const v2MediaRoute = (method, pathname) => V2_MEDIA_ROUTES[`${method} ${pathname}`]

const UPLOAD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif'])

const reasonOf = (error) => (error instanceof Error ? error.message : String(error ?? '未知错误'))

const isV2WriteError = (error) => error instanceof V2WriteError
  || (error?.name === 'V2WriteError' && typeof error?.code === 'string')

/**
 * 错误 → 400 响应。V2WriteError 按码；旧模式辅助函数抛的普通错误（文案是给用户看的）归到 `fallbackCode`，原因原样。
 * 导入器预检被拦下时带上 `details`（导入器的完整输出，同旧模式）。
 */
const failureResponse = (error, fallbackCode) => {
  const body = isV2WriteError(error) ? errorBody(error) : v2ErrorBody(fallbackCode, { reason: reasonOf(error) })
  const details = typeof error?.details === 'string' ? error.details : undefined
  return { status: 400, body: details ? { ...body, details } : body }
}

/** 导入器已带码的错误原样保留；其它失败保留原因与诊断，不能从 details 或文案推断预检阻断。 */
const runImporterOrFail = async (deps) => {
  try {
    return await deps.runImporter()
  } catch (error) {
    if (isV2WriteError(error)) throw error
    const failure = new V2WriteError('E_MEDIA_IMPORT_FAILED', { reason: reasonOf(error) })
    if (typeof error?.details === 'string') failure.details = error.details
    throw failure
  }
}

/** 收件箱控制文件的内容：不存在为 undefined；读不出（不是 JSON）时按「内容无效」处理（null）。 */
const readControlFile = async (target) => {
  try {
    return await readJson(target, undefined)
  } catch {
    return null
  }
}

const inboxRelative = (inboxRoot, target) => path.relative(inboxRoot, target).split(path.sep).join('/')

const directoryExists = async (target) => {
  try {
    return (await stat(target)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * 在 `parentDirectory` 下为地点 `placeId` 选收件箱文件夹（§2.4）：候选是显示名与 `<显示名> (<地点 id 后缀>)`
 * （都经 safeSegment）；按顺序取第一个不存在、没有 place.json、或 place.json 已指向这个地点的。
 * 文件系统不分大小写时（Windows），只差大小写的同名文件夹就是同一个文件夹，同样按它的 place.json 判断。
 * 返回 `{ name, claim }`，`claim` 为 true 表示要写入 place.json。候选都被占用 → E_MEDIA_FOLDER_CONFLICT。
 */
const chooseInboxFolder = async (parentDirectory, parentLabel, displayName, placeId, label, deps) => {
  const candidates = []
  for (const name of inboxFolderCandidates(displayName, placeId).map((candidate) => deps.safeSegment(candidate, label))) {
    const directory = path.join(parentDirectory, name)
    const state = await directoryExists(directory)
      ? { exists: true, placeConfig: await readControlFile(path.join(directory, 'place.json')) }
      : { exists: false }
    candidates.push({ name, label: parentLabel ? `${parentLabel}/${name}` : name, state })
  }
  return pickInboxFolder(placeId, candidates)
}

// ---------------------------------------------------------------------------
// POST /upload
// ---------------------------------------------------------------------------

/**
 * `query` 是请求的查询参数（URLSearchParams），`request` 是请求本身（文件内容的流，交给 deps.writeUpload）。
 * 成功：201 `{ ok, fileName, bytes, sourcePath }`（同旧）。
 */
export async function handleV2Upload({ privatePaths, query, request, deps, now = new Date() }) {
  try {
    const kind = uploadKindOf(query)
    const files = await readV2Files(privatePaths)
    const target = uploadTargetOf(files, { countryId: query.get('countryId') ?? '', cityId: query.get('cityId') ?? '' }, now)
    // 先选国家文件夹，再在它下面选城市文件夹：显示名已被别的地点占用时改用带地点 id 后缀的名字。
    const country = await chooseInboxFolder(privatePaths.inboxRoot, '', target.countryFolderName, target.country.id, '国家名', deps)
    const countryRoot = path.join(privatePaths.inboxRoot, country.name)
    const city = await chooseInboxFolder(countryRoot, country.name, target.cityFolderName, target.city.id, '城市名', deps)
    const cityRoot = path.join(countryRoot, city.name)
    const claims = [
      ...(country.claim ? [{ file: path.join(countryRoot, 'place.json'), value: placeConfigOf(target.country.id) }] : []),
      ...(city.claim ? [{ file: path.join(cityRoot, 'place.json'), value: placeConfigOf(target.city.id) }] : []),
    ]

    const destination = await deps.reserveDestination(path.join(cityRoot, kind === 'photo' ? 'photos' : 'drone'), query.get('fileName') ?? '')
    if (!UPLOAD_EXTENSIONS.has(path.extname(destination).toLowerCase())) throw new V2WriteError('E_MEDIA_EXTENSION')
    const droneMetadata = kind === 'photo' ? undefined : droneUploadMetadataOf(query, kind, target.cityFolderName)

    const imageMetadata = await deps.writeUpload(request, destination, kind)
    for (const claim of claims) await atomicJsonWrite(claim.file, claim.value)
    if (droneMetadata) await deps.updateDroneSidecar(cityRoot, destination, droneMetadata, imageMetadata)

    const fileStats = await stat(destination)
    return {
      status: 201,
      body: { ok: true, fileName: path.basename(destination), bytes: fileStats.size, sourcePath: inboxRelative(privatePaths.inboxRoot, destination) },
    }
  } catch (error) {
    return failureResponse(error, 'E_MEDIA_UPLOAD_REJECTED')
  }
}

// ---------------------------------------------------------------------------
// POST /import
// ---------------------------------------------------------------------------

/** `input` 是请求体（`{ sourcePaths }`）。成功：200 `{ ok, output, restoredMediaIds }`（同旧）。 */
export async function handleV2Import({ privatePaths, input, ctx, deps }) {
  try {
    let sourcePaths = []
    if (Array.isArray(input?.sourcePaths) && input.sourcePaths.every((item) => typeof item === 'string')) {
      try {
        sourcePaths = [...new Set(input.sourcePaths.map(deps.normalizeInboxRelativePath).filter(Boolean))]
      } catch {
        throw new V2WriteError('E_MEDIA_IMPORT_PATH_INVALID')
      }
    }
    const output = await runImporterOrFail(deps)
    const files = await readV2Files(privatePaths)
    const sourceIndex = await readJson(privatePaths.v2MediaSourceIndexPath, { sourcesById: {} })
    const outcome = restoreImportedMedia(files, { sourcePaths, sourceIndex }, ctx)
    const failure = await applyV2Writes({ privatePaths, writes: outcome.writes })
    if (failure) return failure
    return { status: 200, body: { ok: true, output, restoredMediaIds: outcome.result.restoredMediaIds } }
  } catch (error) {
    return failureResponse(error, 'E_UNEXPECTED')
  }
}

// ---------------------------------------------------------------------------
// POST /media/delete
// ---------------------------------------------------------------------------

/** `input` 是请求体（`{ cityId, ids }`）。成功：200 `{ ok, deletedIds, deletedSourceFiles, output }`（同旧）。 */
export async function handleV2MediaDelete({ privatePaths, input, ctx, deps }) {
  try {
    const files = await readV2Files(privatePaths)
    const { ids, items } = deletableMediaOf(files, input, ctx.now)

    let sourceIndex = await readJson(privatePaths.v2MediaSourceIndexPath, { sourcesById: {} })
    if (idsMissingFromSourceIndex(sourceIndex, ids).length > 0) {
      await runImporterOrFail(deps)
      sourceIndex = await readJson(privatePaths.v2MediaSourceIndexPath, { sourcesById: {} })
    }
    const sourcePaths = mediaSourcesOf(sourceIndex, ids).map((relativeSource) => {
      const sourcePath = path.resolve(privatePaths.inboxRoot, relativeSource)
      if (!deps.isPathInside(privatePaths.inboxRoot, sourcePath)) throw new V2WriteError('E_MEDIA_SOURCE_OUTSIDE_INBOX')
      return sourcePath
    })
    const generatedDirectories = generatedDirectoriesOf(items).map((directory) => {
      const target = path.resolve(privatePaths.userMediaRoot, directory)
      if (!deps.isPathInside(privatePaths.userMediaRoot, target)) throw new V2WriteError('E_MEDIA_GENERATED_OUTSIDE')
      return target
    })
    // 先算好 editor-state 的清理（含完整性检查）；通不过就什么都不删。
    const outcome = removeMediaFromEditorState(files, ids, ctx)

    let deletedSourceFiles = 0
    for (const sourcePath of new Set(sourcePaths)) {
      try {
        await unlink(sourcePath)
        deletedSourceFiles += 1
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    await deps.removeSidecarEntries(sourcePaths)
    for (const directory of generatedDirectories) await rm(directory, { recursive: true, force: true })

    const onFailure = '影像文件已删除，但编辑状态没有更新（{reason}）。请刷新页面后检查排序、隐藏与封面。'
    const failure = await applyV2Writes({ privatePaths, writes: outcome.writes.map((write) => ({ ...write, onFailure })), firstStepPartial: true })
    if (failure) return failure

    const output = await runImporterOrFail(deps)
    return { status: 200, body: { ok: true, deletedIds: ids, deletedSourceFiles, output } }
  } catch (error) {
    return failureResponse(error, 'E_UNEXPECTED')
  }
}
