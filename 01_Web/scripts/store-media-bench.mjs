/**
 * Media in the new library against V2 mode (3C-4c, design v2 §10), on the real plugin path over HTTP (the plugin's
 * middleware in a node:http server on 127.0.0.1, as ./store-mode-bench.mjs does) with synthetic images on temporary
 * roots: the invented places and Inbox of ./media-inbox.fixture.mjs, imported by V2 (bindings confirmed), and for the
 * store mode migrated. Never part of `npm test` (store-media-bench.test.mjs runs a tiny scale only).
 *
 *   node scripts/store-media-bench.mjs --dir <work dir> --mode v2|store --segment <segment> [--files <n>]
 *   ops       import 50 new photos; delete 1 of them (hidden first); rename a city folder holding --files photos
 *             (default 200) and import again (V2: the same content ids; the store: moves)
 *   rescan    --files photos (default 10,000) imported, then an import with nothing new (V2 hashes and reads every
 *             file; the store's scan cache skips unchanged ones)
 *   grow      --files more photos into --root (a root from an earlier run; a new one without it) and an import: builds a
 *             large library in steps that each fit a command's time
 *   rescan-only  one import with nothing new on --root (no photo written first)
 *   latency   GET /media/jobs every 20 ms while an import of --files new photos (default 200) runs (their answers counted)
 * Each run prints one JSON line and appends it to <dir>/results.jsonl. The media service runs in the dev server's process.
 *
 * 3C-4d: the new library is the only write path, so `--mode` is `store` only (a V2 root's media endpoints answer
 * E_STORE_MIGRATION_REQUIRED). The V2 figures of 3C-4c stay in its report. The V2 import still builds the synthetic
 * library that is then migrated (./media-inbox.fixture.mjs).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { PLACE, importedV2Library } from './media-inbox.fixture.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { applyMigration } from './store-migrate.mjs'
import { ms, pluginFor, requestJson, serve, stats } from './store-mode-bench.mjs'
import { servedModuleOf, servedV2Files } from './private-read-model.fixture.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'

const NOW = '2026-10-16T00:00:00.000Z'
const EDITOR = { 'content-type': 'application/json', 'x-travelatlas-local-editor': '1', origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' }

/** `count` distinct small JPEGs (a unique EXIF description each) in `directory`, named `<prefix>-<n>.jpg`. */
export async function writePhotos(directory, count, prefix = 'bench') {
  await mkdir(directory, { recursive: true })
  const names = []
  for (let n = 0; n < count; n++) {
    const color = { r: n % 256, g: Math.floor(n / 256) % 256, b: 90 }
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).jpeg({ quality: 80 }).withExif({ IFD0: { ImageDescription: `${prefix} ${n}` } }).toBuffer()
    const name = `${prefix}-${n}.jpg`
    await writeFile(path.join(directory, name), bytes)
    names.push(name)
  }
  return names
}

/** A fresh root under `dir` in `mode` (`store` only, 3C-4d): the synthetic library imported by V2, then migrated. */
export async function benchRoot(dir, mode) {
  if (mode !== 'store') throw new Error(`3C-4d: the media bench runs the store mode only (got ${mode})`)
  mkdirSync(dir, { recursive: true })
  const root = path.join(await mkdtemp(path.join(dir, `${mode}-`)), 'private')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await importedV2Library(paths, { now: NOW })
  if (mode === 'store') await applyMigration(paths, { now: NOW })
  return paths
}

/** The plugin over HTTP on `paths`, with the helpers of a page: import, hide, delete, the task list. */
async function served(paths, mode) {
  const { plugin, handlers, load, module, restoreConsole } = await pluginFor(paths.root, () => {})
  const { server, url } = await serve(handlers)
  const view = async () => {
    module.transformResult = null
    await load()
    const read = await servedModuleOf(plugin, module.transformResult.code)
    return { revision: read.privateStoreRevision, files: servedV2Files(read) }
  }
  let revision = (await view()).revision
  const write = async (route, input, method = 'POST') => {
    const headers = { ...EDITOR, ...(mode === 'store' ? { 'x-starmap-request-id': uuidv7(), 'x-starmap-base-revision': String(revision) } : {}) }
    const body = await requestJson(method, `${url}/__travelatlas/editor/${route}`, headers, JSON.stringify(input))
    if (!body.ok) throw new Error(`${mode} ${route}: ${body.code} ${body.details ?? ''}`)
    if (mode === 'store' && body.revision !== undefined) revision = body.revision
    return body
  }
  return {
    view, write,
    tasks: () => requestJson('GET', `${url}/__travelatlas/editor/media/jobs`, EDITOR),
    state: () => requestJson('GET', `${url}/__travelatlas/editor/state`, EDITOR),
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await plugin.buildEnd()
      restoreConsole()
    },
  }
}

const timed = async (run) => {
  const started = performance.now()
  const result = await run()
  return { ms: ms(started), result }
}

/** `ops`: import 50, delete 1, rename a folder of `files` photos. */
export async function opsSegment(dir, mode, { files = 200, imported = 50 } = {}) {
  const paths = await benchRoot(dir, mode)
  const river = path.join(paths.inboxRoot, 'Second Land', 'River Town')
  await writePhotos(path.join(river, 'photos'), files, 'rename')
  const page = await served(paths, mode)
  try {
    const beforeItems = (await page.view()).files.media.items.length
    const setup = await timed(() => page.write('import', {}))
    await writePhotos(path.join(paths.inboxRoot, 'Synthland', 'Harbor Town', 'photos'), imported, 'new')
    const importMs = (await timed(() => page.write('import', {}))).ms
    const { files: v2 } = await page.view()
    const victim = v2.media.items.find((item) => item.originalFileName === 'new-0.jpg')
    const { state } = await page.state()
    await page.write('state', { ...state, hiddenMediaIds: [...state.hiddenMediaIds, victim.id] }, 'PUT')
    const deleteMs = (await timed(() => page.write('media/delete', { cityId: PLACE.harbor, ids: [victim.id] }))).ms
    await rename(river, path.join(paths.inboxRoot, 'Second Land', 'River Town Moved'))
    const renameMs = (await timed(() => page.write('import', {}))).ms
    const after = (await page.view()).files.media.items.length
    return { mode, segment: 'ops', setupImportMs: setup.ms, import50Ms: importMs, delete1Ms: deleteMs, renameFolderFiles: files, renameImportMs: renameMs, beforeItems, mediaItems: after }
  } finally { await page.close() }
}

/** `rescan`: `files` photos imported, then an import with nothing new. */
export async function rescanSegment(dir, mode, { files = 10_000 } = {}) {
  const paths = await benchRoot(dir, mode)
  const generated = await timed(() => writePhotos(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'photos'), files, 'many'))
  const page = await served(paths, mode)
  try {
    const first = await timed(() => page.write('import', {}))
    const rescans = []
    for (let n = 0; n < 3; n++) rescans.push((await timed(() => page.write('import', {}))).ms)
    return { mode, segment: 'rescan', files, writePhotosMs: generated.ms, firstImportMs: first.ms, rescanMs: stats(rescans) }
  } finally { await page.close() }
}

/** The paths of an existing bench root, or a new one. */
const rootOf = async (dir, mode, root) => (root ? getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.resolve(root) }) : benchRoot(dir, mode))

/** `grow`: `files` more photos into `root` (numbered after the ones there), then one import. */
export async function growSegment(dir, mode, { files = 2_000, root } = {}) {
  const paths = await rootOf(dir, mode, root)
  const photos = path.join(paths.inboxRoot, 'Second Land', 'River Town', 'photos')
  const { readdir } = await import('node:fs/promises')
  const before = (await readdir(photos).catch(() => [])).filter((name) => name.startsWith('many-')).length
  await mkdir(photos, { recursive: true })
  for (let n = 0; n < files; n++) {
    const index = before + n
    const color = { r: index % 256, g: Math.floor(index / 256) % 256, b: 90 }
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).jpeg({ quality: 80 }).withExif({ IFD0: { ImageDescription: `many ${index}` } }).toBuffer()
    await writeFile(path.join(photos, `many-${index}.jpg`), bytes)
  }
  const page = await served(paths, mode)
  try {
    const imported = await timed(() => page.write('import', {}))
    return { mode, segment: 'grow', root: paths.root, added: files, total: before + files, importMs: imported.ms }
  } finally { await page.close() }
}

/** `rescan-only`: one import with nothing new on `root`. */
export async function rescanOnlySegment(dir, mode, { root } = {}) {
  if (!root) throw new Error('rescan-only needs --root')
  const paths = await rootOf(dir, mode, root)
  const page = await served(paths, mode)
  try {
    const rescan = await timed(() => page.write('import', {}))
    return { mode, segment: 'rescan-only', root: paths.root, mediaItems: (await page.view()).files.media.items.length, rescanMs: rescan.ms }
  } finally { await page.close() }
}

/** `latency`: the task list read every 20 ms while an import of `files` new photos runs. */
export async function latencySegment(dir, mode, { files = 200 } = {}) {
  const paths = await benchRoot(dir, mode)
  const page = await served(paths, mode)
  try {
    await writePhotos(path.join(paths.inboxRoot, 'Synthland', 'Harbor Town', 'photos'), files, 'busy')
    const latencies = []
    const answers = {}
    let done = false
    const reader = (async () => {
      while (!done) {
        const started = performance.now()
        const body = await page.tasks()
        latencies.push(ms(started))
        // A read that meets an operation starting or ending is E_MEDIA_JOB_CONFLICT (the page reads again), as in V2.
        const answer = body.ok ? body.status ?? 'idle' : body.code
        answers[answer] = (answers[answer] ?? 0) + 1
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()
    const imported = await timed(() => page.write('import', {}))
    done = true
    await reader
    return { mode, segment: 'latency', files, importMs: imported.ms, taskListMs: stats(latencies), answers }
  } finally { await page.close() }
}

const SEGMENTS = Object.freeze({ ops: opsSegment, rescan: rescanSegment, latency: latencySegment, grow: growSegment, 'rescan-only': rescanOnlySegment })

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined }
  const dir = arg('--dir'), mode = arg('--mode'), segment = arg('--segment'), files = arg('--files'), root = arg('--root')
  if (!dir || mode !== 'store' || !SEGMENTS[segment]) {
    console.error('用法：node scripts/store-media-bench.mjs --dir <工作目录> --mode store --segment ops|rescan|latency|grow|rescan-only [--files <n>] [--root <私人根>]（3C-4d 起只有新库模式）')
    process.exitCode = 1
  } else {
    const result = await SEGMENTS[segment](path.resolve(dir), mode, { ...(files ? { files: Number(files) } : {}), ...(root ? { root } : {}) })
    const line = JSON.stringify({ ...result, at: new Date().toISOString() })
    console.log(line)
    appendFileSync(path.join(path.resolve(dir), 'results.jsonl'), `${line}\n`)
  }
}
