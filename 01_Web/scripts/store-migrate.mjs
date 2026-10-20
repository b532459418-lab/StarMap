/**
 * `npm run store:migrate` (3C-3, design 3B §7): migrate a private root's five V2 files into the formal store
 * `data/store/world.sqlite`, the only way personal data is written since 3C-4d (./private-data-source.mjs). A dev server
 * that is running switches over by itself (its watcher sees the new file).
 *
 * 3C-4d: the root's state is checked first. Legacy-format data that was never migrated to V2 is refused
 * (E_LEGACY_UNMIGRATED: the migration of commit 4fd32a9 comes first; migrating would make an empty library of it), and
 * so is a leftover under `data/store/` without a store (E_STORE_RESIDUE: `npm run library:recover`). With `--apply`, an
 * unfinished media task refuses too (E_MEDIA_JOB_PENDING), under the lease. A root without any data gets an empty
 * library initialized in the formal model (./store-init.mjs), never through the V2 reader.
 *
 * - Without arguments it only previews (a dry run): read the V2 files, `migrateV2` (3C-1b), plan the batch on an empty
 *   store in memory, project it back and compare with `readV2` and the derived baseline. It prints the counts, the V2
 *   keys kept in `extensions`, the unresolved view elements and the comparison. Nothing is written anywhere.
 * - `--apply` creates the store:
 *   1. takes the library operation lease;
 *   2. creates `data/store/world.sqlite` exclusively (an existing file is refused, never touched);
 *   3. commits one first request: the official definitions and the migration commands, in dependency order;
 *   4. writes the identity ledger into `id_map`;
 *   5. closes the store normally (clean_shutdown);
 *   6. reopens it read-only, projects `readRowsUnchecked()` and compares with `readV2` of the V2 files and with their
 *      derived baseline. Any difference deletes the new store again and the command fails.
 * - The V2 files are never written: their bytes are read once and checked again at the end.
 * - A refused migration (invalid V2 files, records readV2 would skip, colliding source ids, …) writes nothing and lists
 *   every problem. Problems and reports carry rules, paths, keys and counts, never values from the files.
 *
 * Exit codes: 0 preview or migration done, 1 refused or failed.
 */
import { readFile, rmdir, stat, unlink } from 'node:fs/promises'
import { LEGACY_MIGRATION_STEPS } from './legacy-data.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { getPrivatePaths, V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
import { privateDataSource, privateDataState, storeFileOf } from './private-data-source.mjs'
import { compareWithV2, projectToV2Files } from './store-projection.mjs'
import { createStore, openStore } from './store-host.mjs'
import { createdRowsOf, mediaRecordsOf, readMediaSourceIndex, seedMediaRegistry, seedReportLines } from './media-seed.mjs'
import { completeV2Files } from '../src/data/canonical/canonicalForInputs.ts'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { migrateV2 } from '../src/data/store/migrateV2.ts'
import { FORMAL_TABLES, emptyFormalState } from '../src/worldgraph/store/formal.ts'
import { memoryReader } from '../src/worldgraph/store/reader.ts'
import { planCommands } from '../src/worldgraph/store/planner.ts'

/** `kind` and `actor` of the store's first request. */
export const MIGRATION_KIND = 'store.migrate-v2'
export const MIGRATION_ACTOR = 'store:migrate'

/** A refusal or failure of a store tool: `problems` are lines safe to print (no values from the private files). */
export class StoreToolError extends Error {
  constructor(code, problems = []) {
    super([code, ...problems].join('\n'))
    this.name = 'StoreToolError'
    this.code = code
    this.problems = Object.freeze([...problems])
  }
}

/**
 * The five V2 files of a private root, as the plugin reads them: `values` (missing files completed as empty, like the
 * App) and `bytes` (the raw content, undefined for a missing file) to prove later that nothing was written.
 * A file that is not JSON is a problem naming the file only (JSON.parse messages quote the content).
 */
export async function readV2Inputs(privatePaths) {
  const bytes = {}, raw = {}, problems = []
  for (const key of V2_PRIVATE_FILE_KEYS) {
    try { bytes[key] = await readFile(privatePaths.v2FilePaths[key]) } catch (error) {
      if (error?.code !== 'ENOENT') problems.push(`data/v2/${V2_FILE_NAMES[key]}：无法读取（${error?.code ?? '未知错误'}）`)
      continue
    }
    try { raw[key] = JSON.parse(bytes[key].toString('utf8')) } catch {
      problems.push(`data/v2/${V2_FILE_NAMES[key]}：不是合法的 JSON`)
    }
  }
  if (problems.length) throw new StoreToolError('E_V2_UNREADABLE', problems)
  return { values: completeV2Files(raw), bytes }
}

/** True when every V2 file still has the bytes `before` recorded (a missing file is still missing). */
export async function v2FilesUnchanged(privatePaths, before) {
  for (const key of V2_PRIVATE_FILE_KEYS) {
    let now
    try { now = await readFile(privatePaths.v2FilePaths[key]) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (now === undefined ? before[key] !== undefined : before[key] === undefined || !now.equals(before[key])) return false
  }
  return true
}

/** migrateV2 for these files at `now`, or a StoreToolError listing every problem (nothing is generated then). */
export function migrationOf(files, { now, allocateId = () => uuidv7() }) {
  const result = migrateV2(files, { now, allocateId })
  if (!result.ok) {
    throw new StoreToolError('E_MIGRATION_REFUSED', result.report.problems.map((problem) =>
      `${problem.code}${problem.file ? ` ${V2_FILE_NAMES[problem.file]}` : ''} ${problem.path}：${problem.message}`))
  }
  return result
}

/**
 * The state an empty store reaches after one change set (the migration's): its upserts per table (ordered by id, as
 * the host reads them), its tombstones and revision. Linear, unlike Core's reference applyChangeSet.
 */
function stateAfterFirstChangeSet(changeSet) {
  const state = { ...emptyFormalState(), revision: changeSet.nextRevision, tombstones: [...changeSet.tombstones] }
  for (const table of FORMAL_TABLES) state[table] = []
  for (const { table, row } of changeSet.upserts) state[table].push(row)
  for (const table of FORMAL_TABLES) state[table].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return state
}

/** Report lines shared by the preview and --apply: counts, extension keys, unresolved view elements. */
function reportLines(report) {
  const lines = ['各类数量：']
  for (const [kind, count] of Object.entries(report.counts)) lines.push(`  ${kind}: ${count}`)
  lines.push('正式库各表行数：')
  for (const [table, count] of Object.entries(report.rows)) if (count) lines.push(`  ${table}: ${count}`)
  const extensionKinds = Object.entries(report.extensionKeys)
  lines.push(extensionKinds.length ? 'extensions.v2 里保存的 V2 键（按记录类别，括号里是记录数）：' : 'extensions.v2：没有需要原样保存的 V2 键。')
  for (const [kind, keys] of extensionKinds) lines.push(`  ${kind}: ${Object.entries(keys).map(([key, count]) => `${key}（${count}）`).join('、')}`)
  const unresolved = Object.entries(report.unresolvedViewElements)
  lines.push(unresolved.length ? 'unresolved 视图元素（不是库里的行，或重复的 id，按 scope）：' : 'unresolved 视图元素：没有。')
  for (const [scope, count] of unresolved) lines.push(`  ${scope}: ${count}`)
  return lines
}

const comparisonLine = (comparison) => `比对：Canonical 与 readV2 ${comparison.canonical ? '一致' : '不一致'}；派生基线 ${comparison.baseline ? '一致' : '不一致'}。`

/**
 * 3C-4d: the state of the root, refusing what must not be migrated: legacy data never migrated to V2, a leftover under
 * `data/store/` without a store. Returns the state ('store' is left to the callers' own message).
 */
function migratableState(privatePaths) {
  const decided = privateDataState(privatePaths)
  if (decided.state === 'migration-required' && decided.reason === 'legacy') {
    throw new StoreToolError('E_LEGACY_UNMIGRATED', ['私人目录里有旧格式的数据，还没有迁移到 V2，没有建立新库。', LEGACY_MIGRATION_STEPS])
  }
  if (decided.state !== 'store' && decided.residue.length > 0) {
    throw new StoreToolError('E_STORE_RESIDUE', [`data/store/ 里有 ${decided.residue.length} 个残留的文件，没有新库。请先运行 npm run library:recover 查看并处理。`])
  }
  return decided.state
}

/**
 * The dry run: migrate, plan on an empty store in memory, project, compare. Writes nothing.
 * Returns { ok, lines, report, comparison, storeExists }; a refused migration throws StoreToolError.
 */
export async function previewMigration(privatePaths, { now = new Date().toISOString(), allocateId } = {}) {
  if (migratableState(privatePaths) === 'empty') {
    return { ok: true, empty: true, lines: ['私人根里没有任何数据：--apply 会建立一个空的新库（不经过 V2 文件）。'], storeExists: false }
  }
  const { values } = await readV2Inputs(privatePaths)
  const result = migrationOf(values, { now, allocateId })
  const changeSet = planCommands(memoryReader(emptyFormalState()), result.commands, { baseRevision: 0, now, policy: OFFICIAL_POLICY })
  const { projection } = projectToV2Files(stateAfterFirstChangeSet(changeSet))
  const comparison = compareWithV2(projection, values)
  const storeExists = privateDataSource(privatePaths) === 'store'
  // 3C-4c: what the media registry would be seeded with (read-only: the Inbox and the media files are only read).
  const seeded = await seedMediaRegistry({
    privatePaths, places: values.places, media: values.media, records: mediaRecordsOf(createdRowsOf(result.commands)),
    index: await readMediaSourceIndex(privatePaths),
  })
  const lines = [
    ...reportLines(result.report),
    ...seedReportLines(seeded.report),
    ...seeded.problems.map((problem) => `媒体登记的问题（--apply 会拒绝）：${problem}`),
    `迁移批次：${result.commands.length} 条命令，${changeSet.upserts.length} 行；投影跳过 ${projection.skipped.length} 行。`,
    comparisonLine(comparison),
  ]
  if (storeExists) lines.push('注意：data/store/world.sqlite 已经存在，--apply 会拒绝执行。')
  return { ok: comparison.ok && seeded.problems.length === 0, lines, report: result.report, comparison, storeExists, seed: seeded.report }
}

/** The library lease the caller already holds, for createStore (which takes the lease itself otherwise). */
const heldLease = (privatePaths, leaseToken) => (callback) => withLibraryOperation(privatePaths, () => callback(), { leaseToken })

/** Remove a store file this run created, its zero-length journal, and `data/store` when this run created it and it is empty. */
async function removeCreatedStore(file, createdDirectory) {
  await unlink(file).catch(() => {})
  try {
    const journal = `${file}-journal`
    const metadata = lstatSync(journal)
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === 0) await unlink(journal)
  } catch { /* Absent, or left for review. */ }
  if (createdDirectory) await rmdir(path.dirname(file)).catch(() => {})
}

/**
 * `--apply`: the six steps of the file header. Returns { lines, libraryId, revision, comparison }; a refusal or a
 * failed check throws StoreToolError after removing the new store. `libraryId`, `allocateId` and `compare` (the
 * parity check, so a test can make it fail) are injectable.
 */
export async function applyMigration(privatePaths, {
  now = new Date().toISOString(), allocateId, libraryId = uuidv7(), requestId = uuidv7(), compare = compareWithV2,
} = {}) {
  const file = storeFileOf(privatePaths)
  if (migratableState(privatePaths) === 'empty') {
    // 3C-4d: nothing to migrate: an empty library in the formal model (./store-init.mjs takes the lease and decides again).
    const { createEmptyLibrary } = await import('./store-init.mjs')
    const created = await createEmptyLibrary(privatePaths, { now, libraryId, requestId, actor: MIGRATION_ACTOR })
    return {
      lines: [`私人根里没有任何数据：已建立空的新库 data/store/world.sqlite：库 id ${created.libraryId}，修订号 ${created.revision}。`],
      libraryId: created.libraryId, revision: created.revision, comparison: { ok: true, canonical: true, baseline: true }, empty: true,
    }
  }
  const { values, bytes } = await readV2Inputs(privatePaths)
  const result = migrationOf(values, { now, allocateId })
  return withLibraryOperation(privatePaths, async (leaseToken) => {
    // 3C-4d: a media task left unfinished in V2 mode could not be finished in the new library: refused first.
    try { await assertMediaJobsClear(privatePaths) } catch (error) {
      if (error?.code === 'E_MEDIA_JOB_PENDING') throw new StoreToolError('E_MEDIA_JOB_PENDING', ['这个私人库还有没有完成的媒体任务。请先完成或放弃它，再迁移。'])
      throw error
    }
    // 3C-4c: the media registry is seeded from the Inbox and the media files under the same lease, and written in the
    // store's first transaction with the rows (design v2 §5). A problem refuses the migration before anything exists.
    const seeded = await seedMediaRegistry({
      privatePaths, places: values.places, media: values.media, records: mediaRecordsOf(createdRowsOf(result.commands)),
      index: await readMediaSourceIndex(privatePaths),
    })
    if (seeded.problems.length) throw new StoreToolError('E_MEDIA_SEED', seeded.problems)
    const directory = path.dirname(file)
    const createdDirectory = await stat(directory).then(() => false, () => true)
    mkdirSync(directory, { recursive: true })
    let handle
    try {
      handle = await createStore(file, {
        libraryId, policy: OFFICIAL_POLICY, now: () => now, lock: heldLease(privatePaths, leaseToken),
        initial: {
          requestId, kind: MIGRATION_KIND, actor: MIGRATION_ACTOR, commands: result.commands,
          ...(Object.keys(seeded.media).length ? { media: seeded.media } : {}),
        },
      })
    } catch (error) {
      if (createdDirectory) await rmdir(directory).catch(() => {})
      if (error?.code === 'E_STORE_EXISTS') throw new StoreToolError('E_STORE_EXISTS', ['data/store/world.sqlite 已经存在，没有改动它。'])
      throw error
    }
    let comparison, revision
    try {
      try {
        const identities = result.manifest.identities.map(({ kind, sourceId, recordId, id }) => ({ kind, sourceId, recordId, id }))
        if (identities.length) await handle.putIdMappings(identities)
      } finally { await handle.close() }
      const reopened = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
      try {
        if (reopened.diagnostic) throw new StoreToolError('E_STORE_REOPEN', [`重新打开新库失败：${reopened.diagnostic.code}`])
        const rows = reopened.readRowsUnchecked()
        revision = rows.revision
        comparison = compare(projectToV2Files(rows).projection, values)
      } finally { await reopened.close() }
      if (!comparison.ok) throw new StoreToolError('E_MIGRATION_MISMATCH', [comparisonLine(comparison)])
      if (!await v2FilesUnchanged(privatePaths, bytes)) throw new StoreToolError('E_V2_CHANGED', ['迁移期间 data/v2/ 的文件发生了变化。'])
    } catch (error) {
      await removeCreatedStore(file, createdDirectory)
      throw error
    }
    return {
      lines: [...reportLines(result.report), ...seedReportLines(seeded.report), comparisonLine(comparison),`已创建 data/store/world.sqlite：库 id ${libraryId}，修订号 ${revision}。`],
      libraryId, revision, comparison,
    }
  })
}

const printLines = (lines, log) => { for (const line of lines) log(line) }

/** The command line: returns the exit code. */
export async function runMigrateCli(argv, { privatePaths = getPrivatePaths(), log = console.log, logError = console.error } = {}) {
  const unknown = argv.filter((arg) => arg !== '--apply')
  if (unknown.length) {
    logError(`[store:migrate] 无法识别的参数：${unknown.join(' ')}\n用法：npm run store:migrate [-- --apply]`)
    return 1
  }
  log(`StarMap store:migrate\n私人根：${privatePaths.root}`)
  try {
    if (!argv.includes('--apply')) {
      const preview = await previewMigration(privatePaths)
      printLines(preview.lines, log)
      log(preview.ok
        ? '\n预演通过，没有写入任何文件。确认后运行：npm run store:migrate -- --apply'
        : '\n预演的比对没有通过，--apply 会失败。没有写入任何文件。')
      return preview.ok ? 0 : 1
    }
    if (privateDataSource(privatePaths) === 'store') {
      logError('[store:migrate] data/store/world.sqlite 已经存在，拒绝执行，没有改动它。')
      return 1
    }
    const applied = await applyMigration(privatePaths)
    printLines(applied.lines, log)
    log('\n新库已建立，个人数据从此写入新库。开发服务器开着时页面会自动切换，不用重启；V2 文件保持原样，可以留作迁移前的备份。需要 V2 格式时运行 npm run store:export-v2。')
    return 0
  } catch (error) {
    if (error instanceof StoreToolError) {
      logError(`[store:migrate] ${error.code}${error.problems.length ? `（${error.problems.length} 项）` : ''}，没有写入任何文件：`)
      printLines(error.problems.map((problem) => `  - ${problem}`), logError)
    } else {
      logError(`[store:migrate] 失败：${error?.code ?? error?.name ?? '未知错误'}${error?.path ? ` ${error.path}` : ''}。没有留下新库。`)
    }
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runMigrateCli(process.argv.slice(2))
}
