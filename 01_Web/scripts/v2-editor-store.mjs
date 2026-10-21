/**
 * 8 个编辑端点的路由表与规则引擎的接线（RFC-LOC-1 PR3b-2 规格 §2.1；3C-4a 起新库用它作为规则引擎）。
 *
 * 3C-4d：个人数据只写新库。V2 的写盘（读 data/v2/ → 纯函数 → 按顺序 atomicJsonWrite）已删除；新库（./store-session.mjs）
 * 用这里的路由表（`route.run`，即 src/data/v2write/ 的纯函数）在新库的投影上算出写入，再提交到新库。这里还剩：
 *
 *   1. V2_EDITOR_ROUTES、v2EditorRoute：8 个编辑端点 → 纯函数与成功时的状态码；
 *   2. createV2WriteContext、v2FailureResponse、v2ErrorBody：写入上下文与错误响应（新库同样用）；
 *   3. readV2EditorState：私人根还没有迁移到新库时（只读），GET /editor/state 读 `data/v2/` 的五个文件（缺的为 undefined，
 *      由纯函数按空处理）——【绝不】读旧文件或样例。
 */

import { readJson } from './json-file.mjs'
import { V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
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
 * 8 个非媒体写入端点 → 纯函数与成功时的状态码（与旧模式相同）。三个媒体端点（上传、导入、删除）不在这里：
 * 它们的请求体与流程不同（上传的请求体是文件本身，导入与删除动收件箱与生成文件），路由表是 scripts/v2-media-store.mjs 的
 * V2_MEDIA_ROUTES，由新库的 ./store-media-endpoints.mjs 处理（3C-4c）。
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

/** 这个请求对应的写入；不是这 8 个之一时为 undefined（插件回 404）。 */
export const v2EditorRoute = (method, pathname) => V2_EDITOR_ROUTES[`${method} ${pathname}`]

/** 错误响应体（`{ ok: false, error, code, params? }`）。 */
export const v2ErrorBody = (code, params) => errorBody(new V2WriteError(code, params))

/**
 * 写入上下文：`now` 与 `newId` 默认取当前时间与 UUIDv7。`countryCatalog` 是插件的国家目录（键为大写 ISO）。
 */
export const createV2WriteContext = ({ countryCatalog, now = new Date(), newId = () => uuidv7() }) => ({ countryCatalog, now, newId })

/** 读 `data/v2/` 的五个文件；缺的为 undefined。不读任何旧文件。 */
const readV2Files = async (privatePaths) => Object.fromEntries(await Promise.all(
  V2_PRIVATE_FILE_KEYS.map(async (key) => [key, await readJson(privatePaths.v2FilePaths[key], undefined)]),
))

const reasonOf = (error) => (error instanceof Error ? error.message : String(error ?? '未知错误'))

const isV2WriteError = (error) => error instanceof V2WriteError
  || (error?.name === 'V2WriteError' && typeof error?.code === 'string')

/**
 * 需要用户先做选择、本次什么都没写的拒绝 → 409，`params.candidates` 交给界面：
 * - 第 2A 批 `E_PLACE_CHOICE_REQUIRED`：按名字新增城市时有同名候选；
 * - 第 2C 批 `E_JOURNEY_CHOICE_REQUIRED`：新的已去过记录的行程标题与已有行程相同。
 * 两者同时出现时纯函数先报地点选择，一次只有一种（src/data/v2write/journeyChoice.ts）。其余拒绝仍是 400。
 */
const CHOICE_REQUIRED_CODES = new Set(['E_PLACE_CHOICE_REQUIRED', 'E_JOURNEY_CHOICE_REQUIRED'])

/** 纯函数抛出的错误 → 400 响应（需要选择的为 409）。意料之外的错误（程序缺陷）也不吞掉原因。新库模式（./store-session.mjs）同样用它。 */
export const v2FailureResponse = (error) => ({
  status: isV2WriteError(error) && CHOICE_REQUIRED_CODES.has(error.code) ? 409 : 400,
  body: isV2WriteError(error) ? errorBody(error) : v2ErrorBody('E_UNEXPECTED', { reason: reasonOf(error) }),
})

/** GET /editor/state（还没有迁移到新库时，只读）：`{ ok: true, state }`（V1 形状），失败为 400。 */
export async function readV2EditorState({ privatePaths, now = new Date() }) {
  const files = await readV2Files(privatePaths)
  try {
    return { status: 200, body: { ok: true, state: readEditorStateV1(files, now) } }
  } catch (error) {
    return v2FailureResponse(error)
  }
}
