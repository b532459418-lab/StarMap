/**
 * 数据模式（RFC-LOC-1 PR3 总体方案决定 B、C；PR3b-1 规格 §2.1）：私人目录现在用旧文件（`legacy`）
 * 还是 `data/v2/` 下的 V2 文件（`v2`）。
 *
 * 插件（虚拟模块注入与写入端点）与各脚本都经这里的 `resolveDataMode` 判定，只有这一个判断。
 *
 * 判定顺序（决定 C）：
 * 1. 标记文件 `data/data-mode.local.json` 存在：内容必须恰好是 `{ "mode": "legacy" }` 或 `{ "mode": "v2" }`，
 *    否则抛错（写出文件路径与期望格式），不猜；
 * 2. 没有标记，但四个旧数据文件（travel-map / want-to-go / editor-state / user-media 的 .local.json）任一存在：`legacy`；
 * 3. 都没有（全新私人目录）：`freshProfileMode`，默认 `FRESH_PROFILE_MODE`。
 *
 * 每次需要时现读，不做进程内缓存：标记文件改了，下一个请求 / 下一次加载就按新值走。
 * 错误信息不带文件内容。
 */

import { existsSync, readFileSync } from 'node:fs'

/** 全新私人目录的数据模式。PR4 改为 'v2'（决定 C）；PR3b-1 不改，所以默认行为不变。 */
export const FRESH_PROFILE_MODE = 'legacy'

export const DATA_MODES = Object.freeze(['legacy', 'v2'])

const EXPECTED_FORMAT = '{ "mode": "legacy" } 或 { "mode": "v2" }'

/** 标记文件存在但内容不合法。 */
export class DataModeMarkerError extends Error {
  constructor(filePath, problem) {
    super(`数据模式标记文件 ${filePath} ${problem}：内容必须恰好是 ${EXPECTED_FORMAT}。`)
    this.name = 'DataModeMarkerError'
    this.filePath = filePath
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 标记文件的原文 → 'legacy' | 'v2'。不合法时抛 DataModeMarkerError（只说哪类问题，不带原文）。 */
export function parseDataModeMarker(text, filePath) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new DataModeMarkerError(filePath, '不是有效的 JSON')
  }
  if (!isPlainObject(value)) throw new DataModeMarkerError(filePath, '不是 JSON 对象')
  if (!Object.hasOwn(value, 'mode')) throw new DataModeMarkerError(filePath, '缺少 mode 字段')
  const extra = Object.keys(value).filter((key) => key !== 'mode')
  if (extra.length > 0) throw new DataModeMarkerError(filePath, `有多余的字段（${extra.length} 个）`)
  if (!DATA_MODES.includes(value.mode)) throw new DataModeMarkerError(filePath, 'mode 不是 legacy 或 v2（区分大小写）')
  return value.mode
}

/** 四个旧数据文件（顺序与迁移工具的旧文件哈希一致）。 */
export const legacyDataPaths = (privatePaths) => [
  privatePaths.localTravelMapPath,
  privatePaths.wantToGoPath,
  privatePaths.editorStatePath,
  privatePaths.mediaCatalogPath,
]

/**
 * 判定私人目录的数据模式。`privatePaths` 是 `getPrivatePaths()` 的结果。
 * @returns {{ mode: 'legacy' | 'v2', reason: 'marker' | 'legacy-data' | 'fresh-profile' }}
 */
export function resolveDataMode(privatePaths, { freshProfileMode = FRESH_PROFILE_MODE } = {}) {
  if (!DATA_MODES.includes(freshProfileMode)) throw new TypeError(`freshProfileMode 只能是 ${DATA_MODES.join(' / ')}`)
  const markerPath = privatePaths.dataModePath
  let text
  try {
    text = readFileSync(markerPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new DataModeMarkerError(markerPath, `读取失败（${error?.code ?? '未知错误'}）`)
  }
  if (text !== undefined) return { mode: parseDataModeMarker(text, markerPath), reason: 'marker' }
  if (legacyDataPaths(privatePaths).some((filePath) => existsSync(filePath))) return { mode: 'legacy', reason: 'legacy-data' }
  return { mode: freshProfileMode, reason: 'fresh-profile' }
}
