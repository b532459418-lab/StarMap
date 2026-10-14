/**
 * The local editor plugin's side of the experimental new-library mode (3C-3, design 3B §4.4, §4.7 and v1.1 §16.2-4).
 *
 * Why a separate file: the plugin imports sharp / undici / world-countries and resolves the private root at module
 * scope, so it cannot be loaded under node --test as it is. Like ./v2-editor-store.mjs for V2, this file holds what the
 * plugin does with the store, and the end-to-end tests drive it directly on temporary private roots.
 *
 * - One writable connection per dev server process (`open`): opened when the server starts, kept until it closes
 *   (`close`, which writes the clean-shutdown mark). A store that another process is writing makes the open
 *   E_STORE_BUSY; it is retried a few times (OPEN_RETRIES × OPEN_RETRY_DELAY_MS) and then reported. Any open failure,
 *   including a failed open check (read-only diagnostic), is an error the App shows: the mode never falls back to V2.
 * - Read model (`moduleExports`): readRowsUnchecked → projectStoreToCanonical → serializeV2, i.e. the five V2 files the
 *   App reads through readV2 as before, plus the store-wide revision. Cached per revision; each step is timed and
 *   logged, and rows the projection cannot express are counted in the log (never an error).
 * - Writes (`writeRoute`): the endpoints the store accepts (STORE_WRITE_ROUTES), today only the want-to-go update.
 *   Every other write endpoint is refused by the plugin with 409 E_STORE_MODE_LIMITED.
 *
 * The want-to-go update and its client protocol (design 3B §4.4 and §4.5):
 * - The request carries `x-starmap-request-id` (UUIDv7, one per user action, kept on retries) and
 *   `x-starmap-base-revision` (the store revision the page was built from). Without them the page predates the
 *   new-library mode: E_STALE (reload). Malformed: E_REQUEST_INVALID.
 * - The request's `kind` carries a SHA-256 of the validated input, so the stored receipt also identifies the intent.
 * - In this process one write runs at a time: look the request id up first; a committed request with the same intent
 *   and base revision answers with its original receipt and writes nothing (a different intent is
 *   E_OPERATION_CONFLICT); otherwise the commands are planned against the base revision (E_STALE when the store moved
 *   on) and committed, where the host checks the receipt, the revision and the plan again inside BEGIN IMMEDIATE.
 * - Outcomes: 200 with the item and the receipt; 409 E_STALE, E_OPERATION_CONFLICT, E_LIBRARY_BUSY, E_STORE_BUSY
 *   (confirmed not committed); 500 E_OUTCOME_UNKNOWN (the client retries once with the same request id);
 *   400 for the V2 input rules; 500 E_STORE_FAILED for any other confirmed failure.
 */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { storeFileOf } from './private-data-source.mjs'
import { skippedCounts, projectToV2Files } from './store-projection.mjs'
import { StoreHostError, openStore } from './store-host.mjs'
import { indexPlaces, reconstructWantToGoItem } from '../src/data/canonical/reconstruct.ts'
import { isUuidV7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY, V2_SOURCES, VIEW_SCOPES } from '../src/data/store/officialDefinitions.ts'
import { readWantToGoUpdate, wantToGoUpdateCommands, wantToGoUpdateKey } from '../src/data/store/wantToGoUpdate.ts'
import { V2WriteError, errorBody, readEditorStateV1 } from '../src/data/v2write/index.ts'

/** Attempts to open a store another process is writing: the first one and OPEN_RETRIES more, OPEN_RETRY_DELAY_MS apart. */
export const OPEN_RETRIES = 5
export const OPEN_RETRY_DELAY_MS = 200

const ms = (started) => Math.round((performance.now() - started) * 10) / 10

/** What to do about an open failure, by code (shown by the App through the error overlay, and logged). */
const OPEN_HINTS = Object.freeze({
  E_STORE_BUSY: '另一个进程正在写入这个库（例如另一个开发服务器或 store:* 命令）。关掉它之后刷新页面。',
  E_STORE_ALREADY_OPEN: '这个进程已经打开了这个库。重启开发服务器。',
  E_STORE_NOT_FOUND: 'data/store/world.sqlite 不见了。重启开发服务器。',
  E_STORE_TOO_NEW: '库的格式比这个版本的程序新。请使用更新的 StarMap。',
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

/** Write endpoints of the new-library mode: `METHOD /path` → handler name. */
export const STORE_WRITE_ROUTES = Object.freeze({ 'POST /__travelatlas/editor/wanttogo/update': 'updateWantToGo' })

/** The client protocol's request headers (lowercase, as Node delivers them). */
export const STORE_REQUEST_ID_HEADER = 'x-starmap-request-id'
export const STORE_BASE_REVISION_HEADER = 'x-starmap-base-revision'
/** `kind` of a want-to-go update request: this prefix, '@', and the SHA-256 of the validated input. */
export const WANT_TO_GO_UPDATE_KIND = 'starmap.wanttogo.update'
const STORE_ACTOR = 'local-editor'

/** Host codes the client handles by name, with their status; every other failure is E_STORE_FAILED. */
const CLIENT_CODES = Object.freeze({
  E_STALE: 409, E_OPERATION_CONFLICT: 409, E_LIBRARY_BUSY: 409, E_STORE_BUSY: 409, E_OUTCOME_UNKNOWN: 500,
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

/**
 * Open `file` writable, retrying while it is busy. A handle with an open diagnostic (read-only) is closed and reported
 * as StoreSessionError with the diagnostic's code; so is every other failure.
 */
export async function openStoreWithRetry(file, options, { retries = OPEN_RETRIES, retryDelayMs = OPEN_RETRY_DELAY_MS, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    let handle
    try { handle = openStore(file, options) } catch (error) {
      const code = error instanceof StoreHostError ? error.code : 'E_STORE_OPEN'
      if (code === 'E_STORE_BUSY' && attempt < retries) { await sleep(retryDelayMs); continue }
      throw new StoreSessionError(code, { cause: error })
    }
    if (!handle.diagnostic) return handle
    const { code } = handle.diagnostic
    await handle.close()
    throw new StoreSessionError(code)
  }
}

/**
 * The store session of one plugin instance. `privatePaths` is getPrivatePaths() of the private root; `now` gives the
 * host time (tests); `log` receives the timing lines; `retry` overrides the open retries ({ retries, retryDelayMs, sleep }).
 */
export function createStoreSession(privatePaths, { log = console.log, now, retry } = {}) {
  const file = storeFileOf(privatePaths)
  const hostOptions = { privatePaths, policy: OFFICIAL_POLICY, ...(now ? { now } : {}) }
  let handle
  let opening
  let openMs
  let cache

  /** The open handle, opening it on first use (concurrent callers share one open). */
  async function open() {
    if (handle) return handle
    opening ??= (async () => {
      const started = performance.now()
      try {
        handle = await openStoreWithRetry(file, hostOptions, retry)
        openMs = ms(started)
        return handle
      } finally { opening = undefined }
    })()
    return opening
  }

  /** The cached read model at the store's current revision, built when the revision moved. */
  async function snapshot() {
    const opened = await open()
    const revision = opened.meta().revision
    if (cache?.revision === revision) return cache
    const timings = {}
    if (openMs !== undefined) { timings.openMs = openMs; openMs = undefined }
    let started = performance.now()
    const rows = opened.readRowsUnchecked()
    timings.readMs = ms(started)
    const { projection, files, timings: steps } = projectToV2Files(rows)
    Object.assign(timings, steps)
    cache = Object.freeze({ revision: rows.revision, files, projection, timings })
    const skipped = Object.entries(skippedCounts(projection.skipped)).map(([table, count]) => `${table} ${count}`)
    log(`[StarMap store] 读模型（修订号 ${rows.revision}）：${timings.openMs === undefined ? '' : `打开 ${timings.openMs} ms，`}`
      + `readRowsUnchecked ${timings.readMs} ms，投影 ${timings.projectMs} ms，serializeV2 ${timings.serializeMs} ms`
      + (skipped.length ? `；投影跳过 ${projection.skipped.length} 行（${skipped.join('，')}）` : ''))
    return cache
  }

  const hostNow = () => (now ? now() : new Date().toISOString())
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
  /** The success response: the item as V2 returns it (from the read model at the new revision) and the receipt. */
  async function updated(id, receipt, duplicate) {
    let item
    try {
      const { projection } = await snapshot()
      const wish = projection.canonical.wantToGo.items.find((candidate) => candidate.id === id)
      if (wish) item = reconstructWantToGoItem(wish, indexPlaces(projection.canonical.places))
    } catch { /* The write stands; the page reloads and reads the model again. */ }
    return { status: 200, body: { ok: true, ...(item ? { item } : {}), revision: receipt.revision, duplicate, receipt } }
  }

  /** POST /wanttogo/update: see the file header. Resolves `{ status, body }`. */
  async function updateWantToGo({ headers, input }) {
    const protocol = storeProtocolOf(headers)
    if (protocol.failure) return protocol.failure
    let update
    try { update = readWantToGoUpdate(input) } catch (error) { return storeFailureResponse(error) }
    const kind = `${WANT_TO_GO_UPDATE_KIND}@${sha256(wantToGoUpdateKey(update))}`
    return serialized(async () => {
      const started = performance.now()
      try {
        const opened = await open()
        const previous = opened.lookup(protocol.requestId)
        if (previous.found) {
          if (previous.receipt.kind !== kind || previous.receipt.baseRevision !== protocol.baseRevision) {
            return storeFailureResponse(new V2WriteError('E_OPERATION_CONFLICT'))
          }
          return updated(update.id, previous.receipt, true)
        }
        const entryId = opened.getIdMapping('entry', V2_SOURCES.wantToGo, update.id) ?? update.id
        const newViewItemId = `${VIEW_SCOPES.wantToGoHidden}#${protocol.requestId}`
        // An error thrown inside a read transaction would turn into a store error: the plan returns its failure instead.
        const plan = opened.read((reader) => {
          if (reader.revision !== protocol.baseRevision) return { failure: new V2WriteError('E_STALE') }
          try {
            return { commands: wantToGoUpdateCommands(reader, entryId, update, { now: hostNow(), newViewItemId }) }
          } catch (error) { return { failure: error } }
        })
        if (plan.failure) return storeFailureResponse(plan.failure)
        const committing = performance.now()
        const result = await opened.commit({
          requestId: protocol.requestId, baseRevision: protocol.baseRevision, kind, actor: STORE_ACTOR, commands: plan.commands,
        })
        const commitMs = ms(committing)
        const response = await updated(update.id, result.receipt, result.status === 'duplicate')
        log(`[StarMap store] 修改想去：提交 ${commitMs} ms（修订号 ${result.revision}），共 ${ms(started)} ms`)
        return response
      } catch (error) {
        if (REOPEN_CODES.has(error?.code)) await dropHandle()
        return storeFailureResponse(error)
      }
    })
  }
  /** Write handlers by name (STORE_WRITE_ROUTES). */
  const writes = { updateWantToGo }

  return {
    file,
    open,
    /** The virtual module's data: `{ files, revision }` (the five V2 files and the store-wide revision). */
    async moduleExports() {
      const { files, revision } = await snapshot()
      return { files, revision }
    },
    /** The last read model built, with its timings ({ revision, files, projection, timings }), or undefined. */
    get lastSnapshot() { return cache },
    /** GET /editor/state in the new-library mode: `{ status, body }` with the V1 editor state of the read model. */
    async readEditorState(at = new Date()) {
      try { return { status: 200, body: { ok: true, state: readEditorStateV1((await snapshot()).files, at) } } } catch (error) {
        return storeFailureResponse(error)
      }
    },
    /** The handler of a write endpoint the store accepts (`{ headers, input }` → `{ status, body }`), or undefined. */
    writeRoute(method, pathname) {
      const name = STORE_WRITE_ROUTES[`${method} ${pathname}`]
      return name === undefined ? undefined : writes[name]
    },
    /** Whether a connection is open. */
    get isOpen() { return handle !== undefined },
    /** Close the connection (clean shutdown) after queued writes; a later use opens it again. */
    async close() {
      const pending = opening
      if (pending) await pending.catch(() => {})
      const current = handle
      handle = undefined
      cache = undefined
      if (current) await current.close()
    },
  }
}
