/** Persistent RD-07 task intents. Mutations MUST run under the shared library operation lease.
 * Construction and reads never create directories or repair damaged records. Completion requires
 * a sealed receipt; the service verifies the represented files before writing that receipt.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{64}$/
const LIMIT = 250 * 1024 * 1024
const RECORD_LIMIT = 1024 * 1024
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key))
const stamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const fail = (code, reason) => { throw new V2WriteError(code, reason ? { reason } : undefined) }
const exists = async (target) => {
  try { return await lstat(target) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const safeName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 200
  && [...name].every((character) => character.codePointAt(0) > 31 && (character.codePointAt(0) < 127 || character.codePointAt(0) > 159))
  && !/[/\\:<>"|?*]/.test(name) && !/[. ]$/.test(name)
  && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
  && name !== '.' && name !== '..'
const relativePath = (value) => typeof value === 'string' && value.length <= 1200 && value.split('/').every(safeName)
const metadataHash = (metadata) => createHash('sha256').update(JSON.stringify(metadata ?? {})).digest('hex')
const validDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}
const validMetadata = (value) => exact(value, ['date', 'lat', 'lng', 'altitudeMeters', 'relativeAltitudeMeters', 'titleZh', 'titleEn'])
  && validDate(value.date)
  && typeof value.titleZh === 'string' && value.titleZh.length <= 500 && typeof value.titleEn === 'string' && value.titleEn.length <= 500
  && (value.lat === undefined) === (value.lng === undefined)
  && (value.lat === undefined || (Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 && Number.isFinite(value.lng) && Math.abs(value.lng) <= 180))
  && ['altitudeMeters', 'relativeAltitudeMeters'].every((key) => value[key] === undefined || Number.isFinite(value[key]))
const validImage = (value) => exact(value, ['width', 'height', 'format', 'orientation'])
  && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0
  && ['jpeg', 'png', 'webp', 'avif', 'heif'].includes(value.format)
  && (value.orientation === undefined || (Number.isInteger(value.orientation) && value.orientation >= 1 && value.orientation <= 8))
const validFile = (file, kind) => exact(file, ['fileId', 'fileName', 'bytes', 'phase', 'metadata', 'metadataHash', 'operationId', 'sourcePath', 'expectedSha256', 'sha256', 'receivedBytes', 'image', 'errorCode']) && UUID.test(file.fileId)
  && safeName(file.fileName) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= LIMIT
  && ['intended', 'receiving', 'staged', 'received', 'needs_review'].includes(file.phase)
  && (kind === 'photo' ? file.metadata === undefined : validMetadata(file.metadata))
  && SHA.test(file.metadataHash) && file.metadataHash === metadataHash(file.metadata)
  && (file.operationId === undefined || UUID.test(file.operationId))
  && (file.sourcePath === undefined || relativePath(file.sourcePath))
  && (file.expectedSha256 === undefined || SHA.test(file.expectedSha256))
  && (file.sha256 === undefined || SHA.test(file.sha256))
  && (file.receivedBytes === undefined || (Number.isSafeInteger(file.receivedBytes) && file.receivedBytes > 0 && file.receivedBytes <= file.bytes))
  && (file.image === undefined || validImage(file.image))
  && (file.errorCode === undefined || file.errorCode === 'E_MEDIA_JOB_REVIEW')
  && (file.phase !== 'intended' || ['operationId', 'sourcePath', 'expectedSha256', 'sha256', 'receivedBytes', 'image', 'errorCode'].every((key) => file[key] === undefined))
  && (file.phase !== 'receiving' || (UUID.test(file.operationId) && relativePath(file.sourcePath) && SHA.test(file.expectedSha256)))
  && (!['staged', 'received'].includes(file.phase) || (UUID.test(file.operationId) && relativePath(file.sourcePath) && SHA.test(file.sha256)
    && file.expectedSha256 === file.sha256 && file.receivedBytes === file.bytes && validImage(file.image)))
const IMPORT_PHASES = ['started', 'generated', 'pins', 'catalog', 'index', 'editor', 'sealed']
const canonical = (value) => JSON.stringify(value, (_key, entry) => object(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)

/** A deterministic consistency seal, not an authentication signature or proof of file contents. */
export function mediaJobReceiptSeal(job, importRecord, receipt) {
  const body = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'seal'))
  const identity = Object.fromEntries(['schemaVersion', 'libraryId', 'jobId', 'countryId', 'cityId', 'kind', 'createdAt'].map((key) => [key, job[key]]))
  const operation = Object.fromEntries(['operationId', 'planDigest', 'sourceRevision', 'selectedFileIds'].map((key) => [key, importRecord[key]]))
  const files = importRecord.selectedFileIds.map((fileId) => job.files.find((file) => file.fileId === fileId))
  return createHash('sha256').update(canonical({ identity, operation, files, receipt: body })).digest('hex')
}
const ids = (value, { nonempty = false } = {}) => Array.isArray(value) && value.length <= 10000
  && (!nonempty || value.length > 0) && value.every(safeName) && new Set(value).size === value.length
const validReceipt = (job, record) => {
  const receipt = record.receipt
  return exact(receipt, ['completedAt', 'mediaIds', 'restoredMediaIds', 'outputs', 'seal'])
    && stamp(receipt.completedAt) && receipt.completedAt >= job.createdAt
    && ids(receipt.mediaIds, { nonempty: true }) && ids(receipt.restoredMediaIds)
    && receipt.restoredMediaIds.every((id) => receipt.mediaIds.includes(id))
    && Array.isArray(receipt.outputs) && receipt.outputs.length > 0 && receipt.outputs.length <= 10000
    && receipt.outputs.every((output) => exact(output, ['path', 'sha256', 'bytes']) && relativePath(output.path)
      && SHA.test(output.sha256) && Number.isSafeInteger(output.bytes) && output.bytes >= 0)
    && new Set(receipt.outputs.map((output) => output.path.toLocaleLowerCase('en-US'))).size === receipt.outputs.length
    && SHA.test(receipt.seal) && receipt.seal === mediaJobReceiptSeal(job, record, receipt)
}
const validImport = (job) => {
  const record = job.import
  if (record === undefined) return !['completed', 'closed'].includes(job.phase)
  return exact(record, ['operationId', 'planDigest', 'sourceRevision', 'selectedFileIds', 'phase', 'receipt'])
    && UUID.test(record.operationId) && SHA.test(record.planDigest)
    && Number.isSafeInteger(record.sourceRevision) && record.sourceRevision >= 0 && record.sourceRevision < job.revision + 1
    && Array.isArray(record.selectedFileIds) && record.selectedFileIds.length > 0 && record.selectedFileIds.length <= job.files.length
    && record.selectedFileIds.every((fileId) => UUID.test(fileId) && job.files.some((file) => file.fileId === fileId && file.phase === 'received'))
    && new Set(record.selectedFileIds).size === record.selectedFileIds.length
    && [...IMPORT_PHASES, 'needs_review'].includes(record.phase)
    && (record.phase === 'sealed' ? ['completed', 'closed'].includes(job.phase) && validReceipt(job, record)
      : !['completed', 'closed'].includes(job.phase) && record.receipt === undefined)
}
const validJob = (job) => exact(job, ['schemaVersion', 'libraryId', 'jobId', 'revision', 'phase', 'countryId', 'cityId', 'kind', 'createdAt', 'updatedAt', 'files', 'import'])
  && job.schemaVersion === 1 && UUID.test(job.libraryId) && UUID.test(job.jobId)
  && Number.isSafeInteger(job.revision) && job.revision >= 0 && ['open', 'paused', 'completed', 'closed'].includes(job.phase)
  && UUID.test(job.countryId) && UUID.test(job.cityId) && job.countryId !== job.cityId
  && ['photo', 'aerialPhoto', 'panorama360'].includes(job.kind)
  && stamp(job.createdAt) && stamp(job.updatedAt) && job.updatedAt >= job.createdAt
  && Array.isArray(job.files) && job.files.length > 0 && job.files.length <= 100 && job.files.every((file) => validFile(file, job.kind))
  && new Set(job.files.map((file) => file.fileId)).size === job.files.length
  && new Set(job.files.map((file) => file.fileName.toLocaleLowerCase('en-US'))).size === job.files.length
  && validImport(job)

/** Zero-write schema and encoded-size guard for a proposed complete task record. */
export function assertMediaJobRecord(job) {
  if (!validJob(job) || Buffer.byteLength(`${JSON.stringify(job, null, 2)}\n`, 'utf8') > RECORD_LIMIT) {
    fail('E_MEDIA_JOB_INVALID', 'Invalid or oversized task record')
  }
}

/** Every existing component is checked with lstat, so junctions/symlinks are refused. */
async function checked(root, segments, { create = false, file = false } = {}) {
  let target = root
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!safeName(segment)) fail('E_MEDIA_JOB_INVALID', 'Unsafe control path')
    target = path.join(target, segment)
    const lastFile = file && index === segments.length - 1
    let stats = await exists(target)
    if (!stats && create && !lastFile) {
      try { await mkdir(target) } catch (error) { if (error.code !== 'EEXIST') throw error }
      stats = await exists(target)
    }
    if (!stats) return { path: target, missing: true }
    if (stats.isSymbolicLink() || (lastFile ? !stats.isFile() || stats.nlink !== 1 || stats.size > RECORD_LIMIT : !stats.isDirectory())) {
      fail('E_MEDIA_JOB_REVIEW', 'Unsafe control path')
    }
    const resolved = await realpath(target)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('E_MEDIA_JOB_REVIEW', 'Control path outside library')
  }
  return { path: target, missing: false }
}
async function json(target) {
  try { return JSON.parse(await readFile(target, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') throw error
    fail('E_MEDIA_JOB_REVIEW', 'Unreadable task record')
  }
}
async function atomic(target, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > RECORD_LIMIT) fail('E_MEDIA_JOB_INVALID', 'Task record too large')
  const temporary = path.join(path.dirname(target), `${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(encoded, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, target) } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
const summary = (job) => ({
  jobId: job.jobId, libraryId: job.libraryId, revision: job.revision, phase: job.phase,
  countryId: job.countryId, cityId: job.cityId, kind: job.kind, createdAt: job.createdAt, updatedAt: job.updatedAt,
  files: job.files.map(({ fileId, fileName, bytes, phase }) => ({ fileId, fileName, bytes, phase })),
  ...(job.import ? { import: { operationId: job.import.operationId, phase: job.import.phase,
    ...(job.import.receipt ? { completedAt: job.import.receipt.completedAt, mediaIds: job.import.receipt.mediaIds, restoredMediaIds: job.import.receipt.restoredMediaIds } : {}) } } : {}),
})

export function createMediaJobStore(privatePaths) {
  const configured = path.resolve(privatePaths.root)
  const controls = ['operations', 'media-import', 'v1']
  async function rootInfo() {
    const stats = await exists(configured)
    if (!stats) return null
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('E_MEDIA_JOB_REVIEW', 'Unsafe library root')
    const root = await realpath(configured)
    const canonical = process.platform === 'win32' ? root.toLowerCase() : root
    return { root, binding: createHash('sha256').update(canonical).digest('hex') }
  }
  async function snapshot() {
    const info = await rootInfo()
    if (!info) return { library: null, jobs: [], info: null }
    const directory = await checked(info.root, controls)
    if (directory.missing) return { library: null, jobs: [], info }
    // Unrecognized files are preserved and block recovery. Temporary writes only occur under a lease.
    const names = await readdir(directory.path)
    if (names.some((name) => !['library.json', 'jobs', 'staging'].includes(name))) fail('E_MEDIA_JOB_REVIEW', 'Unexpected task control file')
    if (names.includes('staging')) await checked(info.root, [...controls, 'staging'])
    const identityPath = await checked(info.root, [...controls, 'library.json'], { file: true })
    if (identityPath.missing) {
      if (names.length) fail('E_MEDIA_JOB_REVIEW', 'Task identity missing')
      return { library: null, jobs: [], info }
    }
    const library = await json(identityPath.path)
    if (!exact(library, ['schemaVersion', 'libraryId', 'rootBinding', 'createdAt']) || library.schemaVersion !== 1
      || !UUID.test(library.libraryId) || !SHA.test(library.rootBinding) || !stamp(library.createdAt)
      || library.rootBinding !== info.binding) fail('E_MEDIA_JOB_REVIEW', 'Task identity mismatch')
    const jobDirectory = await checked(info.root, [...controls, 'jobs'])
    const jobs = []
    if (!jobDirectory.missing) {
      for (const name of (await readdir(jobDirectory.path)).sort()) {
        if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) fail('E_MEDIA_JOB_REVIEW', 'Unexpected task record')
        const located = await checked(info.root, [...controls, 'jobs', name], { file: true })
        if (located.missing) fail('E_MEDIA_JOB_REVIEW', 'Task changed during read')
        const job = await json(located.path)
        if (!validJob(job) || job.jobId !== name.slice(0, -5) || job.libraryId !== library.libraryId) fail('E_MEDIA_JOB_REVIEW', 'Invalid task record')
        jobs.push(job)
      }
    }
    return { library, jobs, info }
  }
  async function read(jobId) {
    if (!UUID.test(jobId)) fail('E_MEDIA_JOB_INVALID', 'Invalid task id')
    const state = await snapshot()
    const job = state.jobs.find((entry) => entry.jobId === jobId)
    if (!job) fail('E_MEDIA_JOB_NOT_FOUND')
    return job
  }
  async function assertClear() {
    const state = await snapshot()
    if (state.jobs.some((job) => !['completed', 'closed'].includes(job.phase))) fail('E_MEDIA_JOB_PENDING')
  }
  async function create(input) {
    if (!exact(input, ['countryId', 'cityId', 'kind', 'files']) || !UUID.test(input.countryId) || !UUID.test(input.cityId)
      || input.countryId === input.cityId || !['photo', 'aerialPhoto', 'panorama360'].includes(input.kind)
      || !Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100
      || input.files.some((file) => !exact(file, ['fileName', 'bytes', 'metadata', 'metadataHash']) || !safeName(file.fileName) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > LIMIT
        || (input.kind === 'photo' ? file.metadata !== undefined : !validMetadata(file.metadata))
        || (file.metadataHash !== undefined && file.metadataHash !== metadataHash(file.metadata)))
      || new Set(input.files.map((file) => file.fileName.toLocaleLowerCase('en-US'))).size !== input.files.length) fail('E_MEDIA_JOB_INVALID', 'Invalid file intent')
    const state = await snapshot()
    if (!state.info) fail('E_MEDIA_JOB_REVIEW', 'Library root missing')
    if (state.jobs.some((job) => !['completed', 'closed'].includes(job.phase))) fail('E_MEDIA_JOB_PENDING')
    const now = new Date().toISOString()
    let library = state.library
    await checked(state.info.root, controls, { create: true })
    if (!library) {
      library = { schemaVersion: 1, libraryId: randomUUID(), rootBinding: state.info.binding, createdAt: now }
      const identity = await checked(state.info.root, [...controls, 'library.json'], { file: true })
      if (!identity.missing) fail('E_MEDIA_JOB_CONFLICT', 'Task identity appeared')
      await atomic(identity.path, library)
    }
    await checked(state.info.root, [...controls, 'jobs'], { create: true })
    const job = { schemaVersion: 1, libraryId: library.libraryId, jobId: randomUUID(), revision: 0, phase: 'open',
      countryId: input.countryId, cityId: input.cityId, kind: input.kind, createdAt: now, updatedAt: now,
      files: input.files.map((file) => ({ fileId: randomUUID(), fileName: file.fileName, bytes: file.bytes, phase: 'intended',
        ...(file.metadata === undefined ? {} : { metadata: structuredClone(file.metadata) }), metadataHash: metadataHash(file.metadata) })) }
    const destination = await checked(state.info.root, [...controls, 'jobs', `${job.jobId}.json`], { file: true })
    if (!destination.missing) fail('E_MEDIA_JOB_CONFLICT', 'Task id already exists')
    await atomic(destination.path, job)
    return structuredClone(job)
  }
  async function update(jobId, expectedRevision, mutator) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof mutator !== 'function') fail('E_MEDIA_JOB_INVALID', 'Invalid task update')
    const job = await read(jobId)
    if (job.revision !== expectedRevision) fail('E_MEDIA_JOB_CONFLICT')
    const next = await mutator(structuredClone(job))
    const immutable = ['schemaVersion', 'libraryId', 'jobId', 'revision', 'countryId', 'cityId', 'kind', 'createdAt']
    const transitions = {
      intended: ['intended', 'receiving', 'needs_review'], receiving: ['receiving', 'staged', 'needs_review'],
      staged: ['staged', 'received', 'needs_review'], received: ['received', 'needs_review'], needs_review: ['needs_review'],
    }
    const importMutationValid = () => {
      if (job.import === undefined) return next.import === undefined || (next.import.phase === 'started'
        && next.import.sourceRevision === job.revision && next.phase === 'open' && canonical(next.files) === canonical(job.files))
      if (!next.import || canonical(next.files) !== canonical(job.files)
        || ['operationId', 'planDigest', 'sourceRevision', 'selectedFileIds'].some((key) => canonical(next.import[key]) !== canonical(job.import[key]))) return false
      if (job.import.phase === 'sealed') return canonical(next.import) === canonical(job.import)
        && (job.phase === 'closed' ? next.phase === 'closed' : ['completed', 'closed'].includes(next.phase))
      if (next.import.phase === 'sealed' ? next.phase !== 'completed' : next.phase !== job.phase) return false
      if (job.import.phase === 'needs_review') return next.import.phase === 'needs_review'
      return next.import.phase === 'needs_review' || next.import.phase === job.import.phase
        || IMPORT_PHASES.indexOf(next.import.phase) === IMPORT_PHASES.indexOf(job.import.phase) + 1
    }
    if (!validJob(next) || immutable.some((key) => next[key] !== job[key])
      || !importMutationValid()
      || next.files.length !== job.files.length || next.files.some((file, index) => ['fileId', 'fileName', 'bytes', 'metadataHash'].some((key) => file[key] !== job.files[index][key])
        || JSON.stringify(file.metadata) !== JSON.stringify(job.files[index].metadata)
        || !transitions[job.files[index].phase].includes(file.phase)
        || ['operationId', 'sourcePath', 'expectedSha256', 'sha256', 'receivedBytes', 'image'].some((key) => job.files[index][key] !== undefined && JSON.stringify(file[key]) !== JSON.stringify(job.files[index][key])))) fail('E_MEDIA_JOB_INVALID', 'Invalid task update')
    const info = await rootInfo()
    if (!info) fail('E_MEDIA_JOB_REVIEW', 'Library disappeared')
    const destination = await checked(info.root, [...controls, 'jobs', `${jobId}.json`], { file: true })
    if (destination.missing) fail('E_MEDIA_JOB_REVIEW', 'Task disappeared')
    next.revision += 1
    next.updatedAt = new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString()
    assertMediaJobRecord(next)
    await atomic(destination.path, next)
    return structuredClone(next)
  }
  return {
    discover: async () => { const state = await snapshot(); return { libraryId: state.library?.libraryId ?? null, jobs: state.jobs.map(summary) } },
    read, create, update, assertClear,
    pause: (jobId, revision) => update(jobId, revision, (job) => {
      if (job.import) fail('E_MEDIA_JOB_INVALID', 'Import already started')
      return { ...job, phase: 'paused' }
    }),
    close: async (jobId, revision) => {
      const job = await read(jobId)
      if (job.phase === 'closed') return structuredClone(job)
      if (job.phase !== 'completed') fail('E_MEDIA_JOB_INVALID', 'Completion receipt required')
      return update(jobId, revision, (value) => ({ ...value, phase: 'closed' }))
    },
  }
}

export const assertMediaJobsClear = (privatePaths) => createMediaJobStore(privatePaths).assertClear()
