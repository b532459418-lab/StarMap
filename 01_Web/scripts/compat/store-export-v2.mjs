/**
 * Export of the new library as V2 files (3C-3, design 3B §8; 3C-5 E: moved here from ../store-backup.mjs).
 *
 * - `npm run store:export-v2 -- --out <new directory>`: the store's read model seen through the official view and written
 *   as the five V2 files with serializeV2 (3C-5B; the way back to V2 mode after edits). Rows V2 cannot express are listed. The directory must not exist. Media (3C-4c, design v2
 *   §7): refused while files wait for deletion (pending_file_ops); a record created in the new library whose content no
 *   other record uses is exported under V2's content id (`media-<sha16>`, references in the editor state rewritten) so a
 *   V2 import finds it again, the others keep their ids; `media-source-index.local.json` is written from the registry
 *   (each exported id → its present and missing sources); and a read-only V2 scan of the exported files against the
 *   Inbox lists what a V2 `media:import` would then add, change or remove (D2 records of one content merge, records
 *   whose sources are gone disappear, descriptions follow the sidecars again).
 *
 * Compat (3C-5 E spec §2.4): V2 files are read and written only to migrate a library, to show a root that awaits
 * migration (read-only), and to export a library to V2 (this command). Ordinary read and write code does not import
 * this directory (../compat-boundary.test.mjs).
 *
 * Every output is private data: it may only go inside the private root or outside this repository
 * (../private-output.mjs). Messages carry codes, counts, ids and output paths, never values. Exit codes: 0 done, 1
 * refused or failed.
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPrivatePaths } from '../private-profile.mjs'
import { STORE_FILE_SEGMENTS, storeFileOf } from '../private-data-source.mjs'
import { createExclusive, newOutput, openReadOnly, requireStoreMode, writeJsonExclusive } from '../store-backup.mjs'
import { skippedCounts } from './store-projection.mjs'
import { StoreToolError } from '../store-tool-error.mjs'
import { EMPTY_PLACES_GENERATED_AT } from '../../src/data/compat/v2/canonicalForInputs.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES, validateV2Files } from '../../src/data/compat/v2/v2Schema.ts'
import { serializeV2 } from '../../src/data/compat/v2/v2Serializer.ts'
import { V2_MEDIA_SOURCE_INDEX_FILE_NAME, mediaSourceIndexFileOf } from '../../src/data/compat/v2/v2MediaFiles.ts'
import { OFFICIAL } from '../../src/data/store/officialDefinitions.ts'
import { projectStoreToCanonical } from '../../src/data/store/projectCanonical.ts'
import { contentHashOf, mediaIdOf } from '../../src/data/v2media/importPlan.ts'
import { formalStateOfReadModel, readModelOf } from '../../src/worldgraph/readModel/build.ts'

/**
 * `store:export-v2`: the five V2 files of the store in a new directory. Returns { out, files, skipped, lines }. The rows
 * come from readFormalState (the full check) and become the read model; the official view of it (the projection with its
 * skipped rows, which the export lists) is written with serializeV2 (3C-5B). A projection without file metadata of the
 * places registry (no `v2:import` source) gets the export time as its `generated_at` instead of the Unix epoch.
 */
export function exportedV2Of(model) {
  const projection = projectStoreToCanonical(formalStateOfReadModel(model), { source: 'local' })
  return { projection, files: serializeV2(projection.canonical, projection.v2Meta) }
}
/**
 * 3C-4c: the media ids of an export. A record created in the new library (an asset whose source is not `v2:media`) whose
 * content no other record uses gets V2's content id when no exported item has it yet; every reference in the editor state
 * follows. Returns { files (a copy), remapped (old id → new id) }.
 */
function exportMediaIds(files, state, registry) {
  const native = new Set(state.assets.filter((asset) => asset.source.sourceId !== 'v2:media').map((asset) => asset.id))
  const users = new Map()
  for (const link of registry.assetFiles) users.set(link.sha256, (users.get(link.sha256) ?? 0) + 1)
  const taken = new Set(files.media.items.map((item) => item.id))
  const remapped = new Map()
  for (const link of registry.assetFiles) {
    if (!native.has(link.assetId) || users.get(link.sha256) !== 1 || !taken.has(link.assetId)) continue
    const contentId = mediaIdOf(contentHashOf(link.sha256))
    if (taken.has(contentId)) continue
    taken.add(contentId)
    remapped.set(link.assetId, contentId)
  }
  const copy = structuredClone(files)
  const map = (id) => remapped.get(id) ?? id
  for (const item of copy.media.items) item.id = map(item.id)
  const state2 = copy.editorState
  state2.hiddenMediaIds = state2.hiddenMediaIds.map(map)
  state2.hiddenDroneMediaIds = state2.hiddenDroneMediaIds.map(map)
  for (const table of [state2.mediaOrderByCity, state2.droneOrderByCity]) for (const city of Object.keys(table)) table[city] = table[city].map(map)
  for (const city of Object.keys(state2.coverMediaByCity)) state2.coverMediaByCity[city] = map(state2.coverMediaByCity[city])
  return { files: copy, remapped }
}

/** 3C-4c: the V2 media source index of an export: each exported media id → its present and missing Inbox paths. */
function exportSourceIndex(files, state, registry, remapped, now) {
  const assetOfRecord = new Map(state.entities.filter((entity) => entity.typeId === OFFICIAL.media).map((entity) => [entity.id, entity.fields.asset]))
  const v2IdOf = new Map(state.assets.map((asset) => [asset.id, asset.source.sourceId === 'v2:media' ? asset.source.recordId : asset.id]))
  const exported = new Set(files.media.items.map((item) => item.id))
  const sourcesById = {}
  for (const source of registry.sources.filter((item) => item.state !== 'deleted')) {
    const assetId = assetOfRecord.get(source.recordId)
    const id = remapped.get(assetId) ?? v2IdOf.get(assetId)
    if (!exported.has(id)) continue
    ;(sourcesById[id] ??= []).push(source.path.slice('MediaInbox/'.length))
  }
  for (const list of Object.values(sourcesById)) list.sort()
  return mediaSourceIndexFileOf(Object.fromEntries(Object.entries(sourcesById).sort(([a], [b]) => (a < b ? -1 : 1))), now)
}

/**
 * 3C-4c: what a V2 `media:import` would change after going back with the exported files: a read-only V2 scan of the
 * Inbox against them. { added, changed, removed } (ids).
 */
async function exportMediaLosses(privatePaths, target, files, now) {
  const exportPaths = {
    ...privatePaths, v2DataRoot: target,
    v2FilePaths: Object.fromEntries(Object.entries(privatePaths.v2FilePaths).map(([key, file]) => [key, path.join(target, path.basename(file))])),
    v2MediaSourceIndexPath: path.join(target, V2_MEDIA_SOURCE_INDEX_FILE_NAME),
  }
  const { scanV2MediaImport } = await import('./v2-media-import.mjs')
  const scan = await scanV2MediaImport({ privatePaths: exportPaths, now: () => new Date(now), log: () => {}, logError: () => {} })
  // A scan with problems (no Inbox, a broken sidecar) is no import V2 would run: nothing to compare.
  if (scan.errors?.length) return { added: [], changed: [], removed: [], problems: scan.errors.length }
  const before = new Map(files.media.items.map((item) => [item.id, item]))
  const after = new Map((scan.items ?? []).map((item) => [item.id, item]))
  const same = (a, b) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && !same(before.get(id), after.get(id))),
    problems: 0,
  }
}

export async function exportStoreV2(privatePaths, { out, now = new Date().toISOString() } = {}) {
  const target = newOutput(out, '--out <新目录>')
  requireStoreMode(privatePaths)
  const handle = openReadOnly(storeFileOf(privatePaths))
  let projected, revision, state, registry
  try {
    state = handle.readFormalState()
    revision = state.revision
    projected = exportedV2Of(readModelOf(state, { origin: 'local' }))
    registry = handle.mediaRegistry()
  } finally { await handle.close() }
  if (registry.pendingFileOps.length) {
    throw new StoreToolError('E_EXPORT_PENDING_FILE_OPS', [`新库还有 ${registry.pendingFileOps.length} 个等待删除的文件。先运行一次媒体写入（npm run media:import），或 npm run library:recover -- --confirm，再导出。`])
  }
  const { projection } = projected
  const { files, remapped } = exportMediaIds(projected.files, state, registry)
  if (files.places.generated_at === EMPTY_PLACES_GENERATED_AT) files.places.generated_at = now
  const invalid = validateV2Files(files)
  if (invalid.length) throw new StoreToolError('E_EXPORT_INVALID', invalid.slice(0, 20).map((problem) => `${V2_FILE_NAMES[problem.file]} ${problem.path}：${problem.message}`))
  const index = exportSourceIndex(files, state, registry, remapped, now)
  await createExclusive(target)
  let losses
  try {
    for (const key of V2_FILE_KEYS) await writeJsonExclusive(path.join(target, V2_FILE_NAMES[key]), files[key])
    await writeJsonExclusive(path.join(target, V2_MEDIA_SOURCE_INDEX_FILE_NAME), index)
    losses = await exportMediaLosses(privatePaths, target, files, now)
  } catch (error) {
    await rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw error
  }
  const skipped = projection.skipped
  const lines = [`已导出修订号 ${revision} 的五个 V2 文件与媒体源索引到 ${target}`]
  if (remapped.size) lines.push(`媒体：${remapped.size} 条在新库里新建的资料改用 V2 的内容 id 导出（编辑状态里的引用一并改写）。`)
  if (losses.problems) {
    lines.push(`V2 的扫描报告了 ${losses.problems} 个需要处理的问题（npm run media:check 会列出），没有列出回到 V2 之后媒体的变化。`)
  } else if (losses.added.length || losses.changed.length || losses.removed.length) {
    lines.push(`回到 V2 之后运行 npm run media:import 会新增 ${losses.added.length} 条、改变 ${losses.changed.length} 条、移除 ${losses.removed.length} 条媒体（同一内容的多条资料会合并，来源不在投递箱中的资料会移除，说明按 sidecar 重新读取）：`)
    for (const [label, ids] of [['新增', losses.added], ['改变', losses.changed], ['移除', losses.removed]]) for (const id of ids) lines.push(`  ${label} ${id}`)
  } else {
    lines.push('回到 V2 之后运行 npm run media:import 不会改变媒体。')
  }
  if (skipped.length) {
    lines.push(`V2 表达不了、没有导出的内容：${skipped.length} 行（${Object.entries(skippedCounts(skipped)).map(([table, count]) => `${table} ${count}`).join('，')}）。新库与它的备份里仍然保留：`)
    for (const row of skipped) lines.push(`  ${row.table} ${row.id}`)
  } else {
    lines.push('新库的全部内容都已导出，没有 V2 表达不了的内容。')
  }
  lines.push(`回到 V2 模式：停止开发服务器，把这五个文件和 ${V2_MEDIA_SOURCE_INDEX_FILE_NAME} 放进 data/v2/，再把 ${STORE_FILE_SEGMENTS.join('/')} 移出私人根。`)
  return { out: target, files, index, remapped, losses, skipped, lines }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = 'npm run store:export-v2 -- --out <新目录>'

/** `npm run store:export-v2 -- --out <new directory>`; returns the exit code (a usage error is 1). */
export async function runExportV2Cli(argv, { privatePaths = getPrivatePaths(), log = console.log, logError = console.error } = {}) {
  const label = 'store:export-v2'
  if (argv.length !== 2 || argv[0] !== '--out' || typeof argv[1] !== 'string' || argv[1].startsWith('--')) {
    logError(`[${label}] 参数不对。用法：${USAGE}`)
    return 1
  }
  try {
    log(`StarMap ${label}\n私人根：${privatePaths.root}`)
    const result = await exportStoreV2(privatePaths, { out: argv[1] })
    for (const line of result.lines) log(line)
    return 0
  } catch (error) {
    if (error instanceof StoreToolError) {
      logError(`[${label}] ${error.code}，没有完成：`)
      for (const problem of error.problems) logError(`  - ${problem}`)
    } else {
      logError(`[${label}] 失败：${error?.code ?? error?.name ?? '未知错误'}${error?.path ? ` ${error.path}` : ''}。没有留下新的输出。`)
    }
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runExportV2Cli(process.argv.slice(2))
}
