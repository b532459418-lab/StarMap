/**
 * V2 数据模式下本地编辑接口的 IO 层（RFC-LOC-1 PR3b-2 规格 §2.1）。
 *
 * 为什么单独成文件：理由同 want-to-go-store.mjs —— 插件在模块顶层 import sharp / undici / world-countries
 * 并解析私有资料层路径，无法在 node --test 下加载。这里只做插件的四件事，端到端测试（v2-editor-store.test.mjs）
 * 因此能在临时私人根上跑真实的读写：
 *
 *   1. 读 `data/v2/` 的五个文件（缺的为 undefined，由纯函数按空处理）——【绝不】读旧文件或样例；
 *   2. 调用纯函数（src/data/v2write/）；
 *   3. 按 `writes` 的顺序逐个用 `atomicJsonWrite` 写盘（保留 `.bak`，先写临时文件再改名）；
 *   4. 回写响应：成功 `{ ok: true, ...result }`，失败 `{ ok: false, error, code, params? }`（MSG-2 过渡形态）。
 *
 * 写盘中途失败：第一步就失败时什么都没写，原样报原因（E_WRITE_FAILED）；之后的步骤失败时，
 * 有说明模板的用模板（E_PARTIAL_WRITE，旧模式「足迹已创建，但……」一类），没有的原样报原因并列出已写的文件。
 * 纯函数保证写盘顺序：任何一步停下，都不会留下「引用了不存在的地点」。
 */

import { atomicJsonWrite, readJson } from './json-file.mjs'
import { V2_PRIVATE_FILE_KEYS } from './local-editor-data-mode.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import {
  V2WriteError,
  addCountry,
  addTravelRecord,
  addWantToGo,
  convertToTravel,
  deleteHiddenCountries,
  deleteHiddenWantToGo,
  errorBody,
  putEditorState,
  readEditorStateV1,
  updateWantToGo,
} from '../src/data/v2write/index.ts'

/**
 * V2 模式下开放的 8 个写入端点 → 纯函数与成功时的状态码（与旧模式相同）。媒体端点（上传、导入、删除）不在这里：
 * 它们在 V2 下由 local-editor-data-mode.mjs 的 editorDataModeRejection 返回 409（PR3b-3 开放）。
 */
export const V2_EDITOR_ROUTES = Object.freeze({
  'PUT /__travelatlas/editor/state': Object.freeze({ run: putEditorState, status: 200 }),
  'POST /__travelatlas/editor/records': Object.freeze({ run: addTravelRecord, status: 201 }),
  'POST /__travelatlas/editor/countries': Object.freeze({ run: addCountry, status: 201 }),
  'POST /__travelatlas/editor/countries/delete': Object.freeze({ run: deleteHiddenCountries, status: 200 }),
  'POST /__travelatlas/editor/wanttogo': Object.freeze({ run: addWantToGo, status: 201 }),
  'POST /__travelatlas/editor/wanttogo/update': Object.freeze({ run: updateWantToGo, status: 200 }),
  'POST /__travelatlas/editor/wanttogo/delete': Object.freeze({ run: deleteHiddenWantToGo, status: 200 }),
  'POST /__travelatlas/editor/wanttogo/convert': Object.freeze({ run: convertToTravel, status: 200 }),
})

/** V2 模式下这个请求对应的写入；不是这 8 个之一时为 undefined（插件回 404，不进入任何旧分支）。 */
export const v2EditorRoute = (method, pathname) => V2_EDITOR_ROUTES[`${method} ${pathname}`]

/** 错误响应体（`{ ok: false, error, code, params? }`）。 */
export const v2ErrorBody = (code, params) => errorBody(new V2WriteError(code, params))

/**
 * 写入上下文：`now` 与 `newId` 默认取当前时间与 UUIDv7。`countryCatalog` 是插件的国家目录（键为大写 ISO）。
 */
export const createV2WriteContext = ({ countryCatalog, now = new Date(), newId = () => uuidv7() }) => ({ countryCatalog, now, newId })

/** 读 `data/v2/` 的五个文件；缺的为 undefined。不读任何旧文件。 */
export const readV2Files = async (privatePaths) => Object.fromEntries(await Promise.all(
  V2_PRIVATE_FILE_KEYS.map(async (key) => [key, await readJson(privatePaths.v2FilePaths[key], undefined)]),
))

const reasonOf = (error) => (error instanceof Error ? error.message : String(error ?? '未知错误'))

/** 「……（原因）。」里的原因：去掉末尾句号，避免叠成「。）。」（同旧模式 conversionFailureReason）。 */
const bracketReason = (error) => reasonOf(error).replace(/[。.]$/, '')

const isV2WriteError = (error) => error instanceof V2WriteError
  || (error?.name === 'V2WriteError' && typeof error?.code === 'string')

/** 纯函数抛出的错误 → 400 响应。意料之外的错误（程序缺陷）也不吞掉原因。 */
const failureResponse = (error) => ({
  status: 400,
  body: isV2WriteError(error) ? errorBody(error) : v2ErrorBody('E_UNEXPECTED', { reason: reasonOf(error) }),
})

/**
 * 执行一个 V2 写入：读 → 纯函数 → 按顺序写 → 响应。返回 `{ status, body }`。
 * `write` 可注入（测试用），默认 atomicJsonWrite。
 */
export async function runV2Write({ privatePaths, route, input, ctx, write = atomicJsonWrite }) {
  const files = await readV2Files(privatePaths)
  let outcome
  try {
    outcome = route.run(files, input, ctx)
  } catch (error) {
    return failureResponse(error)
  }

  const written = []
  for (const step of outcome.writes) {
    try {
      await write(privatePaths.v2FilePaths[step.file], step.value)
    } catch (error) {
      const params = { written: [...written], failed: step.file, reason: reasonOf(error) }
      if (written.length > 0 && typeof step.onFailure === 'string') {
        return { status: 400, body: v2ErrorBody('E_PARTIAL_WRITE', { ...params, message: step.onFailure.replace('{reason}', bracketReason(error)) }) }
      }
      return { status: 400, body: v2ErrorBody('E_WRITE_FAILED', params) }
    }
    written.push(step.file)
  }
  return { status: route.status, body: { ok: true, ...outcome.result } }
}

/** GET /editor/state（V2）：`{ ok: true, state }`（V1 形状），失败为 400。 */
export async function readV2EditorState({ privatePaths, now = new Date() }) {
  const files = await readV2Files(privatePaths)
  try {
    return { status: 200, body: { ok: true, state: readEditorStateV1(files, now) } }
  } catch (error) {
    return failureResponse(error)
  }
}
