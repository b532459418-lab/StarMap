/**
 * `npm run media:check` and `npm run media:import` in the new-library mode (3C-4c, design v2 §3 to §5): ./import-media.mjs
 * hands over to runStoreMediaCli when the private root holds a new library. V2 mode is unchanged.
 *
 * - media:check (no --apply) is read-only: the store is opened read-only (no writer session, no SQLite write lock, no
 *   library lease), the Inbox is scanned against the registry and the plan printed. Nothing is written, so it runs next
 *   to the dev server. --verify also hashes every generated file the registry records and the files of completed media
 *   tasks' receipts (reminders only, the exit code does not change).
 * - media:import (--apply) takes the library lease (or the one STARMAP_LIBRARY_LEASE names), refuses while a media task
 *   is unfinished, opens the store for writing without a writer session and imports with the media service (one commit;
 *   kind starmap.media.cli-import). Uncertain information does not block (as V2's command line). The plan's folder
 *   bindings need --accept-folder-bindings and its source matches --accept-source-matches.
 * - --reimport <path> (3C-5 F, the page's contract): only the given Inbox files are imported, each a new record (even
 *   content deleted before), appended to its city order; the rest of the Inbox, the registry and the scan cache stay as
 *   they are. media:check prints the preview and its digest; media:import --reimport <path> --digest <digest> writes it
 *   only when the plan computed again under the lease has that digest (any Inbox file; a path not in the Inbox is
 *   refused).
 * - --reread <path> (an Inbox file or folder; repeatable) re-reads the descriptions of the records of the present
 *   sources there instead of importing: media:check lists the differences (each field's value now and the Inbox's) and
 *   prints the preview digest; media:import --reread <path> --digest <digest> writes them only when the plan computed
 *   again under the lease has that digest (3C-5 F, the page's contract; exit 2 without it, or when it changed).
 * Paths are Inbox-relative or start with MediaInbox/. Exit codes: 0 done or nothing to do; 1 problems to handle, or a
 * failure; 2 confirmations missing, or a preview digest missing or no longer valid (nothing written).
 */
import path from 'node:path'
import { sha256File } from './file-hash.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { MEDIA_KINDS, createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { INBOX_PREFIX } from './store-media-registry.mjs'
import { isPlanDigest } from './media-digest.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

/**
 * 3C-4d: why a private root that is not a store cannot import, by state (./private-data-source.mjs). media:check prints it
 * after its read-only preflight; media:import refuses with it (exit code 2).
 */
export const NOT_A_STORE_IMPORT_MESSAGES = Object.freeze({
  'migration-required': '个人数据还没有迁移到新库，没有导入任何媒体。先按 docs/local-backup.md 备份（npm run backup -- create），再运行 npm run store:migrate -- --apply；之后再导入。',
  'needs-recovery': '私人目录的 data/store/ 里有残留的文件，还没有可用的新库，没有导入任何媒体。请先运行 npm run library:recover。',
  empty: '这个私人根还没有新库，没有导入任何媒体。启动一次个人开发服务器（npm run dev:personal）会建立空的新库；也可以运行 npm run store:migrate -- --apply。',
})

const VALUE_OPTIONS = Object.freeze(['--reread', '--reimport'])
const FLAGS = Object.freeze(['--apply', '--verify', '--accept-folder-bindings', '--accept-source-matches'])

/**
 * The command line as { flags, reread, reimport, digest } or { usage } (an unknown option, a missing or unsafe path, a
 * malformed digest). 3C-5 F: `--digest <hex>` is the preview digest media:check printed, handed back to media:import.
 */
export function parseStoreMediaArgs(argv) {
  const flags = new Set()
  const values = { '--reread': [], '--reimport': [] }
  let digest
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (FLAGS.includes(arg)) { flags.add(arg); continue }
    if (arg === '--digest') {
      const value = argv[index + 1]
      index += 1
      if (digest !== undefined) return { usage: '--digest 只能给一次。' }
      if (!isPlanDigest(value)) return { usage: '--digest 后面要跟 media:check 打印的预览摘要（64 位小写十六进制）。' }
      digest = value
      continue
    }
    if (!VALUE_OPTIONS.includes(arg)) return { usage: `不认识的参数：${arg}` }
    const value = argv[index + 1]
    index += 1
    const portable = inboxPathOf(value)
    if (!portable) return { usage: `${arg} 后面要跟投递箱里的文件或文件夹（相对投递箱，或以 MediaInbox/ 开头）。` }
    values[arg].push(portable)
  }
  if (values['--reread'].length && values['--reimport'].length) return { usage: '--reread 与 --reimport 不能同时使用。' }
  if (digest !== undefined && !values['--reread'].length && !values['--reimport'].length) return { usage: '--digest 只能和 --reread 或 --reimport 一起用。' }
  if (digest !== undefined && !flags.has('--apply')) return { usage: '--digest 只在写入（npm run media:import）时使用；media:check 会打印它。' }
  return { flags, reread: values['--reread'], reimport: values['--reimport'], digest }
}

/** A portable `MediaInbox/…` path from an argument (either slash), or undefined when it leaves the Inbox. */
function inboxPathOf(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const segments = value.trim().split(/[\\/]+/).filter(Boolean)
  if (segments[0]?.toLowerCase() === 'mediainbox') segments.shift()
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..' || segment.includes(':'))) return undefined
  return `${INBOX_PREFIX}${segments.join('/')}`
}

/** --verify: every generated file the registry records, hashed and compared. Lines of reminders. */
async function verifyGeneratedFiles(privatePaths, registry) {
  const lines = []
  let checked = 0
  for (const file of registry.files) {
    for (const output of file.outputs) {
      checked += 1
      const target = path.join(privatePaths.root, ...file.directory.split('/'), output.name)
      let sha256
      try { sha256 = await sha256File(target) } catch { sha256 = undefined }
      if (sha256 !== output.sha256) lines.push(`提醒：${file.directory}/${output.name} ${sha256 === undefined ? '不存在或无法读取' : '的内容与登记不一致'}。`)
    }
  }
  return [`校验：核对了新库登记的 ${checked} 个生成文件。`, ...lines]
}

/** A value of a re-read difference as the command line prints it; 3C-5 G: an absent place is 无 (media without a place). */
const valueText = (value, field) => (value === null ? (field === 'place' ? '无' : '（空）') : typeof value === 'string' ? value : JSON.stringify(value))

const rereadLines = (plan, apply) => {
  const changed = plan.records.filter((record) => record.changes.length)
  const lines = [`重新读取说明：${plan.records.length} 条资料，其中 ${changed.length} 条有变化。`]
  for (const record of changed) {
    lines.push(`- ${record.sources.join('、')}：${record.changes.join('、')}`)
    for (const entry of record.diff) lines.push(`    ${entry.field}：${valueText(entry.from, entry.field)} → ${valueText(entry.to, entry.field)}`)
  }
  if (plan.conflicts.length) {
    lines.push(`
同一条资料的来源说明互相冲突，没有更新（${plan.conflicts.length}）：`)
    for (const conflict of plan.conflicts) lines.push(`- ${conflict.sources.map((source) => source.path).join('、')}`)
  }
  if (plan.withoutSource.length) lines.push(`
没有在投递箱中的来源、不能重新读取的资料：${plan.withoutSource.length} 条。`)
  if (plan.problems.length) lines.push(`
需要处理（${plan.problems.length}）：`, ...plan.problems.map((problem) => `- ${problem.line}`))
  if (!apply) {
    lines.push(`
预览摘要：${plan.digest}`)
    if (plan.records.some((record) => record.changes.length || record.seqs.length)) {
      lines.push(`确认无误后运行 npm run media:import -- --reread <同样的路径> --digest ${plan.digest} 写入（应用里的修改会被说明文件的值覆盖）。`)
    }
  }
  return lines
}

const REIMPORT_REASONS = Object.freeze({
  'same-path': '之前彻底删除过，在原来的位置又出现了',
  'new-path': '新位置，内容与彻底删除过的一张相同',
  live: '已经是一条资料的来源，不会重复导入',
  any: '投递箱里的文件',
})

/** The lines of a re-import preview (3C-5 F: only the given files; the rest of the Inbox is left alone). */
const reimportLines = (preview, apply) => {
  const lines = [`重新导入：只导入给出的 ${preview.files.length} 个文件，投递箱里的其他文件不受影响。`]
  for (const file of preview.files) {
    const record = preview.records.find((item) => item.pathKey === file.pathKey)
    lines.push(`- ${file.path}：${REIMPORT_REASONS[file.reason]}${record ? `；成为一条新资料（${record.kind}，${record.reusesFiles ? '复用已有的生成文件' : '重新生成文件'}），加到所在城市排序的末尾` : ''}${file.pendingDeletion ? '；它排队等待的删除会取消' : ''}。`)
  }
  if (preview.otherNewFiles) lines.push(`\n投递箱里另有 ${preview.otherNewFiles} 个新文件没有导入，留给下一次普通导入。`)
  const { blockers } = preview
  if (blockers.errors.length) lines.push(`\n需要处理（${blockers.errors.length}）：`, ...blockers.errors.map((error) => `- ${error}`))
  if (blockers.uncertain.length) lines.push(`\n提醒（${blockers.uncertain.length}）：`, ...blockers.uncertain.map((warning) => `- ${warning}`))
  if (blockers.bindings.length) {
    lines.push(`\n待确认的文件夹绑定（${blockers.bindings.length}）：确认之后加 --accept-folder-bindings。`, ...blockers.bindings.map((pin) => `- ${pin.folder.slice(INBOX_PREFIX.length)} → ${pin.names?.['zh-Hans'] ?? ''} / ${pin.names?.en ?? ''}`))
  }
  if (!apply) {
    lines.push(`\n预览摘要：${preview.digest}`)
    if (preview.records.length) lines.push(`确认无误后运行 npm run media:import -- --reimport <同样的路径> --digest ${preview.digest} 写入。`)
  }
  return lines
}

/** A refusal of a re-import's eligibility, as the command line says it. */
const REIMPORT_REFUSALS = Object.freeze({
  missing: '--reimport 的路径不在投递箱中。',
  live: '--reimport 的文件已经是一条资料的来源。',
  'not-deleted': '--reimport 的文件不是彻底删除过的文件。',
})

/**
 * Run media:check / media:import on the new library of `privatePaths`. `argv` are the arguments after the script;
 * `leaseToken` a lease the caller holds (STARMAP_LIBRARY_LEASE). Resolves the exit code.
 */
export async function runStoreMediaCli({ privatePaths, argv = [], log = console.log, logError = console.error, leaseToken, allocateId } = {}) {
  const args = parseStoreMediaArgs(argv)
  if (args.usage) {
    logError(`[import-media] ${args.usage}`)
    return 1
  }
  const apply = args.flags.has('--apply')
  // 3C-5 F: writing a re-read or a re-import needs the digest of the preview the user checked (nothing is written without it).
  if (apply && (args.reread.length || args.reimport.length) && !args.digest) {
    const option = args.reread.length ? '--reread' : '--reimport'
    logError(`[import-media] 写入 ${option} 要带 --digest <预览摘要>：先运行 npm run media:check -- ${option} <路径>，核对后把它打印的预览摘要交回。没有写入。`)
    return 2
  }
  const file = storeFileOf(privatePaths)
  const open = () => {
    const handle = openStore(file, apply ? { privatePaths, policy: OFFICIAL_POLICY, writerSession: false } : { readOnly: true, policy: OFFICIAL_POLICY })
    if (handle.diagnostic) {
      const { code } = handle.diagnostic
      void handle.close()
      logError(`[import-media] 新库没有通过打开检查（${code}）。${code === 'E_STORE_UPGRADE_REQUIRED' ? '请先运行 npm run store:upgrade。' : ''}`)
      return undefined
    }
    return handle
  }

  if (!apply) {
    const handle = open()
    if (!handle) return 1
    try {
      const store = handleMediaStore(handle)
      const service = createMediaService({ privatePaths, store })
      if (args.reread.length) {
        const plan = await service.planReread({ scope: { paths: args.reread } })
        for (const line of rereadLines(plan, false)) log(line)
        return plan.problems.length ? 1 : 0
      }
      if (args.reimport.length) {
        let preview
        try {
          preview = await service.planReimport({ paths: args.reimport, onlyDeleted: false, blockOnWarnings: false })
        } catch (error) {
          if (error?.code !== 'E_MEDIA_REIMPORT_NOT_DELETED') throw error
          logError(`[import-media] ${REIMPORT_REFUSALS[error.params?.reason] ?? error.message}`)
          return 1
        }
        for (const line of reimportLines(preview, false)) log(line)
        return preview.blockers.errors.length ? 1 : 0
      }
      const plan = await service.planImport({ blockOnWarnings: false })
      for (const line of service.reportLines(plan)) log(line)
      const pending = plan.registry.pendingFileOps.length
      if (pending) log(`\n有 ${pending} 个文件等待删除，下一次媒体写入（或 npm run library:recover -- --confirm）会执行。`)
      if (args.flags.has('--verify')) {
        for (const line of await verifyGeneratedFiles(privatePaths, plan.registry)) log(line)
        await (await import('./media-job-service.mjs')).reportMediaJobReceipts(privatePaths, log)
      }
      if (plan.blockers.errors.length) return 1
      log(plan.blockers.bindings.length || plan.blockers.matches.length
        ? '\n预检通过，但有需要确认的文件夹绑定或来源匹配：确认之后运行 npm run media:import -- --accept-folder-bindings --accept-source-matches（按需要选用）。'
        : '\n预检通过。确认无误后运行 npm run media:import。')
      return 0
    } finally { await handle.close() }
  }

  return withLibraryOperation(privatePaths, async (lease) => {
    await assertMediaJobsClear(privatePaths)
    const handle = open()
    if (!handle) return 1
    try {
      const store = handleMediaStore(handle)
      const service = createMediaService({ privatePaths, store, ...(allocateId ? { allocateId } : {}) })
      if (args.reread.length) {
        let result
        try {
          result = await service.rereadDescriptions({ scope: { paths: args.reread }, planDigest: args.digest, requestId: uuidv7(), leaseToken: lease })
        } catch (error) {
          if (error?.code !== 'E_MEDIA_PREVIEW_STALE') throw error
          logError('[import-media] 预览之后投递箱或新库有了变化，没有写入。请重新运行 npm run media:check -- --reread <路径>，核对后交回新的预览摘要。')
          return 2
        }
        for (const line of rereadLines(result.plan, true)) log(line)
        log(result.committed ? `\n已写入（修订号 ${result.revision}）。` : '\n没有需要写入的变化。')
        return result.plan.problems.length || result.plan.conflicts.length ? 1 : 0
      }
      if (args.reimport.length) {
        // 3C-5 F: only the given files (an explicit-only import), with the preview's digest checked under the lease.
        let result
        try {
          result = await service.reimportFiles({
            paths: args.reimport, planDigest: args.digest, onlyDeleted: false, requestId: uuidv7(), kind: MEDIA_KINDS.cli, actor: 'media-import',
            leaseToken: lease, acceptFolderBindings: args.flags.has('--accept-folder-bindings'), blockOnWarnings: false,
          })
        } catch (error) {
          if (error?.code === 'E_MEDIA_PREVIEW_STALE') {
            logError('[import-media] 预览之后投递箱或新库有了变化，没有写入。请重新运行 npm run media:check -- --reimport <路径>，核对后交回新的预览摘要。')
            return 2
          }
          if (error?.code !== 'E_MEDIA_REIMPORT_NOT_DELETED') throw error
          logError(`[import-media] ${REIMPORT_REFUSALS[error.params?.reason] ?? error.message}`)
          return 1
        }
        if (result.blocked) {
          const { blockers } = result.plan
          for (const error of blockers.errors) log(`- ${error}`)
          if (blockers.errors.length) return 1
          log('\n没有写入。有待确认的文件夹绑定：确认之后加 --accept-folder-bindings。')
          return 2
        }
        log(result.committed ? `重新导入完成（修订号 ${result.revision}）。` : '没有需要导入的文件：它已经是一条资料的来源。')
        return 0
      }
      const result = await service.importInbox({
        requestId: uuidv7(), kind: MEDIA_KINDS.cli, actor: 'media-import', leaseToken: lease, blockOnWarnings: false,
        acceptFolderBindings: args.flags.has('--accept-folder-bindings'), acceptSourceMatches: args.flags.has('--accept-source-matches'),
      })
      for (const line of service.reportLines(result.plan)) log(line)
      if (result.drained?.paused) log('\n备份正在复制媒体，待删文件暂缓，下一次媒体写入会执行。')
      if (result.blocked) {
        const { blockers } = result.plan
        if (blockers.errors.length) return 1
        log(`\n没有写入。${blockers.bindings.length ? '有待确认的文件夹绑定：确认之后加 --accept-folder-bindings。' : ''}${blockers.matches.length ? '有待确认的来源匹配：确认之后加 --accept-source-matches。' : ''}`)
        return 2
      }
      log(result.committed ? `\n导入完成（修订号 ${result.revision}）。` : '\n没有需要导入的变化。')
      return 0
    } finally { await handle.close() }
  }, { leaseToken })
}
