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
 *   bindings need --accept-folder-bindings and its source matches --accept-source-matches; --reimport <path> marks Inbox
 *   paths explicit: each becomes a new record (even content deleted before), appended to its city order.
 * - --reread <path> (an Inbox file or folder; repeatable) re-reads the descriptions of the records of the present
 *   sources there instead of importing: media:check lists the differences, media:import writes them.
 * Paths are Inbox-relative or start with MediaInbox/. Exit codes: 0 done or nothing to do; 1 problems to handle, or a
 * failure; 2 confirmations missing (nothing written).
 */
import path from 'node:path'
import { sha256File } from './file-hash.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { assertMediaJobsClear } from './media-job-store.mjs'
import { MEDIA_KINDS, createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { INBOX_PREFIX, pathKeyOf } from './store-media-registry.mjs'
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

/** The command line as { flags, reread, reimport } or { usage } (an unknown option, a missing or unsafe path). */
export function parseStoreMediaArgs(argv) {
  const flags = new Set()
  const values = { '--reread': [], '--reimport': [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (FLAGS.includes(arg)) { flags.add(arg); continue }
    if (!VALUE_OPTIONS.includes(arg)) return { usage: `不认识的参数：${arg}` }
    const value = argv[index + 1]
    index += 1
    const portable = inboxPathOf(value)
    if (!portable) return { usage: `${arg} 后面要跟投递箱里的文件或文件夹（相对投递箱，或以 MediaInbox/ 开头）。` }
    values[arg].push(portable)
  }
  if (values['--reread'].length && values['--reimport'].length) return { usage: '--reread 与 --reimport 不能同时使用。' }
  return { flags, reread: values['--reread'], reimport: values['--reimport'] }
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

const rereadLines = (plan, apply) => {
  const lines = [`重新读取说明：${plan.records.length} 条资料，其中 ${plan.records.filter((record) => record.changes.length).length} 条有变化。`]
  for (const record of plan.records.filter((item) => item.changes.length)) lines.push(`- ${record.sources.join('、')}：${record.changes.join('、')}`)
  if (plan.conflicts.length) {
    lines.push(`\n同一条资料的来源说明互相冲突，没有更新（${plan.conflicts.length}）：`)
    for (const conflict of plan.conflicts) lines.push(`- ${conflict.sources.join('、')}`)
  }
  if (plan.problems.length) lines.push(`\n需要处理（${plan.problems.length}）：`, ...plan.problems.map((problem) => `- ${problem}`))
  if (!apply && plan.records.some((record) => record.changes.length)) lines.push('\n确认无误后运行 npm run media:import -- --reread <路径> 写入。')
  return lines
}

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
        const plan = await service.planReread({ paths: args.reread })
        for (const line of rereadLines(plan, false)) log(line)
        return plan.problems.length ? 1 : 0
      }
      const plan = await service.planImport({ explicitPaths: args.reimport, blockOnWarnings: false })
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
        const result = await service.rereadDescriptions({ paths: args.reread, requestId: uuidv7(), leaseToken: lease })
        for (const line of rereadLines(result.plan, true)) log(line)
        log(result.committed ? `\n已写入（修订号 ${result.revision}）。` : '\n没有需要写入的变化。')
        return result.plan.problems.length || result.plan.conflicts.length ? 1 : 0
      }
      const result = await service.importInbox({
        requestId: uuidv7(), kind: MEDIA_KINDS.cli, actor: 'media-import', leaseToken: lease, explicitPaths: args.reimport, blockOnWarnings: false,
        acceptFolderBindings: args.flags.has('--accept-folder-bindings'), acceptSourceMatches: args.flags.has('--accept-source-matches'),
        // A --reimport path the scan does not find gives no record: refused before anything is written.
        expect: (plan) => {
          const scanned = new Set(plan.scan.facts.map((fact) => fact.pathKey))
          const missing = args.reimport.filter((value) => !scanned.has(pathKeyOf(value)))
          if (missing.length) {
            const error = new Error(`--reimport 的路径不在投递箱中：${missing.map((value) => value.slice(INBOX_PREFIX.length)).join('、')}`)
            error.code = 'E_ARGUMENT'
            throw error
          }
        },
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
    } catch (error) {
      if (error?.code === 'E_ARGUMENT') {
        logError(`[import-media] ${error.message}`)
        return 1
      }
      throw error
    } finally { await handle.close() }
  }, { leaseToken })
}
