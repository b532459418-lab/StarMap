/**
 * 私人目录里的旧格式数据（RFC-LOC-1 PR5a 规格决定 I、§4.2）。
 *
 * PR5a 起 App、本地编辑器与媒体导入只读写 `data/v2/`，没有数据模式，也没有回滚开关。旧格式的四个文件
 * （travel-map / want-to-go / editor-state / user-media 的 `.local.json`）App 不再读取。PR5b 删除了迁移工具：
 * 旧格式的数据要先检出 StarMap 的提交 4fd32a9（最后一个带迁移工具的版本）迁移，步骤见 README 的 Private Data Format 一节。
 * 这里只看文件在不在，从不读内容：
 *
 * - **未迁移**：四个旧数据文件任一存在（只看确切的文件名，`atomicJsonWrite` 留下的 `.bak` 不算），
 *   且 `data/v2/` 下五个 V2 文件都不存在。此时个人模式显示迁移提示，本地编辑器的全部写入端点返回 409
 *   `E_LEGACY_UNMIGRATED`，`media:check` / `media:import` 拒绝运行（退出码 2）——否则 `data/v2/` 被写出后，
 *   4fd32a9 里迁移工具的 `--apply` 会因为输出目录非空而拒绝运行。
 * - **残留**（旧文件与 V2 文件都在）：已经迁移过；旧文件是 App 不再读取的残留，删留随意，一切照常。
 * - **全新**（都没有）与只有 V2 文件：一切照常。
 * - PR4 的数据模式标记 `data/data-mode.local.json` 不再读、不再写；存在也被忽略。
 *
 * 每次需要时现判，不缓存（插件每个写入请求判一次，与 PR4 每个请求现读数据模式相同）。
 * 判定与拒绝都是纯函数（输入是 `legacyDataStateOf` 的结果），可以在 node --test 下直接测试。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

/** 写入端点拒绝未迁移数据时的错误码（形状沿用 V2 写入的 `{ ok: false, error, code, params }`）。 */
export const LEGACY_UNMIGRATED_CODE = 'E_LEGACY_UNMIGRATED'

/** 写入端点拒绝时的状态码。 */
export const LEGACY_UNMIGRATED_STATUS = 409

/** 怎么迁移、或怎么放弃旧数据（编辑器的拒绝与导入器的拒绝共用这一段）。 */
export const LEGACY_MIGRATION_STEPS = '迁移：这个版本不再带迁移工具，请先检出 StarMap 的提交 4fd32a9（最后一个带迁移工具的版本）完成迁移，再回到最新版本，步骤见 README 的 Private Data Format 一节。不需要这些旧数据的话，把私人目录 data/ 下的四个旧文件（travel-map、want-to-go、editor-state、user-media 的 .local.json）移到别处。'

/** 本地编辑器写入被拒时的说明（响应里的 `error`）。 */
export const LEGACY_UNMIGRATED_WRITE_MESSAGE = `私人目录里有旧格式的数据，还没有迁移，这次修改没有保存。${LEGACY_MIGRATION_STEPS}`

/** 媒体导入被拒时的说明。 */
export const LEGACY_UNMIGRATED_IMPORT_MESSAGE = `私人目录里有旧格式的数据，还没有迁移，没有导入任何媒体。${LEGACY_MIGRATION_STEPS}`

/** 四个旧数据文件（顺序与迁移工具的旧文件哈希一致）。`privatePaths` 是 `getPrivatePaths()` 的结果。 */
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
 * 私人目录此刻有哪些旧数据文件与 V2 文件（只列文件名，不带目录，不读内容）。
 * @returns {{ legacyFiles: string[], v2Files: string[] }}
 */
export const legacyDataStateOf = (privatePaths) => ({
  legacyFiles: legacyDataPaths(privatePaths).filter((filePath) => existsSync(filePath)).map((filePath) => path.basename(filePath)),
  v2Files: Object.values(privatePaths.v2FilePaths).filter((filePath) => existsSync(filePath)).map((filePath) => path.basename(filePath)),
})

/** 未迁移：有旧数据文件，且没有任何 V2 文件（决定 I）。纯函数。 */
export const isLegacyUnmigrated = (state) => state.legacyFiles.length > 0 && state.v2Files.length === 0

/**
 * 本地编辑器写入端点的拒绝（决定 I）：未迁移时为 `{ status: 409, body }`，`body` 是
 * `{ ok: false, error, code: 'E_LEGACY_UNMIGRATED', params: { legacyFiles } }`（`legacyFiles` 是现有旧文件的文件名）；
 * 其他情况为 undefined（照常写入）。纯函数。
 */
export const legacyWriteRefusal = (state) => {
  if (!isLegacyUnmigrated(state)) return undefined
  return {
    status: LEGACY_UNMIGRATED_STATUS,
    body: {
      ok: false,
      error: LEGACY_UNMIGRATED_WRITE_MESSAGE,
      code: LEGACY_UNMIGRATED_CODE,
      params: { legacyFiles: [...state.legacyFiles] },
    },
  }
}
