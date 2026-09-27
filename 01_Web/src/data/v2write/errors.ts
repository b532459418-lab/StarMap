/**
 * V2 写入的错误码（RFC-LOC-1 MSG-2 的过渡形态，PR3b-2 规格 §2.5）。
 *
 * `src/data/v2write/` 是 App 层（Node 写入端点用的纯函数），【不是】 StarMap Core。
 *
 * V2 写入的错误响应是 `{ ok: false, error: '<中文文案>', code: 'E_…', params?: {…} }`：
 * - `error` 仍是字符串，客户端 `parseResponse`（src/data/localEditorApi.ts）不用改，界面显示同样的话；
 * - `code` 与 `params` 是 MSG-2 的码与参数。RFC MSG-2 的完整形态（`error` 为 `{ code, params }`，由客户端
 *   按码翻译）随 i18n 落地——这是对 MSG-2 的有意分步。
 *
 * 码表集中在这里：每个码配一句中文文案。能沿用旧模式原文的一律沿用（同一个操作，界面说同样的话）；
 * 旧模式没有对应情形的码（地点歧义、未知地点引用、完整性、部分写入等）才写新文案。
 * 参数只放与语言无关的值（字段名、id、计数）；要显示的字段名由 `FIELD_LABELS` 译成中文。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

/** 请求里的字段 → 旧文案里的中文字段名（与旧模式的 requireText / numberInRange 标签相同）。 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  country: '国家中文名',
  country_en: '国家英文名',
  city: '城市中文名',
  city_en: '城市英文名',
  country_code: '国家代码',
  countryCode: '国家代码',
  start_date: '到访日期',
  startDate: '到访日期',
  end_date: '结束日期',
  endDate: '结束日期',
  visitedDate: '首次到访日期',
  addedAt: '加入日期',
  lat: '纬度',
  lng: '经度',
  nameEn: '地点英文名',
  id: '想去记录 id',
  recordId: '旅行计划 id',
}

const label = (params: V2ErrorParams): string => {
  const field = typeof params.field === 'string' ? params.field : ''
  return FIELD_LABELS[field] ?? field
}

export type V2ErrorParams = Record<string, unknown>

/** 码 → 文案。沿用旧文案的标注了出处；标「新」的是旧模式没有对应情形的码。 */
export const V2_WRITE_MESSAGES = {
  // ---- 输入校验（沿用插件 requireText / numberInRange / addTravelRecord / addCountry 与 want-to-go-store.mjs）----
  E_REQUIRED: (params: V2ErrorParams) => `请填写${label(params)}。`,
  E_DATE_FORMAT: (params: V2ErrorParams) => `${label(params)}必须使用 YYYY-MM-DD。`,
  E_DATE_ORDER: () => '结束日期不能早于到访日期。',
  E_NUMBER_INVALID: (params: V2ErrorParams) => `${label(params)}无效。`,
  E_COORDINATES_PAIR: () => '经纬度需要同时填写，或同时留空。',
  E_COUNTRY_CODE_REQUIRED: () => '请填写国家代码。',
  E_COUNTRY_CODE_INVALID: () => '国家代码必须是两个英文字母。',
  E_COUNTRY_NOT_IN_CATALOG: () => '没有找到这个国家，请从候选列表中选择。',
  E_WTG_KIND_INVALID: () => '想去条目的类型只能是 city 或 country。',
  E_NOTE_NOT_TEXT: () => '备注必须是文本。',
  E_NOTE_TOO_LONG: () => '备注最多 200 字。',
  E_WTG_UPDATE_EMPTY: () => '没有需要更新的想去记录内容。',
  E_HIDDEN_NOT_BOOLEAN: () => '隐藏状态只能是 true 或 false。',
  E_KEEP_WTG_NOT_BOOLEAN: () => '保留想去条目只能是 true 或 false。',
  E_CONVERT_SOURCE_INVALID: () => '转换来源只能是 want-to-go 或 planned。',
  E_EDITOR_STATE_INVALID: () => '编辑状态格式无效。',

  // ---- 业务拒绝（沿用旧文案）----
  E_CITY_EXISTS: () => '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。',
  E_COUNTRY_EXISTS: () => '这个国家已经存在于国家足迹中。',
  E_COUNTRY_DELETE_EMPTY: () => '没有可删除的隐藏国家。',
  E_COUNTRY_DELETE_NOT_HIDDEN: () => '只能彻底删除已经隐藏的国家。',
  E_COUNTRY_DELETE_NO_DATA: () => '找不到待删除国家的本地旅行数据，已停止删除。',
  E_COUNTRY_HAS_MEDIA: (params: V2ErrorParams) => {
    const cities = Array.isArray(params.cities) ? params.cities as { name?: string; count?: number }[] : []
    const summary = cities.map((city) => `${city.name ?? '未知城市'}（${city.count ?? 0} 个媒体）`).join('、')
    return `以下城市仍有照片或无人机影像：${summary}。请先在对应城市中彻底删除这些媒体。`
  },
  E_WTG_EXISTS: () => '这个地方已在想去列表中。',
  E_WTG_NOT_FOUND: () => '找不到这条想去记录。',
  E_WTG_DELETE_EMPTY: () => '没有可删除的隐藏想去记录。',
  E_WTG_DELETE_NOT_HIDDEN: (params: V2ErrorParams) => {
    const ids = Array.isArray(params.ids) ? params.ids.map(String) : []
    return `只能彻底删除已隐藏的想去记录。以下记录不符合条件：${ids.join('、')}`
  },
  E_CONVERT_COUNTRY_KIND: () => '整个国家的想去需要先具体到城市，暂不支持直接转为足迹。',
  E_CONVERT_NO_COORDINATES: () => '这个地点没有坐标，无法转为足迹。',
  E_CONVERT_HIDDEN: () => '已隐藏的想去条目不能转为足迹。',
  E_CONVERT_CITY_IN_FOOTPRINT: () => '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。',
  E_PLANNED_NOT_FOUND: () => '找不到这条旅行计划。',
  E_PLANNED_NO_COORDINATES: () => '这条旅行计划没有坐标，无法转为足迹。',

  // ---- 新：V2 才有的情形 ----
  E_PLACE_AMBIGUOUS: () => '地点注册表里有不止一个地点与之匹配，无法确定是哪一个，未写入。请先合并重复的地点。',
  E_UNKNOWN_PLACE_REF: () => '编辑状态引用了不存在的地点，或地点类型不对，未保存。请刷新页面后重试。',
  E_INTEGRITY: () => 'V2 数据没有通过完整性检查（例如引用了不存在的地点），未写入任何文件。',
  E_WRITE_FAILED: (params: V2ErrorParams) => (typeof params.reason === 'string' && params.reason ? params.reason : '写入 V2 数据文件失败。'),
  E_PARTIAL_WRITE: (params: V2ErrorParams) => (typeof params.message === 'string' ? params.message : '部分 V2 数据文件已写入，其余没有写入。'),
  E_V2_MEDIA_UNAVAILABLE: () => 'V2 数据模式下暂不能编辑照片与无人机影像（RFC-LOC-1 PR3b-3 开放）。',
  E_UNKNOWN_ENDPOINT: () => '未知的本地编辑接口。',
  /** 请求体读不出来（过大、不是 JSON）：原因原样（同旧模式）。 */
  E_REQUEST_INVALID: (params: V2ErrorParams) => (typeof params.reason === 'string' && params.reason ? params.reason : '请求内容无效。'),
  /** 纯函数里意料之外的错误（程序缺陷）：原因原样，兜底用旧模式的「本地编辑操作失败。」。 */
  E_UNEXPECTED: (params: V2ErrorParams) => (typeof params.reason === 'string' && params.reason ? params.reason : '本地编辑操作失败。'),
} as const

export type V2WriteErrorCode = keyof typeof V2_WRITE_MESSAGES

export const V2_WRITE_ERROR_CODES = Object.keys(V2_WRITE_MESSAGES) as V2WriteErrorCode[]

/** 码与参数 → 中文文案。 */
export const messageFor = (code: V2WriteErrorCode, params: V2ErrorParams = {}): string => V2_WRITE_MESSAGES[code](params)

/** V2 写入的错误：`message` 就是响应里的 `error`。 */
export class V2WriteError extends Error {
  readonly code: V2WriteErrorCode
  readonly params?: V2ErrorParams

  constructor(code: V2WriteErrorCode, params?: V2ErrorParams) {
    super(messageFor(code, params))
    this.name = 'V2WriteError'
    this.code = code
    if (params !== undefined) this.params = params
  }
}

/** 抛出 V2WriteError（表达式里用）。 */
export const fail = (code: V2WriteErrorCode, params?: V2ErrorParams): never => {
  throw new V2WriteError(code, params)
}

/** 错误响应体：`{ ok: false, error, code, params? }`。 */
export const errorBody = (error: V2WriteError) => ({
  ok: false as const,
  error: error.message,
  code: error.code,
  ...(error.params !== undefined ? { params: error.params } : {}),
})
