/**
 * `/__travelatlas/editor/state` 在 V2 数据模式下的读与写（RFC-LOC-1 PR3 总体方案 §3.1 第 2 条，PR3b-2 规格 §2.3）。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。编辑状态的写回协议是「整份取回 → 客户端改 → 整份写回」
 * （src/data/localEditorApi.ts 的 updateLocalEditorState），客户端代码与类型都不改，所以 V2 下接口形状保持 V1：
 *
 * - GET：V2 editor-state 经 `reconstructEditorState` 转成 V1 形状。id 是地点 id；`addedCountries` 的名称、
 *   国家代码、中心坐标一律从地点注册表重建。
 * - PUT：收 V1 形状，【转回】 V2——绝不把客户端对象原样写进 V2 文件：
 *   - `addedCountries` 以服务端现有的为准，忽略客户端带回的副本；
 *   - `countryOrder`、`hiddenCountryIds`、`cityOrderByCountry` 的键必须是国家地点；`cityOrderByCountry` 的值、
 *     `hiddenCityIds`、三个按城市记的媒体表（`mediaOrderByCity` / `coverMediaByCity` / `droneOrderByCity`）的键
 *     必须是城市地点；任一地点 id 不存在或类型不对 → `E_UNKNOWN_PLACE_REF`，不写；
 *   - 媒体 id（媒体表的值、`hiddenMediaIds`、`hiddenDroneMediaIds`）原样；
 *   - 字段缺失或形状不对 → `E_EDITOR_STATE_INVALID`（沿用旧文案「编辑状态格式无效。」）。旧模式的 normalizeState
 *     会把形状不对的字段静默换成空值；V2 下拒绝，免得一次坏请求清空排序与隐藏。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { indexPlaces, reconstructEditorState } from '../canonical/reconstruct.ts'
import type { CanonicalEditorState, PlaceId } from '../canonical/types.ts'
import { EDITOR_STATE_SCHEMA_VERSION, type V2FileKey, type V2Files } from '../canonical/v2Schema.ts'
import { jsonClone } from '../canonical/v2Serializer.ts'
import type { TravelAtlasEditorState } from '../derive/editorState.ts'
import { V2WriteError } from './errors.ts'
import { completeForWrite, integrityProblems, runV2Transaction, type V2FilesOrEmpty, type V2WriteContext, type V2WriteOutcome } from './transaction.ts'

/** V2 editor-state → 客户端看到的 V1 形状。 */
export const editorStateV1Of = (files: V2Files): TravelAtlasEditorState =>
  jsonClone(reconstructEditorState(files.editorState, indexPlaces(files.places.places)))

/** GET /editor/state（V2）：缺的文件按空处理；现有文件不合法时抛 `E_INTEGRITY`。 */
export function readEditorStateV1(files: V2FilesOrEmpty | undefined, now: Date): TravelAtlasEditorState {
  const completed = completeForWrite(files, now)
  const problems = integrityProblems(completed)
  if (problems.length > 0) throw new V2WriteError('E_INTEGRITY', { stage: 'input', problems: problems.slice(0, 20), total: problems.length })
  return editorStateV1Of(completed as unknown as V2Files)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

const invalid = (field: string): never => {
  throw new V2WriteError('E_EDITOR_STATE_INVALID', { field })
}

const stringArray = (input: Record<string, unknown>, field: string): string[] =>
  isStringArray(input[field]) ? [...input[field]] : invalid(field)

const recordOf = <T,>(input: Record<string, unknown>, field: string, isValue: (value: unknown) => value is T): Record<string, T> => {
  const value = input[field]
  if (!isObject(value)) return invalid(field)
  const entries: [string, T][] = []
  for (const [key, item] of Object.entries(value)) {
    if (!isValue(item)) return invalid(field)
    entries.push([key, jsonClone(item)])
  }
  return Object.fromEntries(entries)
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** V1 形状（客户端 PUT 的请求体）→ V2 editor-state。`addedCountries` 取自 `current`。 */
export const editorStateFromV1 = (
  input: unknown,
  current: CanonicalEditorState,
  subtypeOf: (id: PlaceId) => 'country' | 'city' | undefined,
  updatedAt: string,
): CanonicalEditorState => {
  if (!isObject(input)) return invalid('$')
  const countryOrder = stringArray(input, 'countryOrder')
  const hiddenCountryIds = stringArray(input, 'hiddenCountryIds')
  const cityOrderByCountry = recordOf(input, 'cityOrderByCountry', isStringArray)
  const hiddenCityIds = stringArray(input, 'hiddenCityIds')
  const mediaOrderByCity = recordOf(input, 'mediaOrderByCity', isStringArray)
  const hiddenMediaIds = stringArray(input, 'hiddenMediaIds')
  const coverMediaByCity = recordOf(input, 'coverMediaByCity', isString)
  const droneOrderByCity = recordOf(input, 'droneOrderByCity', isStringArray)
  const hiddenDroneMediaIds = stringArray(input, 'hiddenDroneMediaIds')

  const expect = (field: string, ids: Iterable<string>, expected: 'country' | 'city') => {
    for (const id of ids) {
      const subtype = subtypeOf(id)
      if (subtype !== expected) {
        throw new V2WriteError('E_UNKNOWN_PLACE_REF', { field, id, expected, actual: subtype ?? 'missing' })
      }
    }
  }
  expect('countryOrder', countryOrder, 'country')
  expect('hiddenCountryIds', hiddenCountryIds, 'country')
  expect('cityOrderByCountry', Object.keys(cityOrderByCountry), 'country')
  for (const [countryId, cityIds] of Object.entries(cityOrderByCountry)) expect(`cityOrderByCountry.${countryId}`, cityIds, 'city')
  expect('hiddenCityIds', hiddenCityIds, 'city')
  expect('mediaOrderByCity', Object.keys(mediaOrderByCity), 'city')
  expect('coverMediaByCity', Object.keys(coverMediaByCity), 'city')
  expect('droneOrderByCity', Object.keys(droneOrderByCity), 'city')

  return {
    schemaVersion: EDITOR_STATE_SCHEMA_VERSION,
    addedCountries: jsonClone(current.addedCountries),
    countryOrder,
    hiddenCountryIds,
    cityOrderByCountry,
    hiddenCityIds,
    mediaOrderByCity,
    hiddenMediaIds,
    coverMediaByCity,
    droneOrderByCity,
    hiddenDroneMediaIds,
    updatedAt,
  }
}

/** PUT /editor/state（V2）：只写 editor-state。返回值同旧接口：`{ state }`（V1 形状）。 */
export function putEditorState(
  files: V2FilesOrEmpty | undefined,
  input: unknown,
  ctx: V2WriteContext,
): V2WriteOutcome<{ state: TravelAtlasEditorState }> {
  return runV2Transaction(files, ctx, (draft) => {
    const subtypeOf = (id: PlaceId) => draft.placeById(id)?.subtype
    draft.files.editorState = editorStateFromV1(input, draft.files.editorState, subtypeOf, ctx.now.toISOString())
    const writes: { file: V2FileKey }[] = [{ file: 'editorState' }]
    return { result: { state: editorStateV1Of(draft.files) }, writes }
  })
}
