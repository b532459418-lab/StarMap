/**
 * `npm run store:bench` (3C-2, design 3B §6 with the two scales of v1.1 §16.2-7): benchmarks for
 * the formal store host, run in segments so that no single command runs long. Never part of
 * `npm test` (store-bench.test.mjs runs a small smoke scale only).
 *
 * Scales (`--scale`, default real): `real` is what a person's library is expected to reach and is
 * what the targets are accepted on (3,000 places, 10,000 entries, 10,000 media entities); `stress`
 * is the 3C-2 scale (10,000 / 30,000 / 50,000), recorded only, to catch regressions and
 * super-linear growth. Each scale keeps its own files: <dir>/<scale>-fresh.sqlite, -aged.sqlite.
 *
 *   node scripts/store-bench.mjs --dir <work dir> --scale real|stress --segment load     creates <scale>-fresh; resumable, rerun until done
 *   ... --segment validate --db fresh       readFormalState (full validation) and check()
 *   ... --segment copy                      <scale>-fresh → <scale>-aged
 *   ... --segment commit --db fresh|aged    commits of 1, 2, 10 and 50 rows, with and without the library lock check
 *   ... --segment cold --db fresh|aged [--unclean]   open + readRowsUnchecked; --unclean first marks the last
 *                                           writer session as not closed (clean_shutdown 0), so the open runs quick_check
 *   ... --segment age --db aged --count 20000 [--offset N] [--fast]
 *   ... --segment prune --db aged           pruneLogs with incremental_vacuum: file size before and after
 *   ... --segment modes --db fresh          journal/sync comparison, copies only
 *
 * Every segment prints one JSON line and appends it to <dir>/results.jsonl. The data is
 * synthetic: places with anchors and entries, media entities with asset references and
 * "depicts" relations, and one view item per entry.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createStore, openStore, withoutLibraryLock } from './store-host.mjs'

/** Design 3B v1.1 §16.2-7 real scale, where the targets are accepted: 3,000 places, 10,000 entries, 10,000 media entities with asset references. */
export const REAL_SCALE = Object.freeze({ places: 3_000, entries: 10_000, media: 10_000 })
/** The 3C-2 stress scale (design 3B §6), recorded only: 10,000 places, 30,000 entries, 50,000 media entities. */
export const STRESS_SCALE = Object.freeze({ places: 10_000, entries: 30_000, media: 50_000 })
export const SCALES = Object.freeze({ real: REAL_SCALE, stress: STRESS_SCALE })
/** The `npm test` smoke scale: 1,000 places and entries, 200 media entities. */
export const SMOKE_SCALE = Object.freeze({ places: 1_000, entries: 1_000, media: 200 })
const LIBRARY_ID = '01900000-0000-7000-8000-0000000be4c1'
const SOURCE = 'bench:source'
const BATCH = 2_000

const hex = (n) => n.toString(16).padStart(12, '0')
export const placeId = (n) => `01910000-0000-7000-8000-${hex(n)}`
export const entryId = (n) => `01920000-0000-7000-8000-${hex(n)}`
export const mediaId = (n) => `01930000-0000-7000-8000-${hex(n)}`
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** Evenly spaced view positions: three base-62 digits, then 'V' (a position never ends in '0'). */
const position = (n) => {
  let text = ''
  for (let value = n + 1, i = 0; i < 3; i++, value = Math.floor(value / 62)) text = DIGITS[value % 62] + text
  return `${text}V`
}
const source = (recordId) => ({ sourceId: SOURCE, recordId, evidenceIds: [] })
const title = (text) => ({ names: { en: text } })
const create = (table, value) => ({ op: 'create', table, value })
const LAYERS = ['bench:travel', 'bench:travel', 'bench:want']
const BENCH_NOW = '2026-10-13T00:00:00.000Z'

/** The definitions every bench store starts from (its initial request). */
export function benchDefinitions() {
  return [
    create('sources', { id: SOURCE, revision: 0, title: title('Bench'), origin: 'user' }),
    create('entityTypes', { id: 'bench:place', revision: 0, title: title('Place'), schemaVersion: 1, fields: [{ key: 'name', kind: 'text', required: true }] }),
    create('entityTypes', { id: 'bench:media', revision: 0, title: title('Media'), schemaVersion: 1,
      fields: [{ key: 'asset', kind: 'asset_ref', required: true }, { key: 'caption', kind: 'text' }] }),
    create('layers', { id: 'bench:travel', revision: 0, title: title('Travel'), schemaVersion: 1, acceptedEntityTypes: ['bench:place'],
      entryFields: [{ key: 'rating', kind: 'number', min: 0, max: 10 }, { key: 'note', kind: 'text' }, { key: 'visitedAt', kind: 'date' }] }),
    create('layers', { id: 'bench:want', revision: 0, title: title('Want'), schemaVersion: 1, acceptedEntityTypes: ['bench:place'],
      entryFields: [{ key: 'note', kind: 'text' }] }),
    create('relationTypes', { id: 'bench:depicts', revision: 0, title: title('Depicts'), schemaVersion: 1, fromTypes: ['bench:media'], toTypes: ['bench:place'], fields: [] }),
  ]
}

const placeRows = (n) => [
  create('entities', { id: placeId(n), revision: 0, typeId: 'bench:place', title: title(`Place ${n}`), fields: { name: `Place ${n}` }, source: source(`place-${n}`), visibility: 'private' }),
  create('anchors', { id: `anchor-${n}`, revision: 0, entityId: placeId(n), kind: 'location', lat: ((n * 37) % 1800) / 10 - 90, lng: ((n * 53) % 3600) / 10 - 180,
    precision: 'city', source: source(`anchor-${n}`) }),
]
function entryRows(scale, n) {
  // Entries spread evenly over the places (the stress scale: three per place, as in 3C-2).
  const place = Math.floor((n * scale.places) / scale.entries)
  const layerId = LAYERS[n % LAYERS.length]
  const fields = layerId === 'bench:travel' ? { rating: n % 11, note: `Visit ${n}`, visitedAt: `20${10 + (n % 15)}-0${1 + (n % 9)}-1${n % 10}` } : { note: `Someday ${n}` }
  return [
    create('entries', { id: entryId(n), revision: 0, layerId, entityId: placeId(place), fields, source: source(`entry-${n}`), createdAt: BENCH_NOW, updatedAt: BENCH_NOW }),
    create('viewItems', { id: `view-${n}`, revision: 0, scope: `layer:${layerId}`, itemTable: 'entries', itemId: entryId(n), layerId, position: position(n), hidden: false }),
  ]
}
function mediaRows(scale, n) {
  return [
    create('assets', { id: `asset-${n}`, revision: 0, source: source(`asset-${n}`), attributes: { mediaType: 'photo', width: 4032, height: 3024, sha256: hex(n).repeat(5).slice(0, 64) } }),
    create('entities', { id: mediaId(n), revision: 0, typeId: 'bench:media', title: title(`Photo ${n}`), fields: { asset: `asset-${n}`, caption: `Photo ${n}` },
      source: source(`media-${n}`), visibility: 'private' }),
    create('relations', { id: `depicts-${n}`, revision: 0, typeId: 'bench:depicts', fromEntityId: mediaId(n), toEntityId: placeId(n % scale.places),
      source: source(`depicts-${n}`), fields: {} }),
  ]
}

/** Command batches in dependency order (places, then entries, then media). */
export function* benchBatches(scale) {
  let batch = []
  const push = function* (rows) {
    batch.push(...rows)
    if (batch.length >= BATCH) { yield batch; batch = [] }
  }
  for (let n = 0; n < scale.places; n++) yield* push(placeRows(n))
  for (let n = 0; n < scale.entries; n++) yield* push(entryRows(scale, n))
  for (let n = 0; n < scale.media; n++) yield* push(mediaRows(scale, n))
  if (batch.length) yield batch
}

let requestCounter = 0
/** Request ids: UUIDv7-shaped, unique per process run (the high bits carry the run's start time). */
const runPrefix = Date.now().toString(16).padStart(12, '0').slice(-12)
export const nextRequestId = () => `${runPrefix.slice(0, 8)}-${runPrefix.slice(8, 12)}-7000-8000-${hex(++requestCounter)}`
const request = (baseRevision, commands, kind = 'bench.edit') => ({ requestId: nextRequestId(), baseRevision, kind, actor: 'bench', commands })

/** Create a store at `file` with the bench definitions (revision 1). */
export const createBenchStore = (file, { now = () => BENCH_NOW } = {}) => createStore(file, { libraryId: LIBRARY_ID, now, lock: withoutLibraryLock,
  initial: { requestId: nextRequestId(), actor: 'bench', commands: benchDefinitions() } })

/**
 * Load `scale` through the planner, BATCH commands per commit, continuing from the store's
 * revision (batch k is revision k + 2), so a load can stop and resume in a later segment.
 * Stops early when `deadline` (performance.now() milliseconds) has passed.
 */
export async function loadBatches(handle, scale, { deadline = Infinity } = {}) {
  let revision = handle.meta().revision, rows = 0, commits = 0, index = 0, done = true
  for (const commands of benchBatches(scale)) {
    if (index++ < revision - 1) continue
    if (performance.now() > deadline) { done = false; break }
    revision = (await handle.commit(request(revision, commands, 'bench.load'))).revision
    rows += commands.length
    commits++
  }
  return { rows, commits, revision, done }
}

/** Create a store at `file` and load all of `scale` (the smoke test). */
export async function loadBenchStore(file, scale) {
  const handle = await createBenchStore(file)
  return { handle, ...(await loadBatches(handle, scale)) }
}

/** One edit of `size` changed rows (1, 2, 10 or 50) against the current store. */
export function benchEdit(handle, scale, size, n) {
  const entries = scale.entries
  return handle.read((reader) => {
    const commands = []
    const updateEntry = (index) => {
      const row = reader.get('entries', entryId(index))
      const fields = row.layerId === 'bench:travel' ? { ...row.fields, rating: (row.fields.rating + 1) % 11 } : { note: `Edited ${n}` }
      commands.push({ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields } })
    }
    const pick = (k) => (n * 7919 + k * 104_729) % entries
    if (size === 10) {
      // A new place with its anchor, three entries and their view items, plus two updated entries.
      const place = 1_000_000 + n, first = 1_000_000 + n * 3
      commands.push(...placeRows(place))
      for (let k = 0; k < 3; k++) {
        const index = first + k, layerId = LAYERS[k]
        commands.push(create('entries', { id: entryId(index), revision: 0, layerId, entityId: placeId(place), fields: layerId === 'bench:travel' ? { rating: 5 } : {},
          source: source(`entry-${index}`), createdAt: BENCH_NOW, updatedAt: BENCH_NOW }))
        commands.push(create('viewItems', { id: `view-${index}`, revision: 0, scope: `new:${layerId}`, itemTable: 'entries', itemId: entryId(index), layerId,
          position: position(n * 3 + k), hidden: false }))
      }
      updateEntry(pick(1)); updateEntry(pick(2))
    } else if (size === 2) {
      const index = pick(1)
      updateEntry(index)
      const item = reader.get('viewItems', `view-${index}`)
      commands.push({ op: 'update', table: 'viewItems', id: item.id, expectedRevision: item.revision, value: { ...item, revision: item.revision + 1, hidden: !item.hidden } })
    } else {
      const seen = new Set()
      for (let k = 0; seen.size < size; k++) { const index = pick(k); if (!seen.has(index)) { seen.add(index); updateEntry(index) } }
    }
    return request(reader.revision, commands)
  })
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const round = (value) => Math.round(value * 100) / 100
  return { n: sorted.length, p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), p99: round(percentile(sorted, 99)), max: round(sorted.at(-1)) }
}
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10
const memory = () => ({ rssMb: mb(process.memoryUsage().rss), heapMb: mb(process.memoryUsage().heapUsed) })

/** `count` commits cycling through 1, 2, 10 and 50 changed rows; times commit() only. */
export async function timedCommits(handle, scale, count, offset) {
  const sizes = [1, 2, 10, 50]
  const all = [], bySize = Object.fromEntries(sizes.map((size) => [size, []]))
  for (let i = 0; i < count; i++) {
    const size = sizes[i % sizes.length]
    const edit = benchEdit(handle, scale, size, offset + i)
    const started = performance.now()
    await handle.commit(edit)
    const elapsed = performance.now() - started
    all.push(elapsed)
    bySize[size].push(elapsed)
  }
  return { all: summarize(all), bySize: Object.fromEntries(sizes.map((size) => [size, summarize(bySize[size])])) }
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

function options(argv) {
  const value = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined }
  const dir = value('dir')
  if (!dir || !path.isAbsolute(dir)) throw new Error('--dir <absolute work directory> is required')
  const scaleName = value('scale') ?? 'real'
  if (!Object.hasOwn(SCALES, scaleName)) throw new Error(`--scale must be one of ${Object.keys(SCALES).join(', ')}`)
  return {
    dir, scaleName, scale: SCALES[scaleName], segment: value('segment'), db: value('db') ?? 'fresh',
    count: Number(value('count') ?? 20_000), offset: Number(value('offset') ?? 0), fast: argv.includes('--fast'), unclean: argv.includes('--unclean'),
  }
}
const fileSizeMb = (file) => mb(statSync(file).size)
const storeFile = (dir, scaleName, db) => path.join(dir, `${scaleName}-${db}.sqlite`)
const ms = (value) => (value === undefined ? null : Math.round(value * 10) / 10)
const COUNTED = Object.freeze(['entities', 'entries', 'assets', 'anchors', 'relations', 'viewItems'])
const tableCounts = (state) => Object.fromEntries(COUNTED.map((table) => [table, state[table].length]))
const maxRssMb = () => mb(process.resourceUsage().maxRSS * 1024)

/** Bench only: leave the last writer session marked as not closed, as a killed writer does (the next open runs quick_check). */
function markUnclean(file) {
  const db = new DatabaseSync(file)
  try { db.exec('UPDATE store_meta SET clean_shutdown = 0') } finally { db.close() }
}

const SEGMENTS = {
  /** Resumable: creates <scale>-fresh.sqlite, then loads batches for at most six minutes per run. */
  async load({ dir, scaleName, scale }) {
    const file = storeFile(dir, scaleName, 'fresh')
    const started = performance.now()
    const handle = existsSync(file) ? openStore(file, { lock: withoutLibraryLock }) : await createBenchStore(file)
    try {
      const result = await loadBatches(handle, scale, { deadline: started + 6 * 60_000 })
      return { scale: scaleName, ...result, seconds: Math.round((performance.now() - started) / 100) / 10, fileMb: fileSizeMb(file), memory: memory() }
    } finally { await handle.close() }
  },
  /** Full validation of the loaded store: readFormalState (Core) and the host's check (quick_check included). */
  async validate({ dir, scaleName, db }) {
    const file = storeFile(dir, scaleName, db)
    const handle = openStore(file, { lock: withoutLibraryLock })
    try {
      let started = performance.now()
      const counts = tableCounts(handle.readFormalState())
      const readFormalStateMs = Math.round(performance.now() - started)
      started = performance.now()
      const check = handle.check()
      return { scale: scaleName, db, counts, readFormalStateMs, checkMs: Math.round(performance.now() - started), check, fileMb: fileSizeMb(file),
        memory: memory(), maxRssMb: maxRssMb() }
    } finally { await handle.close() }
  },
  async copy({ dir, scaleName }) {
    copyFileSync(storeFile(dir, scaleName, 'fresh'), storeFile(dir, scaleName, 'aged'))
    return { scale: scaleName, copied: true, fileMb: fileSizeMb(storeFile(dir, scaleName, 'aged')) }
  },
  /**
   * 200 commits without any library coordination, then 200 with the default check of ordinary
   * writes (privatePaths: one lstat of the library lock before BEGIN IMMEDIATE, no lease).
   */
  async commit({ dir, scaleName, scale, db, offset }) {
    const file = storeFile(dir, scaleName, db)
    const root = path.join(dir, `root-${scaleName}-${db}`)
    mkdirSync(root, { recursive: true })
    const before = memory()
    let handle = openStore(file, { lock: withoutLibraryLock })
    const opened = memory()
    const unprobed = await timedCommits(handle, scale, 200, offset)
    await handle.close()
    handle = openStore(file, { privatePaths: { root } })
    const probed = await timedCommits(handle, scale, 200, offset + 200)
    const after = memory()
    await handle.close()
    return {
      scale: scaleName, db, unprobed, probed, probeOverheadP50Ms: Math.round((probed.all.p50 - unprobed.all.p50) * 100) / 100,
      memory: { before, opened, after, rssIncreaseMb: Math.round((after.rssMb - before.rssMb) * 10) / 10, maxRssMb: maxRssMb() },
      fileMb: fileSizeMb(file),
    }
  },
  /** Cold start (design 3B v1.1 §16.2-7): open plus readRowsUnchecked, after a clean close or (--unclean) a killed writer. */
  async cold({ dir, scaleName, db, unclean }) {
    const file = storeFile(dir, scaleName, db)
    if (unclean) markUnclean(file)
    const before = memory()
    const started = performance.now()
    const handle = openStore(file, { lock: withoutLibraryLock })
    const openMs = performance.now() - started
    const opened = memory()
    const readStarted = performance.now()
    const rows = handle.readRowsUnchecked()
    const readRowsUncheckedMs = performance.now() - readStarted
    const totalMs = performance.now() - started
    const read = memory()
    const counts = tableCounts(rows)
    await handle.close()
    const timings = handle.openTimings
    return {
      scale: scaleName, db, unclean, readOnly: handle.readOnly, openMs: ms(openMs), connectMs: ms(timings.connectMs), quickCheckMs: ms(timings.quickCheckMs),
      readRowsUncheckedMs: ms(readRowsUncheckedMs), totalMs: ms(totalMs), counts, fileMb: fileSizeMb(file),
      memory: { before, opened, read, openIncreaseMb: Math.round((opened.rssMb - before.rssMb) * 10) / 10, readIncreaseMb: Math.round((read.rssMb - before.rssMb) * 10) / 10,
        maxRssMb: maxRssMb() },
    }
  },
  /**
   * Long-term use: `count` ordinary edits (alternately 1 and 2 changed rows), each its own request
   * through the full commit path (planning, execution, receipt, op_log). With `--fast`, durability
   * is relaxed through the test hook (WAL, synchronous OFF) only to shorten the aging; the file is
   * converted back to TRUNCATE on the next open, and the measurements run with TRUNCATE + EXTRA.
   * Stops after six minutes; rerun with --offset to continue.
   */
  async age({ dir, scaleName, scale, db, count, offset, fast }) {
    const file = storeFile(dir, scaleName, db)
    const relax = (name, { db: connection }) => {
      if (name === 'probed') { connection.exec('PRAGMA journal_mode = WAL'); connection.exec('PRAGMA synchronous = OFF') }
    }
    const handle = openStore(file, { lock: withoutLibraryLock, ...(fast ? { unsafeTestPhase: relax } : {}) })
    const started = performance.now(), deadline = started + 6 * 60_000
    const samples = []
    let done = 0
    try {
      for (; done < count && performance.now() < deadline; done++) {
        const edit = benchEdit(handle, scale, done % 2 ? 2 : 1, offset + done)
        const t0 = performance.now()
        await handle.commit(edit)
        samples.push(performance.now() - t0)
      }
      return { scale: scaleName, db, fast, requested: count, done, nextOffset: offset + done, seconds: Math.round((performance.now() - started) / 1000),
        commits: summarize(samples), revision: handle.meta().revision }
    } finally {
      await handle.close()
      // Back to the host's journal mode before anything is measured on this file.
      if (fast) await openStore(file, { lock: withoutLibraryLock }).close()
    }
  },
  /**
   * The journal/sync comparison behind design 3B v1.1 §16.2-2: the same commits on copies of the
   * store with other journal/sync settings, set through the test hook. The host itself always
   * runs TRUNCATE + EXTRA. The copies are removed afterwards.
   */
  async modes({ dir, scaleName, scale, db, offset }) {
    const results = {}
    for (const [journal, sync] of [['DELETE', 'EXTRA'], ['TRUNCATE', 'EXTRA'], ['WAL', 'FULL'], ['WAL', 'NORMAL']]) {
      const copy = storeFile(dir, scaleName, `mode-${journal}-${sync}`)
      copyFileSync(storeFile(dir, scaleName, db), copy)
      const handle = openStore(copy, { lock: withoutLibraryLock, unsafeTestPhase: (name, { db: connection }) => {
        if (name === 'probed') { connection.exec(`PRAGMA journal_mode = ${journal}`); connection.exec(`PRAGMA synchronous = ${sync}`) }
      } })
      try { results[`${journal}+${sync}`] = await timedCommits(handle, scale, 100, offset) } finally { await handle.close() }
      for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
    }
    return { scale: scaleName, db, results }
  },
  /** Retention as if the newest edits were 31 days old (as in 3C-2), then incremental_vacuum: the file size before and after. */
  async prune({ dir, scaleName, db }) {
    const file = storeFile(dir, scaleName, db)
    const fileMbBefore = fileSizeMb(file)
    const handle = openStore(file, { lock: withoutLibraryLock })
    const started = performance.now()
    const total = { receipts: 0, opLog: 0, steps: 0, vacuumSteps: 0, freedPages: 0, calls: 0 }
    const now = new Date(Date.now() + 31 * 86_400_000).toISOString()
    for (;;) {
      const result = await handle.pruneLogs({ now })
      for (const key of ['receipts', 'opLog', 'steps', 'vacuumSteps', 'freedPages']) total[key] += result[key]
      total.calls++
      if (result.done) break
    }
    const prunedMs = performance.now() - started
    await handle.close()
    return { scale: scaleName, db, ...total, ms: Math.round(prunedMs), fileMbBefore, fileMbAfter: fileSizeMb(file) }
  },
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const settings = options(process.argv.slice(2))
  const run = SEGMENTS[settings.segment]
  if (!run) throw new Error(`--segment must be one of ${Object.keys(SEGMENTS).join(', ')}`)
  mkdirSync(settings.dir, { recursive: true })
  const result = { segment: settings.segment, node: process.versions.node, at: new Date().toISOString(), scaleRows: settings.scale, ...(await run(settings)) }
  const line = JSON.stringify(result)
  appendFileSync(path.join(settings.dir, 'results.jsonl'), `${line}\n`)
  console.log(line)
}
