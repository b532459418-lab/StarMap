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
 * - Writes (`writeRoute`): the endpoints the store accepts (STORE_WRITE_ROUTES). Every other write endpoint is refused
 *   by the plugin with 409 E_STORE_MODE_LIMITED.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { storeFileOf } from './private-data-source.mjs'
import { skippedCounts, projectToV2Files } from './store-projection.mjs'
import { StoreHostError, openStore } from './store-host.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
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

/** Write endpoints of the new-library mode: `METHOD /path` → handler name. Empty until the want-to-go update is wired. */
export const STORE_WRITE_ROUTES = Object.freeze({})

/** A failure of a store read or write as the local editor's response: { status, body } (codes only, never values). */
export function storeFailureResponse(error) {
  if (error instanceof V2WriteError) return { status: 400, body: errorBody(error) }
  const code = typeof error?.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code) ? error.code : 'E_STORE_OPEN'
  return { status: 500, body: errorBody(new V2WriteError('E_STORE_FAILED', { code })) }
}

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

  /** Write handlers by name (STORE_WRITE_ROUTES). */
  const writes = {}

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
