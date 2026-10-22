/**
 * The local editor plugin's side of the new library (3C-3, 3C-4a; design 3B §4.4, §4.7 and v1.1 §16.2-4), the only way
 * personal data is written since 3C-4d.
 *
 * Why a separate file: the plugin imports sharp / undici / world-countries and resolves the private root at module
 * scope, so it cannot be loaded under node --test as it is. Like ./v2-editor-store.mjs for V2, this file holds what the
 * plugin does with the store, and the end-to-end tests drive it directly on temporary private roots.
 *
 * - One writable connection per dev server process (`open`): opened when the server starts, kept until it closes
 *   (`close`, which writes the clean-shutdown mark). A store that another process is writing makes the open
 *   E_STORE_BUSY; it is retried a few times (OPEN_RETRIES × OPEN_RETRY_DELAY_MS) and then reported. An open failure is
 *   an error the App shows: the mode never falls back to V2.
 * - A damaged store (3C-4b, design 3B §5 "打开检查失败 → 只读"): when the open check fails with E_STORE_CORRUPT (the
 *   quick_check after an unclean shutdown) but the store can still be read, the session keeps the read-only handle. The
 *   App shows the projected data as usual, the virtual module says so (`readOnly`, the App's persistent notice), and
 *   every write is refused with 409 E_STORE_READ_ONLY (a replay of a request committed before still answers with its
 *   receipt). The same happens when corruption is found while running (the host turns the handle read-only). Every
 *   other open diagnostic (E_STORE_TOO_NEW, E_STORE_SCHEMA, …) and a store that cannot be read stay errors.
 * - Read model (3C-5B; `moduleExports`): the read model `starmap.read-model` of the store (the host's readModel(): its
 *   rows with the header) and the store-wide revision. 3C-5 C1: the cache holds the live index of the read model
 *   (src/worldgraph/readModel/liveIndex.ts, built on first use): the native writes plan on it, every commit moves it on
 *   with the commit's changed rows, and the read model is built from it when asked for. The App reads the read model
 *   through the official view. 3C-5 C2: the session keeps no V2 view. Where the V2 shape is still needed (PUT /state,
 *   GET /state, the media rules of the media service and tasks, tests) it is generated from the read model through the
 *   official view when asked for (store-projection.mjs projectToV2Files), never cached and never read from data/v2/.
 * - Incremental refresh (3C-4a, 3C-5B): after a committed write the read model of the new revision is the old one with
 *   the commit's changed rows applied (the live index, or applyReadModelDelta; the host returns them with the receipt).
 *   The store is not read again. The cache is keyed by the
 *   store's library id, revision and restore mark: when they differ from the store's (another process wrote, the store
 *   was restored), the cache is dropped and the store read again. With STARMAP_STORE_VERIFY=1 (tests, development; or
 *   the `verify` option) every commit is followed by a fresh read compared with the cache (the read model): a difference
 *   is E_STORE_VERIFY (500 E_STORE_FAILED), the fresh read replaces the cache, and the log says so.
 * - Writes (`writeRoute`): the editor endpoints. 3C-5 C1, C2: every editor endpoint but PUT /state is store-native
 *   (src/data/editor/native/): it plans its commands on the live index with the official reader. PUT /state, which the
 *   page no longer sends (sub-batch E removes it), still runs the V2 write function of ./v2-editor-store.mjs. Media uploads,
 *   imports, deletions and media tasks (3C-4c) go through ./store-media-endpoints.mjs, ./media-job-service.mjs and the
 *   media service with `mediaStore()`; their commits are queued with the editor writes.
 * - Read-only sessions (`readOnly: true`, 3C-4b): `build:personal` reads the store while a dev server may have it open
 *   for writing. The store is opened read-only (openStore `readOnly`): no writer session, so the clean-shutdown mark is
 *   neither read nor written, no SQLite write lock is taken, the library lock is not probed and quick_check does not
 *   run. A read that meets a writer's commit (E_STORE_BUSY) is retried like a busy open. Such a session never writes
 *   and never prunes.
 *
 * One write (design 3B §4.4 and §4.5; the rules are V2's, the storage is the store):
 * 1. The request carries `x-starmap-request-id` (UUIDv7, one per user action, kept on retries) and
 *    `x-starmap-base-revision` (the store revision the page was built from, or the revision a previous write of the
 *    same page answered). Without them the page predates the new-library mode: E_STALE (reload). Malformed:
 *    E_REQUEST_INVALID.
 * 2. In this process one write runs at a time. The request id is looked up first: a committed request with the same
 *    intent (`kind` carries the route and a SHA-256 of the request body) and base revision answers with its original
 *    response (kept in memory for the last REMEMBERED_RESPONSES requests; after a restart, the receipt only) and writes
 *    nothing; a different intent is E_OPERATION_CONFLICT.
 * 3. The base revision must be the cached view's revision (E_STALE otherwise). The V2 write function runs on the view;
 *    its refusal is returned as it is (400, or 409 for a place or journey choice).
 * 4. diffV2ToCommands turns the view before and after into commands (in a read transaction, at the base revision),
 *    and they are committed on the base revision; the host checks the receipt, the revision and the plan again inside
 *    BEGIN IMMEDIATE.
 * 5. Success: the cache becomes the files after the write at the new revision; the response is V2's result plus the
 *    revision and the receipt. The plugin invalidates the virtual module.
 * Outcomes: 409 E_STALE, E_OPERATION_CONFLICT, E_LIBRARY_BUSY, E_STORE_BUSY (confirmed not committed); 500
 * E_OUTCOME_UNKNOWN (the client retries once with the same request id); 500 E_STORE_FAILED for any other failure
 * (E_VIEW_MISMATCH also drops the cache).
 *
 * Record retention (3C-4b; design 3B §4.6 with v1.1 §16.2-5 and -6): the host's pruneLogs (receipts by the rule that
 * keeps more, op_log by the rule that keeps fewer, then incremental_vacuum) runs in this process, on this connection,
 * when the session opens and after every PRUNE_EVERY_COMMITS committed writes. Each run is one small step
 * (PRUNE_STEP: one pruning transaction of at most `batchSize` rows per table and one vacuum transaction of at most
 * `vacuumPages` pages). It is queued behind the writes of this process and starts only after the response of the write
 * that triggered it (setImmediate), so it never runs inside a write nor delays its response; a write that arrives
 * meanwhile waits for that one step. While a run reports work left (`done: false`), every following commit runs the
 * next step. A failed run (another process holds the library lock or the store's write lock) is logged and tried again
 * at the next trigger. Read-only sessions never prune.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { storeFileOf } from './private-data-source.mjs'
import { skippedCounts, projectToV2Files } from './store-projection.mjs'
import { StoreHostError, openStore } from './store-host.mjs'
import { V2_EDITOR_ROUTES, createV2WriteContext, v2FailureResponse } from './v2-editor-store.mjs'
import { isUuidV7, uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { diffV2ToCommands } from '../src/data/store/diffV2.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { formalStateOfReadModel } from '../src/worldgraph/readModel/build.ts'
import { applyReadModelDelta } from '../src/worldgraph/readModel/delta.ts'
import { liveReadModelIndex } from '../src/worldgraph/readModel/liveIndex.ts'
import { officialReader } from '../src/data/store/officialReader.ts'
import { NATIVE_WRITES } from '../src/data/editor/native/routes.ts'
import { jsonKey } from '../src/worldgraph/store/primitives.ts'
import { V2WriteError, errorBody, readEditorStateV1 } from '../src/data/v2write/index.ts'

/** Attempts to open a store another process is writing: the first one and OPEN_RETRIES more, OPEN_RETRY_DELAY_MS apart. */
export const OPEN_RETRIES = 5
export const OPEN_RETRY_DELAY_MS = 200
/** Responses of committed requests kept for replays in this process. */
export const REMEMBERED_RESPONSES = 64
/** Committed writes between two record pruning runs (a run also follows the open, and every commit while work is left). */
export const PRUNE_EVERY_COMMITS = 200
/**
 * One pruning run: one transaction deleting at most `batchSize` rows per table, one incremental_vacuum of `vacuumPages`
 * (1 MiB at 4 KiB pages). Smaller than the host's defaults: a run is two small write transactions, about two commits.
 */
export const PRUNE_STEP = Object.freeze({ batchSize: 200, vacuumPages: 256 })

const ms = (started) => Math.round((performance.now() - started) * 10) / 10

/** What to do about an open failure, by code (shown by the App through the error overlay, and logged). */
const OPEN_HINTS = Object.freeze({
  E_STORE_BUSY: '另一个进程正在写入这个库（例如另一个开发服务器或 store:* 命令）。关掉它之后刷新页面。',
  E_STORE_ALREADY_OPEN: '这个进程已经打开了这个库。重启开发服务器。',
  E_STORE_NOT_FOUND: 'data/store/world.sqlite 不见了。重启开发服务器。',
  E_STORE_TOO_NEW: '库的格式比这个版本的程序新。请使用更新的 StarMap。',
  E_STORE_UPGRADE_REQUIRED: '库是旧的存储格式。停掉开发服务器，在 01_Web 下运行 npm run store:upgrade，再重新启动。',
  E_STORE_CORRUPT: '库检查没有通过。请从备份恢复（npm run store:restore），或在 01_Web 下运行 npm run library:recover 查看。',
})

/** An open failure as one message: what failed, why the App stops here, and what to do. */
export function storeOpenMessage(code) {
  return [
    `[StarMap] 新库模式：打开 data/store/world.sqlite 失败（${code}）。`,
    '新库模式不会回落到 data/v2/ 的文件，以免同一个私人根出现两个写入源。',
    OPEN_HINTS[code] ?? '请检查这个库，或从备份恢复（npm run store:restore）。',
  ].join('\n')
}

/**
 * Write endpoints of the new-library mode: `METHOD /path` → the request `kind` prefix. They are the eight editor
 * endpoints of V2 (./v2-editor-store.mjs, same functions and statuses); the want-to-go update keeps its 3C-3 kind.
 */
export const STORE_WRITE_ROUTES = Object.freeze({
  'PUT /__travelatlas/editor/state': 'starmap.editor.state',
  'POST /__travelatlas/editor/records': 'starmap.editor.records',
  'POST /__travelatlas/editor/countries': 'starmap.editor.countries',
  'POST /__travelatlas/editor/countries/delete': 'starmap.editor.countries.delete',
  'POST /__travelatlas/editor/wanttogo': 'starmap.editor.wanttogo',
  'POST /__travelatlas/editor/wanttogo/update': 'starmap.wanttogo.update',
  'POST /__travelatlas/editor/wanttogo/delete': 'starmap.editor.wanttogo.delete',
  'POST /__travelatlas/editor/wanttogo/convert': 'starmap.editor.wanttogo.convert',
})

/**
 * 3C-5 C1: the store-native write endpoints (`METHOD /path` → the request `kind` prefix and the planner of
 * src/data/editor/native/routes.ts). Their kinds are those of the V2 endpoints they replace, so a request committed
 * before still answers with its receipt; the view operations are new.
 */
export const NATIVE_WRITE_ROUTES = Object.freeze({
  'POST /__travelatlas/editor/view': 'starmap.editor.view',
  'POST /__travelatlas/editor/wanttogo': 'starmap.editor.wanttogo',
  'POST /__travelatlas/editor/wanttogo/update': 'starmap.wanttogo.update',
  'POST /__travelatlas/editor/wanttogo/delete': 'starmap.editor.wanttogo.delete',
})

/** The client protocol's request headers (lowercase, as Node delivers them). */
export const STORE_REQUEST_ID_HEADER = 'x-starmap-request-id'
export const STORE_BASE_REVISION_HEADER = 'x-starmap-base-revision'
/** `kind` of a want-to-go update request (3C-3): this prefix, '@', and the SHA-256 of the request body. */
export const WANT_TO_GO_UPDATE_KIND = STORE_WRITE_ROUTES['POST /__travelatlas/editor/wanttogo/update']
const STORE_ACTOR = 'local-editor'

/** Host codes the client handles by name, with their status; every other failure is E_STORE_FAILED. */
const CLIENT_CODES = Object.freeze({
  E_STALE: 409, E_OPERATION_CONFLICT: 409, E_LIBRARY_BUSY: 409, E_STORE_BUSY: 409, E_STORE_READ_ONLY: 409, E_OUTCOME_UNKNOWN: 500,
})

/** A failure of a store read or write as the local editor's response: { status, body } (codes only, never values). */
export function storeFailureResponse(error) {
  if (error instanceof V2WriteError) return { status: CLIENT_CODES[error.code] ?? 400, body: errorBody(error) }
  const code = typeof error?.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code) ? error.code : 'E_STORE_OPEN'
  if (Object.hasOwn(CLIENT_CODES, code)) return { status: CLIENT_CODES[code], body: errorBody(new V2WriteError(code)) }
  return { status: 500, body: errorBody(new V2WriteError('E_STORE_FAILED', { code })) }
}

/** A header's text; undefined when absent, null when repeated (an array). */
const headerText = (headers, name) => {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  return value === undefined ? undefined : null
}

/**
 * `{ requestId, baseRevision }` from the request headers, or `{ failure }`: either one missing is E_STALE (a page
 * built before the new-library mode); present but malformed is E_REQUEST_INVALID.
 */
export function storeProtocolOf(headers) {
  const requestId = headerText(headers, STORE_REQUEST_ID_HEADER)
  const base = headerText(headers, STORE_BASE_REVISION_HEADER)
  if (requestId === undefined || base === undefined) return { failure: storeFailureResponse(new V2WriteError('E_STALE')) }
  if (!isUuidV7(requestId)) {
    return { failure: storeFailureResponse(new V2WriteError('E_REQUEST_INVALID', { reason: `${STORE_REQUEST_ID_HEADER} 必须是小写的 UUIDv7。` })) }
  }
  const baseRevision = typeof base === 'string' && /^(0|[1-9][0-9]*)$/.test(base) ? Number(base) : Number.NaN
  if (!Number.isSafeInteger(baseRevision)) {
    return { failure: storeFailureResponse(new V2WriteError('E_REQUEST_INVALID', { reason: `${STORE_BASE_REVISION_HEADER} 必须是非负整数。` })) }
  }
  return { requestId, baseRevision }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
/** `kind` of a request: the route's prefix, '@', and the SHA-256 of the request body (canonical JSON). */
export const storeRequestKind = (prefix, input) => `${prefix}@${sha256(jsonKey(input === undefined ? null : input))}`
/** Handle failures after which the connection must be opened again. */
const REOPEN_CODES = new Set(['E_STORE_REOPEN_REQUIRED', 'E_STORE_CLOSED'])

/** The open failure the plugin throws from the virtual module (Vite shows it), with the store code. */
export class StoreSessionError extends Error {
  constructor(code, { cause } = {}) {
    super(storeOpenMessage(code), cause === undefined ? undefined : { cause })
    this.name = 'StoreSessionError'
    this.code = code
  }
}

/** A handle that is read-only because the store is damaged: its open check failed with E_STORE_CORRUPT, or corruption was found since. */
const damaged = (opened) => opened?.readOnly === true && opened.diagnostic?.code === 'E_STORE_CORRUPT'

/** A cache key: the store's identity and revision (a restore records a new restore mark). */
const cacheKeyOf = (meta) => JSON.stringify([meta.libraryId, meta.revision, meta.restoredFrom?.restoredAt ?? null])

/**
 * Open `file` (writable, or read-only with `options.readOnly`), retrying while it is busy. A handle with an open
 * diagnostic (read-only) is closed and reported as StoreSessionError with the diagnostic's code; so is every other
 * failure. A read-only open that met a writer's commit carries the diagnostic E_STORE_BUSY: retried the same way.
 * With `acceptDamaged`, a store whose open check failed with E_STORE_CORRUPT but which can still be read (store_meta
 * reads) is returned as its read-only handle (3C-4b).
 */
export async function openStoreWithRetry(file, options, { retries = OPEN_RETRIES, retryDelayMs = OPEN_RETRY_DELAY_MS, sleep = delay } = {}, { acceptDamaged = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let handle
    try { handle = openStore(file, options) } catch (error) {
      const code = error instanceof StoreHostError ? error.code : 'E_STORE_OPEN'
      if (code === 'E_STORE_BUSY' && attempt < retries) { await sleep(retryDelayMs); continue }
      throw new StoreSessionError(code, { cause: error })
    }
    if (!handle.diagnostic) return handle
    const { code } = handle.diagnostic
    if (acceptDamaged && code === 'E_STORE_CORRUPT') {
      try {
        handle.meta()
        return handle
      } catch { /* Not even store_meta reads: an error like any other. */ }
    }
    await handle.close()
    if (code === 'E_STORE_BUSY' && attempt < retries) { await sleep(retryDelayMs); continue }
    throw new StoreSessionError(code)
  }
}

/** `read()` again while it fails with E_STORE_BUSY (a writer in another process is committing), as openStoreWithRetry. */
async function readWithRetry(read, { retries = OPEN_RETRIES, retryDelayMs = OPEN_RETRY_DELAY_MS, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return read() } catch (error) {
      if (error?.code !== 'E_STORE_BUSY' || attempt >= retries) throw error
      await sleep(retryDelayMs)
    }
  }
}

/**
 * The store session of one plugin instance. `privatePaths` is getPrivatePaths() of the private root; `now` gives the
 * host time and the time of the V2 writes (tests); `log` receives the timing lines; `retry` overrides the open retries
 * ({ retries, retryDelayMs, sleep }); `countryCatalog` is the plugin's country catalog (the V2 write context when a
 * caller gives none); `verify` compares every commit with a fresh projection (default: STARMAP_STORE_VERIFY=1);
 * `newId` gives the ids of new store rows (default UUIDv7); `nativeWrites` replaces the native planners (tests:
 * NATIVE_WRITES of src/data/editor/native/routes.ts by route); `prune` sets the record pruning schedule
 * ({ every, batchSize, vacuumPages, retention }, defaults PRUNE_EVERY_COMMITS and PRUNE_STEP, retention the host's) or
 * turns it off (false); `readOnly` opens the store read-only (`build:personal`, see the file header).
 */
export function createStoreSession(privatePaths, {
  log = console.log, now, retry, countryCatalog = new Map(), verify = process.env.STARMAP_STORE_VERIFY === '1', newId = () => uuidv7(),
  prune = {}, readOnly = false, nativeWrites = NATIVE_WRITES,
} = {}) {
  const file = storeFileOf(privatePaths)
  const hostOptions = { privatePaths, policy: OFFICIAL_POLICY, ...(now ? { now } : {}), ...(readOnly ? { readOnly: true } : {}) }
  let handle
  let opening
  let openMs
  let cache
  /** requestId → the response of a request this process committed (insertion order: oldest first). */
  const remembered = new Map()
  const pruning = prune === false || readOnly ? undefined : Object.freeze({
    every: prune.every ?? PRUNE_EVERY_COMMITS, batchSize: prune.batchSize ?? PRUNE_STEP.batchSize,
    vacuumPages: prune.vacuumPages ?? PRUNE_STEP.vacuumPages, ...(prune.retention ? { retention: prune.retention } : {}),
  })
  /** Pruning state: commits since the last run, whether the last run left work, runs so far, the last run's outcome. */
  const pruneState = { commits: 0, backlog: false, runs: 0, last: undefined }
  /** The scheduled run: { timer, done (promise), resolve } until it has finished. */
  let scheduledPrune

  /** The open handle, opening it on first use (concurrent callers share one open). */
  async function open() {
    if (handle) return handle
    opening ??= (async () => {
      const started = performance.now()
      try {
        handle = await openStoreWithRetry(file, hostOptions, retry, { acceptDamaged: !readOnly })
        openMs = ms(started)
        if (damaged(handle)) {
          log('[StarMap store] 新库没有通过打开检查（E_STORE_CORRUPT），以只读方式打开：页面照常显示数据，所有写入返回 E_STORE_READ_ONLY。'
            + '请从备份恢复（npm run store:restore），步骤见 docs/local-backup.md。')
        } else schedulePrune('open')
        return handle
      } finally { opening = undefined }
    })()
    return opening
  }

  /** One small pruning run on the open handle (queued behind this process's writes; see the file header). */
  async function pruneOnce(reason) {
    const current = handle
    if (!current || current.readOnly) return
    const started = performance.now()
    pruneState.runs++
    try {
      const result = await current.pruneLogs({
        now: now ? now() : new Date().toISOString(), batchSize: pruning.batchSize, maxSteps: 1, vacuumPages: pruning.vacuumPages,
        ...(pruning.retention ? { retention: pruning.retention } : {}),
      })
      pruneState.commits = 0
      pruneState.backlog = !result.done
      pruneState.last = Object.freeze({ reason, ...result, ms: ms(started) })
      if (result.receipts || result.opLog || result.freedPages) {
        log(`[StarMap store] 清理记录（${reason}）：回执 ${result.receipts} 条，op_log ${result.opLog} 条，`
          + `归还 ${result.freedPages} 页，${ms(started)} ms${result.done ? '' : '；还有剩余，下一次提交后继续'}`)
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'E_STORE_PRUNE'
      pruneState.last = Object.freeze({ reason, code, ms: ms(started) })
      log(`[StarMap store] 清理记录（${reason}）没有完成（${code}），下一次提交后再试。`)
      pruneState.backlog = true
      if (REOPEN_CODES.has(code)) await dropHandle()
    }
  }

  /**
   * Run pruneOnce after the current work has answered (setImmediate), queued behind this process's writes. At most one
   * run is scheduled at a time.
   */
  function schedulePrune(reason) {
    if (!pruning || scheduledPrune) return
    let resolve
    const done = new Promise((settle) => { resolve = settle })
    const timer = setImmediate(() => {
      scheduledPrune.timer = undefined
      serialized(() => pruneOnce(reason)).catch(() => {}).finally(() => { scheduledPrune = undefined; resolve() })
    })
    scheduledPrune = { timer, done, resolve }
  }
  /** After a committed write: count it, and schedule a run every `every` commits, or while the last run left work. */
  function countCommit() {
    if (!pruning) return
    pruneState.commits++
    if (pruneState.backlog || pruneState.commits >= pruning.every) schedulePrune('commits')
  }

  /** Read the store: { model, timings } (the read model of its current revision). */
  function readStore(opened) {
    const timings = {}
    if (openMs !== undefined) { timings.openMs = openMs; openMs = undefined }
    const started = performance.now()
    const model = opened.readModel()
    timings.readMs = ms(started)
    return { model, timings }
  }

  /**
   * A cache entry: the read model of one revision (`model`, or the live index it is built from) and the live index, built
   * on first use (carried on from the previous entry after a commit). An entry is replaced by the next after a commit:
   * the live index it shares has moved on then. `files`: the V2 view of the entry's read model, generated through the
   * official view each time it is asked for (3C-5 C2: never cached).
   */
  function cacheEntry(key, { model, live, timings = {} }) {
    const revision = live ? live.revision : model.revision
    return Object.freeze({
      key, revision, timings,
      get model() { return live ? live.model : model },
      get live() { return (live ??= liveReadModelIndex(model)) },
      /** The live index (3C-5B's `index`). */
      get index() { return this.live },
      get hasLive() { return live !== undefined },
      get files() {
        const started = performance.now()
        const { projection, files } = projectToV2Files(formalStateOfReadModel(this.model))
        const skipped = Object.entries(skippedCounts(projection.skipped)).map(([table, count]) => `${table} ${count}`)
        log(`[StarMap store] V2 视图（修订号 ${revision}，按需生成，不缓存）：官方视图与 serializeV2 ${ms(started)} ms`
          + (skipped.length ? `；投影跳过 ${projection.skipped.length} 行（${skipped.join('，')}）` : ''))
        return Object.freeze(files)
      },
    })
  }

  /** The cached read model at the store's current revision; projected again when the store is not the cached one. */
  /** A read of a read-only session is retried while a writer in another process commits; the dev server's is not. */
  const reading = (read) => (readOnly ? readWithRetry(read, retry) : read())

  async function snapshot() {
    const opened = await open()
    const key = cacheKeyOf(await reading(() => opened.meta()))
    if (cache?.key === key) return cache
    let read
    try { read = await reading(() => readStore(opened)) } catch (error) {
      if (error?.code !== 'E_STORE_CORRUPT') throw error
      await dropHandle()
      throw new StoreSessionError('E_STORE_CORRUPT', { cause: error })
    }
    const { model, timings } = read
    cache = cacheEntry(key, { model, timings })
    log(`[StarMap store] 读模型（修订号 ${model.revision}）：${timings.openMs === undefined ? '' : `打开 ${timings.openMs} ms，`}readModel ${timings.readMs} ms`)
    return cache
  }

  /**
   * After a write: the cache moves to the new revision with the commit's changed rows. A cache of another revision, or a
   * result without changes, drops it.
   */
  function advanceCache(opened, view, result) {
    if (result?.status !== 'committed' || !result.changes || view?.revision !== result.changes.baseRevision) { cache = undefined; return }
    const key = cacheKeyOf(opened.meta())
    if (view.hasLive) {
      const { live } = view
      live.apply(result.changes)
      cache = cacheEntry(key, { live })
    } else cache = cacheEntry(key, { model: applyReadModelDelta(view.model, result.changes) })
  }

  /**
   * STARMAP_STORE_VERIFY: the store read again (readRowsUnchecked, as its read model) must equal the cached read model
   * (built from the live index when there is one).
   */
  function verifyCache(opened) {
    const fresh = opened.readModel()
    if (cache !== undefined && isDeepStrictEqual(cache.model, fresh)) return
    cache = cacheEntry(cacheKeyOf(opened.meta()), { model: fresh })
    log(`[StarMap store] 校验失败（STARMAP_STORE_VERIFY）：修订号 ${fresh.revision} 的读模型与库不一致，已改用重新读出的读模型。`)
    const error = new Error('E_STORE_VERIFY: the store read again differs from the cached read model')
    error.code = 'E_STORE_VERIFY'
    throw error
  }

  /** Writes in this process, one at a time: the lookup, the plan and the commit of one request are never interleaved. */
  let writeTail = Promise.resolve()
  const serialized = (work) => {
    const run = writeTail.then(work, work)
    writeTail = run.catch(() => {})
    return run
  }
  /** Forget a connection that can no longer be used (closed quietly); the next use opens it again. */
  async function dropHandle() {
    const current = handle
    handle = undefined
    cache = undefined
    await current?.close().catch(() => {})
  }
  const remember = (requestId, response) => {
    remembered.set(requestId, response)
    while (remembered.size > REMEMBERED_RESPONSES) remembered.delete(remembered.keys().next().value)
  }

  /** One editor write (see the file header). Resolves `{ status, body }`. */
  function writeHandler(routeKey) {
    const route = V2_EDITOR_ROUTES[routeKey]
    const prefix = STORE_WRITE_ROUTES[routeKey]
    const label = routeKey.replace(' /__travelatlas/editor/', ' ')
    return async function write({ headers, input, ctx }) {
      const protocol = storeProtocolOf(headers)
      if (protocol.failure) return protocol.failure
      let kind
      try { kind = storeRequestKind(prefix, input) } catch { return storeFailureResponse(new V2WriteError('E_REQUEST_INVALID', { reason: '请求体不是 JSON。' })) }
      return serialized(async () => {
        const started = performance.now()
        try {
          const opened = await open()
          const previous = opened.lookup(protocol.requestId)
          if (previous.found) {
            if (previous.receipt.kind !== kind || previous.receipt.baseRevision !== protocol.baseRevision) {
              return storeFailureResponse(new V2WriteError('E_OPERATION_CONFLICT'))
            }
            const known = remembered.get(protocol.requestId)
            const body = known?.body.receipt?.requestId === protocol.requestId ? known.body : { ok: true, revision: previous.receipt.revision, receipt: previous.receipt }
            return { status: known?.status ?? route.status, body: { ...body, duplicate: true } }
          }
          // A read-only handle (a damaged store, or a build) writes nothing: confirmed not committed.
          if (opened.readOnly) return storeFailureResponse(new V2WriteError('E_STORE_READ_ONLY'))
          const view = await snapshot()
          if (view.revision !== protocol.baseRevision) return storeFailureResponse(new V2WriteError('E_STALE'))
          const writeContext = ctx ?? createV2WriteContext({ countryCatalog, ...(now ? { now: new Date(now()) } : {}) })
          let outcome
          const running = performance.now()
          const files = view.files
          try { outcome = route.run(files, input, writeContext) } catch (error) { return v2FailureResponse(error) }
          const runMs = ms(running)
          const after = { ...files, ...Object.fromEntries(outcome.writes.map((step) => [step.file, step.value])) }
          const diffing = performance.now()
          // An error thrown inside a read transaction would turn into a store error: the plan returns its failure instead.
          const plan = opened.read((reader) => {
            if (reader.revision !== protocol.baseRevision) return { failure: new V2WriteError('E_STALE') }
            try {
              return { diff: diffV2ToCommands(files, after, { reader, identity: reader.idMapping, now: writeContext.now.toISOString(), allocateId: newId }) }
            } catch (error) { return { failure: error } }
          })
          const diffMs = ms(diffing)
          if (plan.failure) {
            if (plan.failure?.code === 'E_VIEW_MISMATCH') cache = undefined
            return storeFailureResponse(plan.failure)
          }
          const committing = performance.now()
          const result = await opened.commit({
            requestId: protocol.requestId, baseRevision: protocol.baseRevision, kind, actor: STORE_ACTOR, commands: plan.diff.commands,
          })
          const commitMs = ms(committing)
          // The incremental refresh: the read model with the changed rows.
          advanceCache(opened, view, result)
          const response = { status: route.status, body: { ok: true, ...outcome.result, revision: result.revision, duplicate: result.status === 'duplicate', receipt: result.receipt } }
          remember(protocol.requestId, response)
          if (result.status === 'committed') countCommit()
          if (verify) verifyCache(opened)
          log(`[StarMap store] ${label}：V2 写入 ${runMs} ms，差异 ${diffMs} ms（${plan.diff.commands.length} 条命令`
            + `${plan.diff.renumbered.length ? `，重新编号 ${plan.diff.renumbered.length} 个 scope` : ''}），提交 ${commitMs} ms（修订号 ${result.revision}），共 ${ms(started)} ms`)
          return response
        } catch (error) {
          if (REOPEN_CODES.has(error?.code)) await dropHandle()
          return storeFailureResponse(error)
        }
      })
    }
  }
  /**
   * One store-native write (3C-5 C1, design 3C-5 §3): the protocol and the receipt lookup as for the V2 writes; the base
   * revision must be the live index's (E_STALE); the native planner turns the request into commands with the official
   * reader (its refusal is the same V2WriteError, 400 or 409); the commit (the host plans again inside BEGIN IMMEDIATE);
   * the commit's changed rows move the live index on. Resolves `{ status, body }` (the planner's result, the revision,
   * the receipt).
   */
  function nativeWriteHandler(routeKey, native) {
    const prefix = NATIVE_WRITE_ROUTES[routeKey] ?? STORE_WRITE_ROUTES[routeKey]
    const label = routeKey.replace(' /__travelatlas/editor/', ' ')
    return async function write({ headers, input, ctx }) {
      const protocol = storeProtocolOf(headers)
      if (protocol.failure) return protocol.failure
      let kind
      try { kind = storeRequestKind(prefix, input) } catch { return storeFailureResponse(new V2WriteError('E_REQUEST_INVALID', { reason: '请求体不是 JSON。' })) }
      return serialized(async () => {
        const started = performance.now()
        try {
          const opened = await open()
          const previous = opened.lookup(protocol.requestId)
          if (previous.found) {
            if (previous.receipt.kind !== kind || previous.receipt.baseRevision !== protocol.baseRevision) {
              return storeFailureResponse(new V2WriteError('E_OPERATION_CONFLICT'))
            }
            const known = remembered.get(protocol.requestId)
            const body = known?.body.receipt?.requestId === protocol.requestId ? known.body : { ok: true, revision: previous.receipt.revision, receipt: previous.receipt }
            return { status: known?.status ?? native.status, body: { ...body, duplicate: true } }
          }
          if (opened.readOnly) return storeFailureResponse(new V2WriteError('E_STORE_READ_ONLY'))
          const view = await snapshot()
          const indexing = performance.now()
          const live = view.live
          const indexMs = ms(indexing)
          if (live.revision !== protocol.baseRevision) return storeFailureResponse(new V2WriteError('E_STALE'))
          const writeContext = ctx ?? createV2WriteContext({ countryCatalog, ...(now ? { now: new Date(now()) } : {}) })
          const planning = performance.now()
          let plan
          try {
            plan = native.plan(officialReader(live), input, { now: writeContext.now, newId, countryCatalog: writeContext.countryCatalog ?? countryCatalog })
          } catch (error) { return v2FailureResponse(error) }
          const planMs = ms(planning)
          // A request that changes nothing commits nothing: no new revision, no receipt (a retry plans it again).
          if (plan.commands.length === 0) {
            lastTimings = Object.freeze({ route: label, commands: 0, indexMs, planMs, commitMs: 0, applyMs: 0, totalMs: ms(started) })
            log(`[StarMap store] ${label}（原生）：规划 ${planMs} ms，没有改动，不提交（修订号 ${live.revision}）`)
            return { status: native.status, body: { ok: true, ...plan.result, revision: live.revision, duplicate: false, unchanged: true } }
          }
          const committing = performance.now()
          let result
          try {
            result = await opened.commit({
              requestId: protocol.requestId, baseRevision: protocol.baseRevision, kind, actor: STORE_ACTOR, commands: plan.commands,
            })
          } catch (error) {
            // The store refused a plan made on the live index at its own revision (Core's check inside BEGIN IMMEDIATE):
            // the index no longer matches the store (a change behind the host's back). Nothing was written; the cache
            // is dropped and the store read again (as E_VIEW_MISMATCH does for the V2 writes).
            if (error?.outcome === 'not_committed' && !Object.hasOwn(CLIENT_CODES, error.code)) cache = undefined
            throw error
          }
          const commitMs = ms(committing)
          const applying = performance.now()
          advanceCache(opened, view, result)
          const applyMs = ms(applying)
          const response = { status: native.status, body: { ok: true, ...plan.result, revision: result.revision, duplicate: result.status === 'duplicate', receipt: result.receipt } }
          remember(protocol.requestId, response)
          if (result.status === 'committed') countCommit()
          if (verify) verifyCache(opened)
          const totalMs = ms(started)
          lastTimings = Object.freeze({ route: label, commands: plan.commands.length, indexMs, planMs, commitMs, applyMs, totalMs })
          log(`[StarMap store] ${label}（原生）：规划 ${planMs} ms（${plan.commands.length} 条命令），提交 ${commitMs} ms（修订号 ${result.revision}），更新索引 ${applyMs} ms，共 ${totalMs} ms`)
          return response
        } catch (error) {
          if (REOPEN_CODES.has(error?.code)) await dropHandle()
          return storeFailureResponse(error)
        }
      })
    }
  }
  /** Timings of the last native write ({ route, commands, indexMs, planMs, commitMs, applyMs, totalMs }), or undefined. */
  let lastTimings
  /** Write handlers by route: the native ones first (NATIVE_WRITE_ROUTES), the V2 ones for the rest (STORE_WRITE_ROUTES). */
  const writes = Object.fromEntries([
    ...Object.keys(STORE_WRITE_ROUTES).map((routeKey) => [routeKey, writeHandler(routeKey)]),
    ...Object.entries(nativeWrites).map(([routeKey, native]) => [routeKey, nativeWriteHandler(routeKey, native)]),
  ])

  return {
    file,
    open,
    /**
     * The virtual module's data: `{ model, revision, readOnly, files }` (the read model, the store-wide revision, whether
     * the store is damaged and read-only, and `files`, its V2 view, generated when asked for: tests compare it).
     */
    async moduleExports() {
      const view = await snapshot()
      const model = view.model
      return { model, revision: view.revision, readOnly: damaged(handle), get files() { return view.files } }
    },
    /** Timings of the last native write (3C-5 C1; benchmarks), or undefined. */
    get lastNativeTimings() { return lastTimings },
    /** Whether the store is open read-only because it is damaged (false when it cannot be opened at all). */
    async isDamaged() {
      try { return damaged(await open()) } catch { return false }
    },
    /** The cache in use ({ revision, model, live, index, hasLive, files, timings }; timings of the last read, empty after a write), or undefined. */
    get lastSnapshot() { return cache },
    /** GET /editor/state in the new-library mode: `{ status, body }` with the V1 editor state of the read model. */
    async readEditorState(at = new Date()) {
      try { return { status: 200, body: { ok: true, state: readEditorStateV1((await snapshot()).files, at) } } } catch (error) {
        return storeFailureResponse(error)
      }
    },
    /** The handler of a write endpoint the store accepts (`{ headers, input, ctx? }` → `{ status, body }`), or undefined. */
    writeRoute(method, pathname) {
      return writes[`${method} ${pathname}`]
    },
    /**
     * 3C-4c: the store as the media service uses it (./media-service.mjs): the V2 view at the current revision (3C-5 C2:
     * generated from the read model through the official view for each call, for the media rules that still take the V2
     * shape), the registry, the media entities, a reader, receipt lookups, and commits and file settlements queued with
     * this process's editor writes. A committed media write moves the cached read model on with its changed rows.
     */
    async mediaStore() {
      const opened = await open()
      return {
        get readOnly() { return opened.readOnly },
        meta: () => opened.meta(),
        async view() {
          const { files, revision } = await snapshot()
          return { files, revision }
        },
        mediaRegistry: () => opened.mediaRegistry(),
        mediaEntities: () => opened.mediaEntities(),
        read: (callback) => opened.read(callback),
        lookup: (requestId) => opened.lookup(requestId),
        commit: (request, options) => serialized(async () => {
          const view = cache
          let result
          try {
            result = await opened.commit(request, options)
            if (result.status === 'committed') countCommit()
            return result
          } finally {
            advanceCache(opened, view, result)
          }
        }),
        settleFileOps: (work, options) => serialized(() => opened.settleFileOps(work, options)),
      }
    },
    /** Whether a connection is open. */
    get isOpen() { return handle !== undefined },
    /** Record pruning so far: { commits (since the last run), backlog (the last run left work), runs, last (its outcome) }. */
    get pruneState() { return Object.freeze({ ...pruneState }) },
    /** Resolves when no pruning run is scheduled and no write is queued (tests, benchmarks). */
    async idle() {
      while (scheduledPrune) await scheduledPrune.done
      await writeTail
    },
    /** Close the connection (clean shutdown) after queued writes; a later use opens it again. A run not started yet is dropped. */
    async close() {
      const pending = opening
      if (pending) await pending.catch(() => {})
      if (scheduledPrune?.timer) {
        clearImmediate(scheduledPrune.timer)
        scheduledPrune.resolve()
        scheduledPrune = undefined
      }
      await writeTail
      const current = handle
      handle = undefined
      cache = undefined
      if (current) await current.close()
    },
  }
}
