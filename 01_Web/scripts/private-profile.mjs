import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const sourceRoot = path.resolve(webRoot, '..')
export const maintenanceRoot = path.resolve(sourceRoot, '..')

export function resolvePrivateRoot(environment = process.env) {
  const configuredRoot = environment.STARMAP_PRIVATE_ROOT?.trim()
  if (configuredRoot) return path.resolve(configuredRoot)

  const maintenancePrivateRoot = path.join(maintenanceRoot, '06_private')
  if (existsSync(maintenancePrivateRoot)) return maintenancePrivateRoot

  return path.join(sourceRoot, '06_private')
}

/**
 * V2 文件在 `data/v2/` 下的文件名（RFC-LOC-1 PR3 总体方案决定 B）。与 `src/data/canonical/v2Schema.ts` 的
 * `V2_FILE_NAMES` 相同（`private-data-module.test.mjs` 核对）；这里不 import 它，因为 vite.config.ts 也加载本文件。
 */
export const V2_DATA_FILE_NAMES = Object.freeze({
  places: 'places.local.json',
  travel: 'travel-map.local.json',
  wantToGo: 'want-to-go.local.json',
  editorState: 'editor-state.local.json',
  media: 'user-media.local.json',
})

/** 五个 V2 文件的键（与 getPrivatePaths().v2FilePaths、src/data/canonical/v2Schema.ts 的 V2_FILE_KEYS 相同，顺序也相同）。 */
export const V2_PRIVATE_FILE_KEYS = Object.freeze(Object.keys(V2_DATA_FILE_NAMES))

export function getPrivatePaths(environment = process.env) {
  const root = resolvePrivateRoot(environment)
  const dataRoot = path.join(root, 'data')
  const v2DataRoot = path.join(dataRoot, 'v2')
  return {
    root,
    configRoot: path.join(root, 'config'),
    dataRoot,
    inboxRoot: path.join(root, 'MediaInbox'),
    userMediaRoot: path.join(root, 'media', 'user'),
    editorStatePath: path.join(dataRoot, 'editor-state.local.json'),
    localTravelMapPath: path.join(dataRoot, 'travel-map.local.json'),
    mediaCatalogPath: path.join(dataRoot, 'user-media.local.json'),
    wantToGoPath: path.join(dataRoot, 'want-to-go.local.json'),
    // RFC-LOC-1 PR3b-1：V2 文件。PR5a 起 App 只读它们；上面四个旧格式文件的路径只给 legacy-data.mjs 判定「未迁移」用
    // （只看在不在，不读内容）。PR5b 删除了旧格式的媒体源文件索引路径。
    v2DataRoot,
    v2FilePaths: Object.fromEntries(
      Object.entries(V2_DATA_FILE_NAMES).map(([key, fileName]) => [key, path.join(v2DataRoot, fileName)]),
    ),
    // RFC-LOC-1 PR3b-3：V2 的媒体源文件索引（媒体 id → 投递箱路径）。与旧模式的索引分开（两种模式的媒体 id 不同）；
    // 它不属于 V2 的五个文件，不进 validateV2Files。文件名同 src/data/v2media/importPlan.ts 的 V2_MEDIA_SOURCE_INDEX_FILE_NAME。
    v2MediaSourceIndexPath: path.join(v2DataRoot, 'media-source-index.local.json'),
  }
}
