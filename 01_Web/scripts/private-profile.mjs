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
 * `V2_FILE_NAMES` 相同（`data-mode.test.mjs` 核对）；这里不 import 它，因为 vite.config.ts 也加载本文件。
 */
export const V2_DATA_FILE_NAMES = Object.freeze({
  places: 'places.local.json',
  travel: 'travel-map.local.json',
  wantToGo: 'want-to-go.local.json',
  editorState: 'editor-state.local.json',
  media: 'user-media.local.json',
})

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
    mediaSourceIndexPath: path.join(dataRoot, 'media-source-index.local.json'),
    wantToGoPath: path.join(dataRoot, 'want-to-go.local.json'),
    // RFC-LOC-1 PR3b-1：数据模式标记与 V2 文件（判定见 data-mode.mjs）。
    dataModePath: path.join(dataRoot, 'data-mode.local.json'),
    v2DataRoot,
    v2FilePaths: Object.fromEntries(
      Object.entries(V2_DATA_FILE_NAMES).map(([key, fileName]) => [key, path.join(v2DataRoot, fileName)]),
    ),
  }
}
