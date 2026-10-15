/**
 * `npm run store:bench:mode` (3C-3 spec §2.8): the new-library mode measured on the real plugin path at the real scale
 * of design 3B v1.1 §16.2-7 (3,000 places, 10,000 entries, 10,000 media), against the V2 mode with the same data.
 * Never part of `npm test` (store-mode-bench.test.mjs runs a tiny scale only).
 *
 * The data is synthetic V2 (store-bench.mjs generates formal rows of its own `bench:*` definitions, which the App's
 * projection skips, so it cannot feed the plugin): 100 countries and 2,900 cities; 6,500 visited footprint records in
 * 650 journeys, 500 planned records and 3,000 want-to-go items; 10,000 photos with order lists, covers and hidden ones.
 * `<dir>/v2-root` keeps the V2 files only, `<dir>/store-root` the same files migrated into the store.
 *
 *   node scripts/store-mode-bench.mjs --dir <work dir> --segment generate     both roots (migration timed)
 *   ... --segment read       the virtual module in each mode: V2 reads five files; the store opens, readRowsUnchecked,
 *                            projects, serializeV2 (each timed), then five rebuilds at the same revision
 *   ... --segment http       want-to-go note updates over real HTTP through the plugin middleware, in each mode: the
 *                            client's end to end, the host commit, and the module load that the page reload triggers
 *   ... --segment pipeline   the App side of the compatibility path (validateV2Files, readV2, derive) and sizes
 *   ... --segment editors    (3C-4a) the eight editor writes over HTTP in each mode, on freshly generated roots: per
 *                            endpoint the client's end to end and, in the store mode, the host's V2 write, diff, commit
 *                            and total
 *   ... --segment media      (3C-4b) media files for the store root's media items (derivatives, originals with folder
 *                            pins, the media source index); run after generate
 *   ... --segment backup     (3C-4b) store:backup of the store root with its media into <dir>/backup: the time under the
 *                            library lease, the media copy, and the sizes
 *   ... --segment restore    (3C-4b) store:restore of <dir>/backup into <dir>/restored, with every media hash checked
 *
 * Each segment prints one JSON line and appends it to <dir>/results.jsonl. Run every segment in its own process (the
 * store's open is measured cold). `--scale tiny` is the smoke scale.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPrivatePaths, V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
import { applyMigration, previewMigration } from './store-migrate.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { serializeV2 } from '../src/data/canonical/v2Serializer.ts'
import { validateV2Files } from '../src/data/canonical/v2Schema.ts'

export const MODE_BENCH_SCALES = Object.freeze({
  real: Object.freeze({ countries: 100, cities: 2_900, visited: 6_500, journeySize: 10, planned: 500, wishes: 3_000, media: 10_000, updates: 30, derivativeKb: 64, originalKb: 256 }),
  tiny: Object.freeze({ countries: 4, cities: 26, visited: 40, journeySize: 5, planned: 5, wishes: 15, media: 30, updates: 4, derivativeKb: 1, originalKb: 4 }),
})
const NOW = '2026-10-14T00:00:00.000Z'
const hex = (n) => n.toString(16).padStart(12, '0')
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const placeId = (n) => `01920000-0000-7000-8000-${hex(n)}`
const ms = (started) => Math.round((performance.now() - started) * 10) / 10
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) }
}

/** Five synthetic V2 files at `scale` (deterministic). */
export function syntheticV2Files(scale) {
  const countries = Array.from({ length: scale.countries }, (_, n) => ({
    id: placeId(n), subtype: 'country', names: { en: `Country ${n}`, 'zh-Hans': `国家 ${n}` },
    externalIds: { iso3166Alpha2: LETTERS[Math.floor(n / 26) % 26] + LETTERS[n % 26] },
    location: { lat: ((n * 7) % 160) - 80, lng: ((n * 13) % 340) - 170 },
  }))
  const cities = Array.from({ length: scale.cities }, (_, n) => ({
    id: placeId(scale.countries + n), subtype: 'city', names: { en: `City ${n}`, 'zh-Hans': `城市 ${n}` },
    partOf: countries[n % scale.countries].id, location: { lat: ((n * 37) % 1600) / 10 - 80, lng: ((n * 53) % 3400) / 10 - 170 },
  }))
  const date = (n) => `20${10 + (n % 15)}-0${1 + (n % 9)}-1${n % 10}`
  const records = []
  for (let n = 0; n < scale.visited; n++) {
    const journey = Math.floor(n / scale.journeySize)
    records.push({ id: `visit-${n}`, placeId: cities[n % scale.cities].id, start_date: date(n), end_date: date(n), status: 'visited',
      trip_title: `Trip ${journey}`, journeyId: `journey-${journey}`, notes: `Synthetic visit ${n}` })
  }
  for (let n = 0; n < scale.planned; n++) records.push({ id: `plan-${n}`, placeId: cities[(n * 7) % scale.cities].id, start_date: '2027-05-01', status: 'planned' })
  const wishPlaces = [...cities, ...countries]
  const items = Array.from({ length: scale.wishes }, (_, n) => ({
    id: `wish-${n}`, placeId: wishPlaces[n % wishPlaces.length].id, addedAt: date(n), hidden: n % 20 === 0,
    ...(n % 2 ? { note: `Synthetic wish ${n}` } : {}), source: 'local-editor',
  }))
  const media = Array.from({ length: scale.media }, (_, n) => ({
    id: `media-${n}`, kind: 'photo', scope: 'city', status: 'ready', placeId: cities[n % scale.cities].id,
    src: `/media/user/synthetic/${n}.webp`, originalFileName: `photo-${n}.jpg`, ...(n % 3 ? {} : { title: { names: { en: `Photo ${n}` } } }),
  }))
  const cityIdsOf = new Map(countries.map((country) => [country.id, []]))
  for (const city of cities) cityIdsOf.get(city.partOf).push(city.id)
  const mediaOf = new Map()
  for (const item of media) mediaOf.set(item.placeId, [...(mediaOf.get(item.placeId) ?? []), item.id])
  const coverCities = cities.slice(0, Math.ceil(scale.cities / 6))
  return {
    places: { schema_version: 1, generated_at: NOW, places: [...countries, ...cities] },
    travel: { schema_version: 2, generated_at: NOW, display: { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] }, records },
    wantToGo: { schema_version: 2, generated_at: NOW, items },
    editorState: {
      schemaVersion: 2, addedCountries: [], countryOrder: countries.map((country) => country.id), hiddenCountryIds: [],
      cityOrderByCountry: Object.fromEntries(cityIdsOf), hiddenCityIds: [],
      mediaOrderByCity: Object.fromEntries(coverCities.map((city) => [city.id, mediaOf.get(city.id) ?? []])),
      hiddenMediaIds: media.filter((_, n) => n % 100 === 0).map((item) => item.id),
      coverMediaByCity: Object.fromEntries(coverCities.map((city) => [city.id, (mediaOf.get(city.id) ?? [])[0]]).filter(([, id]) => id)),
      droneOrderByCity: {}, hiddenDroneMediaIds: [],
    },
    media: { schemaVersion: 3, items: media },
  }
}

const rootsOf = (dir) => ({ v2: path.join(dir, 'v2-root'), store: path.join(dir, 'store-root') })

/** Both roots: the V2 files, and a copy migrated into the store. */
export async function generateRoots(dir, scale) {
  const roots = rootsOf(dir)
  const files = syntheticV2Files(scale)
  const problems = validateV2Files(files)
  if (problems.length) throw new Error(`synthetic V2 files invalid: ${problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join('; ')}`)
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: roots.v2 })
  await mkdir(paths.v2DataRoot, { recursive: true })
  for (const key of V2_PRIVATE_FILE_KEYS) await writeFile(paths.v2FilePaths[key], `${JSON.stringify(files[key], null, 2)}\n`)
  await cp(roots.v2, roots.store, { recursive: true })
  const storePaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: roots.store })
  let started = performance.now()
  const preview = await previewMigration(storePaths, { now: NOW })
  const previewMs = ms(started)
  started = performance.now()
  const applied = await applyMigration(storePaths, { now: NOW })
  return {
    rows: preview.report.rows, counts: preview.report.counts, previewOk: preview.ok, previewMs, applyMs: ms(started), revision: applied.revision,
  }
}

/** The local editor plugin for `root` (its module-scope paths come from the environment at its first import). */
async function pluginFor(root, log) {
  const original = process.env
  process.env = { ...original, STARMAP_PRIVATE_ROOT: root }
  let travelAtlasLocalEditor
  try { ({ travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')) } finally { process.env = original }
  const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
  const id = plugin.resolveId('virtual:starmap-private-data')
  const module = { id, transformResult: null }
  const handlers = []
  const consoleLog = console.log
  console.log = (line, ...rest) => (String(line).startsWith('[StarMap store]') ? log(String(line)) : consoleLog(line, ...rest))
  plugin.configureServer({
    middlewares: { use: (handler) => handlers.push(handler) },
    watcher: { add: () => {}, on: () => {} },
    moduleGraph: { getModuleById: (moduleId) => (moduleId === id ? module : undefined), invalidateModule: (target) => { target.transformResult = null } },
    ws: { send: () => {} },
  })
  const load = async () => {
    const started = performance.now()
    module.transformResult ??= { code: await plugin.load(id) }
    return { ms: ms(started), bytes: Buffer.byteLength(module.transformResult.code) }
  }
  return { plugin, handlers, load, module, restoreConsole: () => { console.log = consoleLog } }
}

/** `read`: the virtual module in both modes. */
export async function readSegment(dir) {
  const roots = rootsOf(dir)
  const v2 = await pluginFor(roots.v2, () => {})
  const v2Load = await v2.load()
  v2.restoreConsole()
  const lines = []
  const store = await pluginFor(roots.store, (line) => lines.push(line))
  const storeLoad = await store.load()
  const session = await (await import('./store-session.mjs')).createStoreSession(getPrivatePaths({ STARMAP_PRIVATE_ROOT: roots.store }), { log: () => {} })
  await store.plugin.buildEnd()
  // Rebuilds at the same revision (what each later page load would cost without the cache).
  const rebuilds = []
  const handle = await session.open()
  try {
    for (let n = 0; n < 5; n++) {
      const started = performance.now()
      const rows = handle.readRowsUnchecked()
      const readMs = ms(started)
      const { timings } = projectToV2Files(rows)
      rebuilds.push({ readMs, ...timings, totalMs: ms(started) })
    }
  } finally { await session.close() }
  store.restoreConsole()
  return { v2: { loadMs: v2Load.ms, moduleBytes: v2Load.bytes }, store: { loadMs: storeLoad.ms, moduleBytes: storeLoad.bytes, firstBuild: lines[0], rebuilds } }
}

/** One HTTP server on 127.0.0.1 (a free port) running the plugin's middlewares. */
async function serve(handlers) {
  const server = http.createServer((request, response) => {
    let index = 0
    const next = () => {
      const handler = handlers[index++]
      if (!handler) { response.statusCode = 404; response.end(); return }
      Promise.resolve(handler(request, response, next)).catch(() => { response.statusCode = 500; response.end() })
    }
    next()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

/** A plain agent: never a proxy from the environment (NODE_USE_ENV_PROXY makes the global agent use HTTP_PROXY). */
const directAgent = new http.Agent({ keepAlive: false })

/** POST JSON to the local server with node:http and the direct agent; resolves the parsed body. */
const postJson = (url, headers, body) => requestJson('POST', url, headers, body)

/** One request to the local server (body: JSON text, or undefined); resolves the parsed body. */
function requestJson(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const length = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }
    const request = http.request(url, { method, agent: directAgent, headers: { ...headers, ...length } }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(text)) } catch { reject(new Error(`HTTP ${response.statusCode}: not JSON (${text.length} characters)`)) }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** `http`: note updates through the plugin over HTTP in both modes. */
export async function httpSegment(dir, scale) {
  const roots = rootsOf(dir)
  const result = {}
  for (const mode of ['v2', 'store']) {
    const lines = []
    const { plugin, handlers, load, restoreConsole } = await pluginFor(roots[mode], (line) => lines.push(line))
    const { server, url } = await serve(handlers)
    try {
      await load()
      const read = await import(`data:text/javascript,${encodeURIComponent((await plugin.load(plugin.resolveId('virtual:starmap-private-data'))))}`)
      let revision = read.privateStoreRevision
      const endToEnd = [], reloads = []
      for (let n = 0; n < scale.updates; n++) {
        const id = `wish-${(n * 97) % scale.wishes}`
        const headers = { 'content-type': 'application/json', 'x-travelatlas-local-editor': '1' }
        if (mode === 'store') {
          headers['x-starmap-request-id'] = `01970000-0000-7000-8000-${hex(n + 1)}`
          headers['x-starmap-base-revision'] = String(revision)
        }
        const started = performance.now()
        const body = await postJson(`${url}/__travelatlas/editor/wanttogo/update`, headers, JSON.stringify({ id, note: `Synthetic bench note ${n}` }))
        endToEnd.push(ms(started))
        if (!body.ok) throw new Error(`${mode} update failed: ${body.code}`)
        if (mode === 'store') revision = body.revision
        reloads.push((await load()).ms)
      }
      const commits = lines.map((line) => /提交 ([\d.]+) ms/.exec(line)?.[1]).filter(Boolean).map(Number)
      result[mode] = { endToEnd: stats(endToEnd), reloadLoad: stats(reloads), ...(commits.length ? { commit: stats(commits) } : {}) }
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await plugin.buildEnd()
      restoreConsole()
    }
  }
  return result
}

/** Real ISO codes outside the synthetic countries (AA–DV): the countries the `editors` segment adds. */
const BENCH_COUNTRY_CODES = Object.freeze([
  'FR', 'GB', 'IT', 'JP', 'KR', 'NL', 'NO', 'PL', 'PT', 'SE', 'ES', 'FI', 'GR', 'HU', 'IE', 'IS', 'MX', 'NZ', 'PE', 'RO',
  'SG', 'TH', 'TR', 'UA', 'US', 'VN', 'ZA', 'EG', 'KE', 'MA', 'LT', 'LV',
])

/** The host's line of one store write (store-session.mjs): V2 write, diff, commit and total milliseconds. */
const HOST_LINE = /：V2 写入 ([\d.]+) ms，差异 ([\d.]+) ms（(\d+) 条命令(?:，重新编号 \d+ 个 scope)?），提交 ([\d.]+) ms（修订号 \d+），共 ([\d.]+) ms$/

/**
 * `editors` (3C-4a spec §2.5): the eight editor writes over HTTP through the plugin, in each mode, on freshly generated
 * roots (<dir>/editors), `scale.updates` times each in this order: countries, records, wanttogo, wanttogo/update,
 * wanttogo/convert (the items just added, then planned records), state (a country swap), state (hiding the added
 * countries), wanttogo/delete (hidden items), countries/delete (the added countries). Per endpoint: the client's
 * end-to-end milliseconds and, in the store mode, the host's (V2 write, diff, commit, total) from its log line.
 */
export async function editorsSegment(dir, scale) {
  // Fresh roots of their own (a copied root would be a moved library: V2 writes refuse it with E_LIBRARY_ROOT_MOVED).
  const base = path.join(dir, 'editors')
  await rm(base, { recursive: true, force: true })
  await generateRoots(base, scale)
  const copies = rootsOf(base)
  const result = {}
  for (const mode of ['v2', 'store']) {
    const lines = []
    const { plugin, handlers, load, restoreConsole } = await pluginFor(copies[mode], (line) => lines.push(line))
    const { server, url } = await serve(handlers)
    const timings = {}
    let requestCount = 0
    try {
      const read = await import(`data:text/javascript,${encodeURIComponent((await plugin.load(plugin.resolveId('virtual:starmap-private-data'))))}`)
      let revision = read.privateStoreRevision
      // The hidden want-to-go items to delete, from the first read (no write before the deletions touches them). The module
      // is not imported again: every data: import stays in the module map for the life of the process.
      const hidden = read.privateV2Files.wantToGo.items.filter((item) => item.hidden).map((item) => item.id).slice(0, scale.updates)
      const send = async (label, method, route, input) => {
        const headers = { 'content-type': 'application/json', 'x-travelatlas-local-editor': '1' }
        if (mode === 'store') {
          headers['x-starmap-request-id'] = `01970000-0000-7000-8000-${hex(++requestCount)}`
          headers['x-starmap-base-revision'] = String(revision)
        }
        const before = lines.length
        const started = performance.now()
        const body = await requestJson(method, `${url}/__travelatlas/editor/${route}`, headers, JSON.stringify(input))
        const endToEnd = ms(started)
        if (!body.ok) throw new Error(`${mode} ${label} failed: ${body.code}`)
        if (mode === 'store') revision = body.revision
        const entry = timings[label] ??= { endToEnd: [], v2Write: [], diff: [], commands: [], commit: [], host: [] }
        entry.endToEnd.push(endToEnd)
        const host = lines.slice(before).map((line) => HOST_LINE.exec(line)).find(Boolean)
        if (host) {
          entry.v2Write.push(Number(host[1])); entry.diff.push(Number(host[2])); entry.commands.push(Number(host[3]))
          entry.commit.push(Number(host[4])); entry.host.push(Number(host[5]))
        }
        await load()
        return body
      }
      const codes = BENCH_COUNTRY_CODES.slice(0, scale.updates)
      if (codes.length < scale.updates) throw new Error('not enough bench country codes')
      const countryIds = []
      for (const [n, code] of codes.entries()) countryIds.push((await send('countries', 'POST', 'countries', { countryCode: code, visitedDate: `2024-0${1 + (n % 9)}-1${n % 10}` })).countryId)
      for (const [n, code] of codes.entries()) {
        await send('records', 'POST', 'records', {
          country: code, country_en: code, city: `测试城市 ${n}`, city_en: `Bench city ${n}`, start_date: `2025-0${1 + (n % 9)}-1${n % 10}`,
          lat: 10 + n, lng: 20 + n, country_code: code, createNew: true,
        })
      }
      const wishIds = []
      for (const [n, code] of codes.entries()) {
        wishIds.push((await send('wanttogo', 'POST', 'wanttogo', {
          place: { kind: 'city', nameZh: `想去城市 ${n}`, nameEn: `Bench wish ${n}`, countryCode: code, lat: 30 + n, lng: 40 + n }, createNew: true,
        })).id)
      }
      for (let n = 0; n < scale.updates; n++) await send('wanttogo/update', 'POST', 'wanttogo/update', { id: `wish-${(n * 97) % scale.wishes}`, note: `Synthetic bench note ${n}` })
      for (let n = 0; n < scale.updates; n++) {
        const input = n % 2 === 0
          ? { source: 'want-to-go', id: wishIds[n], startDate: '2026-03-01', tripTitle: `Bench trip ${n}` }
          : { source: 'planned', recordId: `plan-${n}`, startDate: '2026-04-01' }
        await send('wanttogo/convert', 'POST', 'wanttogo/convert', input)
      }
      const editorState = async () => (await requestJson('GET', `${url}/__travelatlas/editor/state`, {}, undefined)).state
      for (let n = 0; n < scale.updates; n++) {
        const state = await editorState()
        const order = [...state.countryOrder]
        ;[order[0], order[1]] = [order[1], order[0]]
        await send('state', 'PUT', 'state', { ...state, countryOrder: order })
      }
      await send('state (hide countries)', 'PUT', 'state', { ...(await editorState()), hiddenCountryIds: countryIds })
      for (const id of hidden) await send('wanttogo/delete', 'POST', 'wanttogo/delete', { ids: [id] })
      for (const id of countryIds) await send('countries/delete', 'POST', 'countries/delete', { ids: [id] })
      result[mode] = Object.fromEntries(Object.entries(timings).map(([label, entry]) => [label, Object.fromEntries(
        Object.entries(entry).filter(([, values]) => values.length).map(([key, values]) => [key, stats(values)]),
      )]))
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await plugin.buildEnd()
      restoreConsole()
    }
  }
  return result
}

/** `pipeline`: what the App does with the module, and what the direct-Canonical alternative would skip. */
export async function pipelineSegment(dir) {
  const roots = rootsOf(dir)
  const { openStore } = await import('./store-host.mjs')
  const { OFFICIAL_POLICY } = await import('../src/data/store/officialDefinitions.ts')
  const handle = openStore(path.join(roots.store, 'data', 'store', 'world.sqlite'), { readOnly: true, policy: OFFICIAL_POLICY })
  let projected
  try { projected = projectToV2Files(handle.readRowsUnchecked()) } finally { await handle.close() }
  const { files, projection } = projected
  const time = (work) => { const started = performance.now(); const value = work(); return [ms(started), value] }
  const [serializeMs] = time(() => serializeV2(projection.canonical, projection.v2Meta))
  const [validateMs] = time(() => validateV2Files(files))
  const [readV2Ms, canonical] = time(() => readV2(files))
  const [canonicalForInputsMs] = time(() => canonicalForInputs({ v2Files: files }))
  const [deriveMs] = time(() => deriveAppDataFromCanonical(canonical, { now: NOW }))
  return {
    serializeMs, validateMs, readV2Ms, canonicalForInputsMs, deriveMs,
    v2FilesJsonBytes: Buffer.byteLength(JSON.stringify(files)), canonicalJsonBytes: Buffer.byteLength(JSON.stringify(projection.canonical)),
  }
}

/**
 * (3C-4b) `media`: media files for the store root's media items, so that a backup copies real files: one derivative
 * per item (its `src`, media/user/synthetic/<n>.webp, scale.derivativeKb), its original under
 * MediaInbox/<country>/<city>/photos/ (scale.originalKb) with a folder pin per city, and the media source index. Every
 * file starts with its own number and continues with one shared block of random bytes (incompressible, distinct hashes).
 */
export async function mediaSegment(dir, scale) {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: rootsOf(dir).store })
  const files = syntheticV2Files(scale)
  const placeOf = new Map(files.places.places.map((place) => [place.id, place]))
  const folderOf = (city) => [placeOf.get(city.partOf).names.en, city.names.en]
  const block = randomBytes(Math.max(scale.derivativeKb, scale.originalKb) * 1024)
  const bytesOf = (n, kb) => { const head = Buffer.from(`synthetic media ${n}\n`); return Buffer.concat([head, block.subarray(0, kb * 1024 - head.length)]) }
  const started = performance.now()
  await mkdir(path.join(paths.userMediaRoot, 'synthetic'), { recursive: true })
  for (const city of files.places.places.filter((place) => place.subtype === 'city')) {
    const folder = path.join(paths.inboxRoot, ...folderOf(city))
    await mkdir(path.join(folder, 'photos'), { recursive: true })
    await writeFile(path.join(folder, 'place.json'), `${JSON.stringify({ placeId: city.id })}\n`)
  }
  const sourcesById = {}
  let bytes = 0
  for (const [n, item] of files.media.items.entries()) {
    const source = [...folderOf(placeOf.get(item.placeId)), 'photos', item.originalFileName]
    await writeFile(path.join(paths.root, ...item.src.slice(1).split('/')), bytesOf(n, scale.derivativeKb))
    await writeFile(path.join(paths.inboxRoot, ...source), bytesOf(n, scale.originalKb))
    sourcesById[item.id] = [source.join('/')]
    bytes += (scale.derivativeKb + scale.originalKb) * 1024
  }
  await writeFile(paths.v2MediaSourceIndexPath, `${JSON.stringify({ schemaVersion: 1, generatedAt: NOW, sourcesById })}\n`)
  return { files: files.media.items.length * 2 + scale.cities + 1, mediaBytes: bytes, ms: ms(started) }
}

/** Bytes and files under `directory`. */
async function treeSize(directory) {
  let files = 0, bytes = 0
  for (const item of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!item.isFile()) continue
    files++
    bytes += (await stat(path.join(item.parentPath, item.name))).size
  }
  return { files, bytes }
}

/** (3C-4b) `backup`: store:backup of the store root (after `media`) into <dir>/backup, timed: under the lease, then the media copy. */
export async function backupSegment(dir) {
  const { backupStore } = await import('./store-backup.mjs')
  const out = path.join(dir, 'backup')
  await rm(out, { recursive: true, force: true })
  const started = performance.now()
  let leaseMs
  const { manifest } = await backupStore(getPrivatePaths({ STARMAP_PRIVATE_ROOT: rootsOf(dir).store }), { out, onMediaCopy: () => { leaseMs = ms(started) } })
  const totalMs = ms(started)
  return {
    totalMs, leaseMs, mediaCopyMs: Math.round((totalMs - leaseMs) * 10) / 10, revision: manifest.store.revision,
    storeBytes: manifest.files['world.sqlite'].bytes, mediaFiles: manifest.media.count, mediaBytes: manifest.media.bytes,
    manifestBytes: (await stat(path.join(out, 'manifest.json'))).size, backup: await treeSize(out),
  }
}

/** (3C-4b) `restore`: store:restore of <dir>/backup into <dir>/restored, timed. */
export async function restoreSegment(dir) {
  const { restoreStore } = await import('./store-backup.mjs')
  const to = path.join(dir, 'restored')
  await rm(to, { recursive: true, force: true })
  const started = performance.now()
  const { restoredFrom } = await restoreStore({ from: path.join(dir, 'backup'), to })
  return { totalMs: ms(started), revision: restoredFrom.revision, restored: await treeSize(to) }
}

const SEGMENTS = {
  generate: generateRoots, read: readSegment, http: httpSegment, pipeline: pipelineSegment, editors: editorsSegment,
  media: mediaSegment, backup: backupSegment, restore: restoreSegment,
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined }
  const dir = arg('--dir'), segment = arg('--segment'), scaleName = arg('--scale') ?? 'real'
  if (!dir || !Object.hasOwn(SEGMENTS, segment) || !Object.hasOwn(MODE_BENCH_SCALES, scaleName)) {
    console.error('用法：node scripts/store-mode-bench.mjs --dir <工作目录> --segment generate|read|http|pipeline|editors|media|backup|restore [--scale real|tiny] [--derivative-kb N --original-kb N]')
    process.exitCode = 1
  } else {
    mkdirSync(dir, { recursive: true })
    const started = performance.now()
    // --derivative-kb / --original-kb: other media file sizes for the media segment (a smaller run that fits a time budget).
    const sizes = Object.fromEntries([['derivativeKb', '--derivative-kb'], ['originalKb', '--original-kb']].filter(([, flag]) => arg(flag)).map(([key, flag]) => [key, Number(arg(flag))]))
    const result = await SEGMENTS[segment](path.resolve(dir), { ...MODE_BENCH_SCALES[scaleName], ...sizes })
    const line = JSON.stringify({ segment, scale: scaleName, at: new Date().toISOString(), node: process.versions.node, totalMs: ms(started), result })
    appendFileSync(path.join(dir, 'results.jsonl'), `${line}\n`)
    console.log(line)
  }
}
