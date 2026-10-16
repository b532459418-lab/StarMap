/**
 * Seeding the media registry (3C-4c, design v2 §5): what the registry must hold right after a V2 library becomes a new
 * library (store:migrate, in the store's first transaction) or a format-1 store is upgraded (store:upgrade), so that the
 * first scan afterwards adds no record that V2's own preview would not add.
 *
 * 1. Files: every catalog item whose src and variants lie in one content-addressed directory (`/media/user/<16 hex>/`)
 *    has its original hashed in full. The hash must begin with the directory name, and the original and every variant
 *    must exist; otherwise seeding fails with the problem listed (the store would refer to a file it cannot find). One
 *    media_files row per content, and a link from the item's asset. Items outside `/media/user/` (not files of the
 *    private root) are left unmanaged, as before.
 * 2. Sources: the Inbox is scanned with the importer's rules (media-scan.mjs). A file whose V2 id (the sidecar's explicit
 *    id, or the content id: the rule V2 imported it by) is a catalog item, and whose content is that item's, is a present
 *    source of that item's record. Items V2 merged by content get every such file as a source. A file with an explicit
 *    id whose content changed since V2 imported it is registered with the item's content, so the first scan shows it as
 *    a file replaced at its path (confirmation), never as a silent new record.
 * 3. Paths the V2 source index lists for an item that the scan did not find are registered as missing: if the file comes
 *    back elsewhere, it is matched as a move.
 * 4. The scan cache gets every scanned file.
 * Files whose V2 id is no catalog item (V2 has not imported them) are not registered: the first scan imports them, as
 * V2's next import would. A missing Inbox, or folders the importer cannot resolve, only mean fewer sources.
 *
 * Reads only; the caller writes the returned media block in the transaction that creates or upgrades the store.
 */
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256File } from './file-hash.mjs'
import { portablePath } from './library-backup.mjs'
import { scanCacheEntriesOf, scanInbox } from './media-scan.mjs'
import { INBOX_PREFIX, pathKeyOf } from './store-media-registry.mjs'
import { contentHashOf, generatedDirectoryOfSrc, v2MediaIdFor } from '../src/data/v2media/importPlan.ts'
import { OFFICIAL, V2_SOURCES } from '../src/data/store/officialDefinitions.ts'

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPortable = (value) => { try { portablePath(value); return true } catch { return false } }

/** Every src of a catalog item: the original and its variants. */
const sourcesOfItem = (item) => [item.src, ...Object.values(plain(item.variants) ? item.variants : {}).map((variant) => variant?.src)].filter((src) => typeof src === 'string')

/**
 * The media records of a migration batch or of a store's rows: V2 media id → { assetId, entityId }. `assets` and
 * `entities` are rows (a migration's created rows, or readRowsUnchecked's).
 */
export function mediaRecordsOf({ assets, entities }) {
  const entityOf = new Map(entities.filter((entity) => entity.typeId === OFFICIAL.media).map((entity) => [entity.fields.asset, entity.id]))
  const records = new Map()
  for (const asset of assets) {
    const v2Id = asset.source?.sourceId === V2_SOURCES.media ? asset.source.recordId : asset.id
    const entityId = entityOf.get(asset.id)
    if (entityId !== undefined) records.set(v2Id, { assetId: asset.id, entityId })
  }
  return records
}

/** The created rows of a migration's commands, as mediaRecordsOf expects them. */
export const createdRowsOf = (commands) => ({
  assets: commands.filter((command) => command.op === 'create' && command.table === 'assets').map((command) => command.value),
  entities: commands.filter((command) => command.op === 'create' && command.table === 'entities').map((command) => command.value),
})

/**
 * Seed the registry. `places` and `media` are the V2 places and media files of the library (the V2 files a migration
 * reads, or a store's projection), `records` mediaRecordsOf, `index` the V2 media source index (or undefined).
 * Resolves { media, problems, report }: `media` is the block to write (empty lists left out), `problems` lines that
 * make seeding fail, `report` the counts { files, links, unmanaged, present, missing, unregistered, scanProblems }.
 */
export async function seedMediaRegistry({ privatePaths, places, media, records, index, hashFile = sha256File }) {
  const problems = []
  const files = new Map()
  const links = []
  const contentOf = new Map()
  let unmanaged = 0
  for (const item of Array.isArray(media?.items) ? media.items : []) {
    const record = records.get(item.id)
    const sources = sourcesOfItem(item)
    const directories = new Set(sources.map((src) => generatedDirectoryOfSrc(src)))
    if (directories.size === 1 && directories.has(undefined)) { unmanaged += 1; continue }
    if (directories.size !== 1 || !record) {
      problems.push(`媒体 ${item.id}：${!record ? '在迁移批次里找不到它的记录' : '原图与各个版本不在同一个内容寻址的目录里'}。`)
      continue
    }
    const [directory] = directories
    const outputs = []
    let original
    for (const src of [...new Set(sources)]) {
      const name = src.slice(src.lastIndexOf('/') + 1)
      const file = path.join(privatePaths.userMediaRoot, directory, name)
      let info
      try { info = await lstat(file) } catch { info = undefined }
      if (!info?.isFile()) { problems.push(`媒体 ${item.id}：生成的文件 media/user/${directory}/${name} 不在。`); continue }
      const sha256 = await hashFile(file)
      outputs.push({ name, sha256, bytes: info.size })
      if (src === item.src) original = { sha256, bytes: info.size, extension: path.extname(name).toLowerCase() }
    }
    if (!original) continue
    if (original.sha256.slice(0, 16) !== directory) {
      problems.push(`媒体 ${item.id}：原图 media/user/${directory}/ 的 SHA-256 与目录名不一致（可能被截断或改动）。确认后删除这个目录，在 V2 模式下运行 npm run media:import 重新生成，再迁移。`)
      continue
    }
    if (!files.has(original.sha256)) {
      files.set(original.sha256, { op: 'put', sha256: original.sha256, extension: original.extension, bytes: original.bytes, outputs: outputs.sort((a, b) => (a.name < b.name ? -1 : 1)) })
    }
    links.push({ op: 'put', assetId: record.assetId, sha256: original.sha256 })
    contentOf.set(item.id, { sha256: original.sha256, record })
  }

  // A library without an Inbox has no source to register (the scan would only report the missing folder).
  const hasInbox = await lstat(privatePaths.inboxRoot).then((info) => info.isDirectory(), () => false)
  const scan = hasInbox ? await scanInbox({ privatePaths, places, hashFile }) : { facts: [], errors: [] }
  const sources = []
  const registered = new Set()
  let present = 0, missing = 0, unregistered = 0
  for (const fact of scan.facts) {
    const v2Id = v2MediaIdFor(contentHashOf(fact.sha256), fact.metadata)
    const known = contentOf.get(v2Id)
    if (!known) { unregistered += 1; continue }
    sources.push({ op: 'add', path: fact.path, sha256: known.sha256, recordId: known.record.entityId, state: 'present', descriptionDigest: fact.descriptionDigest })
    registered.add(fact.pathKey)
    present += 1
  }
  const listed = plain(index?.sourcesById) ? index.sourcesById : {}
  for (const [v2Id, relatives] of Object.entries(listed)) {
    const known = contentOf.get(v2Id)
    if (!known || !Array.isArray(relatives)) continue
    for (const relative of relatives) {
      if (typeof relative !== 'string') continue
      const pathValue = `${INBOX_PREFIX}${relative}`
      const key = pathKeyOf(pathValue)
      if (!isPortable(pathValue) || registered.has(key)) continue
      sources.push({ op: 'add', path: pathValue, sha256: known.sha256, recordId: known.record.entityId, state: 'missing' })
      registered.add(key)
      missing += 1
    }
  }
  const block = {
    ...(files.size ? { files: [...files.values()] } : {}),
    ...(links.length ? { assetFiles: links } : {}),
    ...(sources.length ? { sources } : {}),
    ...(scan.facts.length ? { scanCache: scanCacheEntriesOf(scan.facts) } : {}),
  }
  return {
    media: block, problems,
    report: { files: files.size, links: links.length, unmanaged, present, missing, unregistered, scanProblems: scan.errors.length },
  }
}

/** The V2 media source index of a library (`data/v2/media-source-index.local.json`), or undefined when absent or unreadable. */
export async function readMediaSourceIndex(privatePaths) {
  try { return JSON.parse(await readFile(privatePaths.v2MediaSourceIndexPath, 'utf8')) } catch { return undefined }
}

/** Lines of a seeding report (counts only: paths name places). */
export function seedReportLines(report) {
  return [
    `媒体登记：文件 ${report.files} 个，关联 ${report.links} 条（${report.unmanaged} 条媒体不在 /media/user/ 下，不登记文件）；`
      + `来源 ${report.present + report.missing} 个（在投递箱中 ${report.present}，不在 ${report.missing}）。`,
    ...(report.unregistered ? [`投递箱里有 ${report.unregistered} 个文件 V2 还没有导入：迁移之后第一次导入时，它们作为新资料导入（与 V2 下一次导入相同）。`] : []),
    ...(report.scanProblems ? [`扫描投递箱时有 ${report.scanProblems} 个问题（与 npm run media:check 相同）：相关文件这次没有登记。`] : []),
  ]
}
