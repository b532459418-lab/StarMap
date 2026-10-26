/**
 * 本地编辑器媒体上传的 IO 层（RFC-LOC-1 PR3b-3 规格 §2.4；第 2D 批）与三个媒体端点的路由表。
 *
 * 为什么单独成文件：插件在模块顶层 import sharp / undici / world-countries 并解析私有资料层路径，
 * 无法在 node --test 下加载。插件里的辅助函数（safeSegment、reserveDestination、writeUpload、updateDroneSidecar）经 `deps`
 * 传进来复用，所以文件名规则、上传大小与图片校验、无人机 sidecar 的写法都与旧模式相同。
 *
 * 3C-4d：个人数据只写新库。三个媒体端点由新库处理（./store-media-endpoints.mjs，3C-4c）；上传与媒体任务的接收仍用这里选
 * 收件箱文件夹、接收文件，调用方传入新库的官方读取器（`reader`，3C-5 E：只用它查地点），这里不读 data/v2/。V2 的导入与彻底删除（运行导入器、
 * 改写 data/v2/ 的目录、索引与 editor-state）已删除。
 *
 * 判断在纯函数里（src/data/v2media/editorWrites.ts）；这里只做 IO：
 *
 * - 上传：目标（城市地点 id，countryId 必须是它的 partOf）→ 收件箱 `MediaInbox/<国家显示名>/<城市显示名>/photos|drone/`
 *   → 选文件夹（第 2D 批）：只用 place.json 已指向这个地点的文件夹，或新建一个；显示名的文件夹被别的地点占用（place.json 指向
 *   别处）或是手放的（没有 place.json，上传不认领）时，改用 `<显示名> (<地点 id 后缀>)`，再不行依次用 `… 2` 到 `… 9`；全都
 *   不能用才报错、不写文件 → 接收文件 → 给新建的文件夹写 place.json → 无人机 sidecar。
 *
 * 响应：成功时与旧模式相同的形状；失败为 `{ ok: false, error, code, params?, details? }`（PR3b-2 的形态）。
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'

import { atomicJsonWrite, readJson } from './json-file.mjs'
import { editorErrorBody } from './local-editor-errors.mjs'
import {
  droneUploadMetadataOf,
  inboxFolderCandidates,
  pickInboxFolder,
  uploadKindOf,
  uploadTargetOf,
} from '../src/data/v2media/editorWrites.ts'
import { placeConfigOf } from '../src/data/v2media/importPlan.ts'
import { V2WriteError, errorBody } from '../src/data/editor/errors.ts'

/** 三个媒体端点 → 处理方式。与 store-session.mjs 的 STORE_WRITE_ROUTES（8 个编辑端点）不相交。 */
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
 * 错误 → 400 响应。V2WriteError 按码；辅助函数抛的普通错误（文案是给用户看的）归到 `fallbackCode`，原因原样。
 * 带 `details` 时一并返回。
 */
const failureResponse = (error, fallbackCode) => {
  const body = isV2WriteError(error) ? errorBody(error) : editorErrorBody(fallbackCode, { reason: reasonOf(error) })
  const details = typeof error?.details === 'string' ? error.details : undefined
  return { status: 400, body: details ? { ...body, details } : body }
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
 * 在 `parentDirectory` 下为地点 `placeId` 选收件箱文件夹（§2.4；第 2D 批）：候选见 `inboxFolderCandidates`
 * （显示名、`<显示名> (<地点 id 后缀>)`、再加数字，都经 safeSegment）。place.json 已指向这个地点的优先；没有就用第一个
 * 不存在的，新建并写 place.json。手放的文件夹（存在但没有 place.json）只读不写：既不写 place.json，也不往里放文件，
 * 它属于哪个地点由导入时的文件夹绑定确认决定（第 2A 批）。
 * 文件系统不分大小写时（Windows），只差大小写的同名文件夹就是同一个文件夹，同样按它的 place.json 判断。
 * 返回 `{ name, claim }`，`claim` 为 true 表示要写入 place.json。候选全都不能用 → E_MEDIA_FOLDER_CONFLICT。
 */
const chooseInboxFolder = async (parentDirectory, parentLabel, displayName, placeId, label, deps) => {
  const candidates = []
  // safeSegment 最多保留 120 个字符：显示名很长时，几个候选截断后可能同名，同一个文件夹只看一次。
  const names = [...new Set(inboxFolderCandidates(displayName, placeId).map((candidate) => deps.safeSegment(candidate, label)))]
  for (const name of names) {
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
 * `query` 是请求的查询参数（URLSearchParams），`reader` 是新库的官方读取器（3C-5 E：上传目标的地点从它读，在第一个 await
 * 之前读完；3C-4d 起必须传入）。返回 `{ kind, target, cityRoot, claims, destination, droneMetadata }`，什么都不写。
 */
export async function prepareV2Upload({ privatePaths, query, deps, reader }) {
    if (!reader) throw new V2WriteError('E_STORE_MIGRATION_REQUIRED')
    const kind = uploadKindOf(query)
    const target = uploadTargetOf(reader, { countryId: query.get('countryId') ?? '', cityId: query.get('cityId') ?? '' })
    // 先选国家文件夹，再在它下面选城市文件夹，两级同一套规则：显示名的文件夹被别的地点占用、或是手放的时，
    // 改用带地点 id 后缀的名字（第 2D 批：手放的国家文件夹同样不认领，上传会新建 `<国家名> (<后缀>)`）。
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

    return { kind, target, cityRoot, claims, destination, droneMetadata }
}

/**
 * 上传一个文件（新库的上传端点用，./store-media-endpoints.mjs）：`request` 是文件内容的流，交给 deps.writeUpload。
 * 成功：201 `{ ok, fileName, bytes, sourcePath }`（同旧）。
 */
export async function handleV2Upload({ privatePaths, query, request, deps, reader }) {
  try {
    const { kind, cityRoot, claims, destination, droneMetadata } = await prepareV2Upload({ privatePaths, query, deps, reader })
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
