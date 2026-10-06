/** Read-only whole-Inbox plans for durable local media tasks. No private configuration is read. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { scanV2MediaImport, applyV2MediaImportScan } from './v2-media-import.mjs'
import { catalogIntegrityProblems, mediaCatalogFileOf, mediaSourceIndexFileOf, sourcesByIdOf } from '../src/data/v2media/importPlan.ts'

const PLAN_TIME = new Date('2026-01-01T00:00:00.000Z')
const posix = (value) => value.split(path.sep).join('/')
const hash = (value) => createHash('sha256').update(value).digest('hex')
// Only fingerprints of decoded deterministic outputs, keyed by complete source
// content and generator settings/version. Every on-disk result is still hashed.
const derivativeFingerprints = new Map()
const FINGERPRINT_LIMIT = 20000
const fileHash = (target) => new Promise((resolve, reject) => {
  const digest = createHash('sha256')
  const stream = createReadStream(target)
  stream.on('error', reject).on('data', (chunk) => digest.update(chunk)).on('end', () => resolve(digest.digest('hex')))
})
const exists = async (target) => {
  try { return await lstat(target) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]))
  return value
}
const stable = (value) => JSON.stringify(normalized(value))
const withoutTimestamp = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = { ...value }
  delete result.generatedAt
  delete result.generated_at
  return result
}
const fault = (code) => Object.assign(new Error(code), { code })
const relative = (root, target) => posix(path.relative(root, target))

/** Snapshot all relevant inputs, including ignored/unrelated Inbox files and output history. */
async function snapshot(privatePaths, blockers) {
  const result = []
  const root = privatePaths.root
  const add = (code, sourcePath) => blockers.push({ code, ...(sourcePath ? { sourcePath } : {}) })
  async function visit(target, namespace, semanticJson = false) {
    const info = await exists(target)
    if (!info) { result.push([namespace, 'missing']); return }
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
      add('E_MEDIA_PLAN_LINK', namespace)
      result.push([namespace, 'unsafe'])
      return
    }
    if (info.isDirectory()) {
      result.push([namespace, 'directory'])
      for (const entry of (await readdir(target)).sort()) await visit(path.join(target, entry), `${namespace}/${entry}`, semanticJson)
    } else {
      let digest = await fileHash(target)
      if (semanticJson && target.endsWith('.json')) {
        try { digest = hash(stable(withoutTimestamp(JSON.parse(await readFile(target, 'utf8'))))) } catch { add('E_MEDIA_PLAN_JSON', namespace) }
      }
      // Semantic JSON excludes the generator timestamp and formatting, including their varying lengths.
      result.push([namespace, semanticJson && target.endsWith('.json') ? 'json' : info.size, digest])
    }
  }
  // Check ancestors before traversing, so a linked parent cannot redirect reads outside the library.
  for (const target of [root, privatePaths.inboxRoot, privatePaths.v2DataRoot, privatePaths.userMediaRoot]) {
    let current = target
    while (current && path.relative(root, current) !== '..' && !path.relative(root, current).startsWith(`..${path.sep}`)) {
      const info = await exists(current)
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) add('E_MEDIA_PLAN_LINK', relative(root, current) || '.')
      if (current === root) break
      current = path.dirname(current)
    }
  }
  if (blockers.length) return result
  await visit(privatePaths.inboxRoot, 'MediaInbox')
  await visit(privatePaths.v2DataRoot, 'data/v2', true)
  await visit(privatePaths.userMediaRoot, 'media/user')
  return result
}

/** No directories/files are created. The summary alone is safe to send to a loopback client. */
export async function createMediaImportPlan({ privatePaths, unsafeTestDerivativeComputed }) {
  const blockers = []
  let inputs
  try { inputs = await snapshot(privatePaths, blockers) } catch { blockers.push({ code: 'E_MEDIA_PLAN_READ' }); inputs = [] }
  const empty = { addedIds: [], updatedIds: [], removedIds: [], sources: [], pins: [], outputs: [], blockers }
  if (blockers.length) return { digest: hash(stable(inputs)), summary: empty, blockers, entries: [], catalog: undefined, index: undefined }
  let scan
  try { scan = await scanV2MediaImport({ privatePaths, now: () => PLAN_TIME }) } catch { blockers.push({ code: 'E_MEDIA_PLAN_SCAN' }) }
  if (!scan) return { digest: hash(stable(inputs)), summary: empty, blockers, entries: [], catalog: undefined, index: undefined }
  for (const ignored of scan.errors) { void ignored; blockers.push({ code: 'E_MEDIA_PLAN_SCAN' }) }
  for (const warning of scan.warnings) {
    if (!scan.advisoryWarnings.includes(warning)) blockers.push({ code: 'E_MEDIA_PLAN_UNCERTAIN' })
  }
  const entries = scan.planned.map((entry) => ({ id: entry.id, sourcePath: relative(privatePaths.inboxRoot, entry.sourcePath), sha256: entry.sha256, bytes: entry.bytes, kind: entry.item.kind, placeId: entry.item.placeId }))
  const byId = new Map()
  const byContent = new Map()
  const byPrefix = new Map()
  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position]
    const ownership = `${entry.placeId}/${entry.kind}`
    const oldId = byId.get(entry.id)
    const oldHash = byContent.get(entry.sha256)
    const oldPrefix = byPrefix.get(entry.sha256.slice(0, 16))
    if (oldId && (oldId.sha256 !== entry.sha256 || oldId.placeId !== entry.placeId || oldId.kind !== entry.kind)) blockers.push({ code: 'E_MEDIA_PLAN_ID_COLLISION', sourcePath: entry.sourcePath })
    if (oldHash && oldHash.ownership !== ownership) blockers.push({ code: 'E_MEDIA_PLAN_CONTENT_COLLISION', sourcePath: entry.sourcePath })
    if (oldHash && oldHash.id !== entry.id) blockers.push({ code: 'E_MEDIA_PLAN_ID_COLLISION', sourcePath: entry.sourcePath })
    if (oldPrefix && oldPrefix !== entry.sha256) blockers.push({ code: 'E_MEDIA_PLAN_PREFIX_COLLISION', sourcePath: entry.sourcePath })
    byId.set(entry.id, entry)
    byContent.set(entry.sha256, { ownership, id: entry.id })
    byPrefix.set(entry.sha256.slice(0, 16), entry.sha256)
    const item = scan.planned[position].item
    if (item.kind !== 'photo') {
      const date = item.date
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) blockers.push({ code: 'E_MEDIA_PLAN_DATE', sourcePath: entry.sourcePath })
    }
  }
  const catalog = mediaCatalogFileOf(scan.items, PLAN_TIME.toISOString())
  const index = mediaSourceIndexFileOf(sourcesByIdOf(entries), PLAN_TIME.toISOString())
  if (catalogIntegrityProblems(scan.files, catalog, PLAN_TIME).length) blockers.push({ code: 'E_MEDIA_PLAN_INTEGRITY' })
  const oldCatalog = scan.files.media
  let oldIndex
  try { oldIndex = JSON.parse(await readFile(privatePaths.v2MediaSourceIndexPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') blockers.push({ code: 'E_MEDIA_PLAN_INDEX' }) }
  if ((oldIndex && !oldCatalog) || (oldCatalog && !oldIndex && Array.isArray(oldCatalog.items) && oldCatalog.items.length > 0)) blockers.push({ code: 'E_MEDIA_PLAN_CATALOG_INDEX' })
  if (oldCatalog && (oldCatalog.schemaVersion !== 3 || !Array.isArray(oldCatalog.items))) blockers.push({ code: 'E_MEDIA_PLAN_CATALOG' })
  if (oldIndex && (oldIndex.schemaVersion !== 1 || !oldIndex.sourcesById || typeof oldIndex.sourcesById !== 'object' || Array.isArray(oldIndex.sourcesById))) blockers.push({ code: 'E_MEDIA_PLAN_INDEX' })
  const oldItems = Array.isArray(oldCatalog?.items) ? oldCatalog.items : []
  if (oldCatalog && catalogIntegrityProblems(scan.files, oldCatalog, PLAN_TIME).length) blockers.push({ code: 'E_MEDIA_PLAN_CATALOG' })
  if (oldIndex?.sourcesById && Object.values(oldIndex.sourcesById).some((paths) => !Array.isArray(paths) || paths.length === 0 || paths.some((source) => typeof source !== 'string' || source.startsWith('/') || source.includes('\\') || source.split('/').some((part) => !part || part === '.' || part === '..')))) blockers.push({ code: 'E_MEDIA_PLAN_INDEX' })
  if (oldIndex?.sourcesById && stable(Object.keys(oldIndex.sourcesById).sort()) !== stable(oldItems.map((item) => item.id).sort())) blockers.push({ code: 'E_MEDIA_PLAN_CATALOG_INDEX' })
  const prior = new Map(oldItems.map((item) => [item.id, item]))
  // IDs may be explicitly changed in sidecars. Compare full original bytes too, so replacing
  // an old source with the same content under another ID cannot bypass historical ownership.
  const priorContent = new Map()
  for (const item of oldItems) {
    const match = typeof item.src === 'string' && /^\/media\/user\/([a-f0-9]{16})\/(original\.(?:jpg|jpeg|png|webp|avif|mp4|webm))$/.exec(item.src)
    if (!match) { blockers.push({ code: 'E_MEDIA_PLAN_CATALOG' }); continue }
    const target = path.join(privatePaths.userMediaRoot, match[1], match[2])
    try {
      const digest = await fileHash(target)
      if (digest.slice(0, 16) !== match[1]) blockers.push({ code: 'E_MEDIA_PLAN_OUTPUT', sourcePath: relative(privatePaths.userMediaRoot, target) })
      priorContent.set(digest, [...(priorContent.get(digest) ?? []), item])
    } catch { blockers.push({ code: 'E_MEDIA_PLAN_OUTPUT', sourcePath: relative(privatePaths.userMediaRoot, target) }) }
  }
  const bySource = new Map(entries.map((entry) => [entry.sourcePath, entry]))
  if (oldIndex?.sourcesById && typeof oldIndex.sourcesById === 'object') {
    for (const [id, sources] of Object.entries(oldIndex.sourcesById)) {
      if (!Array.isArray(sources)) continue
      for (const sourcePath of sources) {
        const source = bySource.get(sourcePath)
        if (source && source.id !== id) blockers.push({ code: 'E_MEDIA_PLAN_CATALOG_INDEX', sourcePath })
      }
    }
  }
  for (const entry of entries) {
    const old = prior.get(entry.id)
    if (old && (old.placeId !== entry.placeId || old.kind !== entry.kind)) blockers.push({ code: 'E_MEDIA_PLAN_OWNERSHIP', sourcePath: entry.sourcePath })
    for (const historical of priorContent.get(entry.sha256) ?? []) {
      if (historical.placeId !== entry.placeId || historical.kind !== entry.kind) blockers.push({ code: 'E_MEDIA_PLAN_OWNERSHIP', sourcePath: entry.sourcePath })
      if (historical.id !== entry.id) blockers.push({ code: 'E_MEDIA_PLAN_ID_COLLISION', sourcePath: entry.sourcePath })
    }
  }
  const outputs = []
  for (const entry of scan.unique) {
    const expected = [{ target: entry.outputPath, digest: entry.sha256 }]
    try {
      for (const derivative of entry.derivatives) {
        const key = stable({ source: entry.sha256, width: derivative.maxEdge, quality: derivative.quality, effort: 4, versions: sharp.versions, pipeline: 'rotate-resize-inside-webp-v1' })
        let fingerprint = derivativeFingerprints.get(key)
        if (!fingerprint) {
          const bytes = await sharp(entry.sourcePath, { failOn: 'error' }).rotate().resize({ width: derivative.maxEdge, height: derivative.maxEdge, fit: 'inside', withoutEnlargement: true }).webp({ quality: derivative.quality, effort: 4 }).toBuffer()
          fingerprint = hash(bytes)
          if (derivativeFingerprints.size >= FINGERPRINT_LIMIT) derivativeFingerprints.delete(derivativeFingerprints.keys().next().value)
          derivativeFingerprints.set(key, fingerprint)
          unsafeTestDerivativeComputed?.()
        }
        expected.push({ target: derivative.outputPath, digest: fingerprint })
      }
      const allowed = new Set(expected.map(({ target }) => path.basename(target)))
      const directory = await exists(entry.outputDirectory)
      if (directory) for (const name of await readdir(entry.outputDirectory)) if (!allowed.has(name)) blockers.push({ code: 'E_MEDIA_PLAN_OUTPUT', sourcePath: relative(privatePaths.userMediaRoot, path.join(entry.outputDirectory, name)) })
      for (const { target, digest } of expected) {
        outputs.push({ id: entry.id, path: `media/user/${relative(privatePaths.userMediaRoot, target)}`, sha256: digest })
        if (await exists(target) && await fileHash(target) !== digest) blockers.push({ code: 'E_MEDIA_PLAN_OUTPUT', sourcePath: relative(privatePaths.userMediaRoot, target) })
      }
      const previous = prior.get(entry.id)
      if (previous && previous.src !== entry.item.src) blockers.push({ code: 'E_MEDIA_PLAN_ID_COLLISION', sourcePath: relative(privatePaths.inboxRoot, entry.sourcePath) })
    } catch { blockers.push({ code: 'E_MEDIA_PLAN_OUTPUT', sourcePath: relative(privatePaths.inboxRoot, entry.sourcePath) }) }
  }
  const nextIds = new Set(scan.items.map((item) => item.id))
  const summary = {
    addedIds: scan.items.filter((item) => !prior.has(item.id)).map((item) => item.id),
    updatedIds: scan.items.filter((item) => prior.has(item.id) && stable(prior.get(item.id)) !== stable(item)).map((item) => item.id),
    removedIds: oldItems.filter((item) => !nextIds.has(item.id)).map((item) => item.id),
    sources: entries,
    pins: scan.pins.map((pin) => ({ sourcePath: `${relative(privatePaths.inboxRoot, pin.directory)}/place.json`, placeId: pin.placeId })),
    outputs,
    blockers,
  }
  const laterBlockers = []
  const after = await snapshot(privatePaths, laterBlockers)
  if (laterBlockers.length || stable(after) !== stable(inputs)) blockers.push({ code: 'E_MEDIA_PLAN_CHANGED' })
  // Include semantic desired results as well as all observed input bytes. Control changes cannot keep an old acknowledgement valid.
  return { digest: hash(stable({ inputs, catalog: withoutTimestamp(catalog), index: withoutTimestamp(index), summary })), summary, blockers, entries, catalog, index, scan, beforeInputs: inputs }
}

/** After the importer writes its outputs, verify every immutable input before sealing a receipt. */
export async function verifyMediaImportPlanInputs({ privatePaths, plan, editorWritten = false }) {
  const blockers = []
  const inputs = await snapshot(privatePaths, blockers)
  const mutableNames = [privatePaths.v2FilePaths.media, privatePaths.v2MediaSourceIndexPath, ...(editorWritten ? [privatePaths.v2FilePaths.editorState] : [])]
  const mutable = new Set([
    ...mutableNames.flatMap((target) => [target, target.replace(/\.json$/i, '.bak')]).map((target) => `data/v2/${path.basename(target)}`),
    ...plan.summary.pins.map((pin) => `MediaInbox/${pin.sourcePath}`),
  ])
  const immutable = (rows) => rows.filter(([name]) => !name.startsWith('media/user') && !mutable.has(name))
  if (blockers.length || stable(immutable(inputs)) !== stable(immutable(plan.beforeInputs))) throw fault('E_MEDIA_JOB_REVIEW')
  return true
}

/** Recompute and validate before the first output; never trusts caller-supplied scanner internals. */
export async function applyMediaImportPlan({ privatePaths, plan, onStage = async () => {}, now = () => new Date() }) {
  const fresh = await createMediaImportPlan({ privatePaths })
  if (fresh.digest !== plan?.digest) throw fault('E_MEDIA_JOB_CONFLICT')
  if (fresh.blockers.length) throw fault('E_MEDIA_JOB_REVIEW')
  const result = await applyV2MediaImportScan({ privatePaths, scan: fresh.scan, now, onStage })
  await verifyMediaImportPlanInputs({ privatePaths, plan: fresh })
  return result
}
