/**
 * 数据模式（RFC-LOC-1 PR3 总体方案决定 B、C；PR3b-1 规格 §2.1；PR4 规格 §2.1、§2.2）：私人目录现在用旧文件
 * （`legacy`）还是 `data/v2/` 下的 V2 文件（`v2`）。
 *
 * 插件（虚拟模块注入与写入端点）与各脚本都经这里的 `resolveDataMode` 判定，只有这一个判断。
 *
 * 判定顺序（决定 C）：
 * 1. 标记文件 `data/data-mode.local.json` 存在：内容必须恰好是 `{ "mode": "legacy" }` 或 `{ "mode": "v2" }`，
 *    否则抛错（写出文件路径与期望格式），不猜。开头的一个 UTF-8 BOM 容忍（Windows 自带工具默认会写）；
 * 2. 没有标记，但四个旧数据文件（travel-map / want-to-go / editor-state / user-media 的 .local.json）任一存在：`legacy`。
 *    只看这四个确切的文件名：`atomicJsonWrite` 留下的 `.bak`、迁移清单、`data/v2/` 里的文件都不算旧数据；
 * 3. 都没有（全新私人目录）：`freshProfileMode`，默认 `FRESH_PROFILE_MODE`（PR4 起为 `v2`）。
 *
 * 每次需要时现读，不做进程内缓存：标记文件改了，下一个请求 / 下一次加载就按新值走。
 * 错误信息不带文件内容。
 *
 * 写标记只经 `writeDataModeMarker`（`scripts/data-mode-cli.mjs` 与 `migrate-identity --apply --switch` 共用）：
 * 原子写入（`atomicJsonWrite`：结尾换行，不带 BOM），且只写解析出的私人根目录之内的标记文件（隐私门）。
 */

import { existsSync, readFileSync } from 'node:fs'

import { atomicJsonWrite } from './json-file.mjs'
import { isAllowedPrivateOutput, isInsideDirectory } from './private-output.mjs'

/**
 * 全新私人目录的数据模式（决定 C）。PR4 起为 'v2'：没有旧数据的私人目录一出生就是新格式，不需要再迁移；
 * 已有旧数据的私人目录不写标记就仍是 legacy（判定第 2 步），行为不变。
 */
export const FRESH_PROFILE_MODE = 'v2'

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

/**
 * 标记文件的原文 → 'legacy' | 'v2'。不合法时抛 DataModeMarkerError（只说哪类问题，不带原文）。
 * 开头的一个 UTF-8 BOM（U+FEFF）先去掉：Windows 记事本、PowerShell 5.1 的 `Set-Content -Encoding utf8` /
 * `Out-File` 默认都写 BOM。其余规则不变（区分大小写、不许多余字段）；只去一个，第二个 BOM 仍按非法 JSON 报错。
 */
export function parseDataModeMarker(text, filePath) {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  let value
  try {
    value = JSON.parse(source)
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

/** 私人目录里有旧数据：四个旧数据文件任一存在（只看确切的文件名，`.bak` 不算）。 */
export const hasLegacyData = (privatePaths) => legacyDataPaths(privatePaths).some((filePath) => existsSync(filePath))

/** `data/v2/` 里有 V2 文件：五个 V2 文件任一存在（只看确切的文件名，`.bak` 不算）。 */
export const hasV2Data = (privatePaths) => Object.values(privatePaths.v2FilePaths).some((filePath) => existsSync(filePath))

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
  if (hasLegacyData(privatePaths)) return { mode: 'legacy', reason: 'legacy-data' }
  return { mode: freshProfileMode, reason: 'fresh-profile' }
}

// ---- 写标记（PR4 规格 §2.2）----

/** 隐私门拒绝写标记：标记文件不在解析出的私人根目录之内，或私人根是仓库本身 / 包含整个仓库。 */
export class DataModeMarkerWriteRefused extends Error {
  constructor(filePath) {
    super(`拒绝写入数据模式标记 ${filePath}：只能写解析出的私人根目录之内的标记文件（私人根不能是仓库本身或包含仓库）。`)
    this.name = 'DataModeMarkerWriteRefused'
    this.filePath = filePath
  }
}

/**
 * 隐私门：标记文件必须在 `privatePaths.root` 之内，且按 private-output.mjs 的规则允许写（私人根包含整个仓库时不放行）。
 * 不满足时抛 DataModeMarkerWriteRefused。只做路径判断，不碰文件。
 */
export function assertDataModeMarkerWritable(privatePaths) {
  const target = privatePaths.dataModePath
  if (!isInsideDirectory(target, privatePaths.root) || !isAllowedPrivateOutput(target, { STARMAP_PRIVATE_ROOT: privatePaths.root })) {
    throw new DataModeMarkerWriteRefused(target)
  }
}

/**
 * 原子写入标记 `{ "mode": <mode> }`：`atomicJsonWrite` 先写临时文件再改名，结尾换行，不带 BOM；已有标记时留 `.bak`。
 * 写之前过隐私门。返回写入的路径。
 */
export async function writeDataModeMarker(privatePaths, mode) {
  if (!DATA_MODES.includes(mode)) throw new TypeError(`mode 只能是 ${DATA_MODES.join(' / ')}`)
  assertDataModeMarkerWritable(privatePaths)
  await atomicJsonWrite(privatePaths.dataModePath, { mode })
  return privatePaths.dataModePath
}
