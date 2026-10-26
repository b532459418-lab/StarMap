/** Local-editor upload validation and byte-preserving delivery, without private-profile state. */
import { createWriteStream } from 'node:fs'
import { mkdir, unlink, link, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { exists } from './json-file.mjs'
import { V2WriteError } from '../src/data/editor/errors.ts'
import { firstUnsafeComponent, relativeInside } from './path-containment.mjs'
import { toSafePathSegment } from './media-path-segment.mjs'

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024

const nameFieldOf = (label) => ({
  文件名: 'media_filename',
  国家名: 'media_country',
  城市名: 'media_city',
})[label] ?? label

/**
 * Inbox folder and file names (review D9): the shared rule in ./media-path-segment.mjs escapes trailing dots and spaces,
 * Windows device names and control characters, so every name produced here is one the media task store accepts.
 */
export const safeSegment = (value, label = 'media_filename') => toSafePathSegment(value, nameFieldOf(label))

export const reserveDestination = async (directory, originalName) => {
  const parsed = path.parse(safeSegment(originalName, 'media_filename'))
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext.toLowerCase()}`)
    if (!await exists(candidate)) return candidate
  }
  throw new V2WriteError('E_MEDIA_NAME_EXHAUSTED')
}

export const orientedImageDimensions = (metadata) => {
  const orientation = metadata.orientation ?? 1
  const swapsAxes = orientation >= 5 && orientation <= 8
  const width = swapsAxes ? metadata.height : metadata.width
  const height = swapsAxes ? metadata.width : metadata.height
  return width && height ? { width, height } : undefined
}

export const isLikelyEquirectangularPanorama = (dimensions) => {
  if (!dimensions) return false
  const ratio = dimensions.width / dimensions.height
  return ratio >= 1.9 && ratio <= 2.1
}

const tooLarge = () => new V2WriteError('E_MEDIA_UPLOAD_TOO_LARGE', { limitMiB: 250, limitBytes: MAX_UPLOAD_BYTES })

/** Reject links and non-directory ancestors before touching a bounded private path (./path-containment.mjs). */
export const assertUploadPath = async (root, target) => {
  if (relativeInside(root, target) === undefined || await firstUnsafeComponent(root, target) !== undefined) {
    throw new V2WriteError('E_MEDIA_JOB_REVIEW')
  }
}

/** Receive and fully decode before publishing; caller chooses a private staging path. */
export const stageUpload = async (request, temporaryPath, kind, expectedBytes) => {
  const contentLength = Number(request.headers['content-length'] ?? 0)
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw new V2WriteError('E_MEDIA_UPLOAD_EMPTY')
  if (contentLength > MAX_UPLOAD_BYTES) throw tooLarge()
  if (!Number.isSafeInteger(contentLength) || (expectedBytes !== undefined && contentLength !== expectedBytes)) throw new V2WriteError('E_MEDIA_JOB_CONFLICT')
  let received = 0
  const hash = createHash('sha256')
  const counter = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length; hash.update(chunk)
    callback(received > MAX_UPLOAD_BYTES ? tooLarge() : null, chunk)
  } })
  await pipeline(request, counter, createWriteStream(temporaryPath, { flags: 'wx' }))
  if (!received) throw new V2WriteError('E_MEDIA_UPLOAD_EMPTY')
  if (received !== contentLength) throw new V2WriteError('E_MEDIA_JOB_CONFLICT')
  const handle = await open(temporaryPath, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  let imageMetadata
  try {
    imageMetadata = await sharp(temporaryPath, { failOn: 'error' }).metadata()
    // Metadata alone may succeed for a truncated image; force a decode of all input.
    await sharp(temporaryPath, { failOn: 'error' }).resize(1, 1).raw().toBuffer()
  } catch (cause) {
    const failure = new V2WriteError('E_MEDIA_IMAGE_INVALID')
    if (cause instanceof Error) failure.details = cause.message
    throw failure
  }
  if (!imageMetadata.width || !imageMetadata.height) throw new V2WriteError('E_MEDIA_IMAGE_INVALID')
  const dimensions = orientedImageDimensions(imageMetadata)
  if (kind === 'panorama360' && !isLikelyEquirectangularPanorama(dimensions)) {
    throw new V2WriteError('E_MEDIA_PANORAMA_RATIO', {
      width: dimensions?.width ?? imageMetadata.width,
      height: dimensions?.height ?? imageMetadata.height,
    })
  }
  return { imageMetadata, bytes: received, sha256: hash.digest('hex') }
}

/** Same-volume hard-link publication exposes a complete file and never replaces one. */
export const publishUpload = async (temporaryPath, destination) => {
  await mkdir(path.dirname(destination), { recursive: true })
  await link(temporaryPath, destination)
}

export const writeUpload = async (request, destination, kind, { stagingRoot } = {}) => {
  const directory = stagingRoot ?? tmpdir()
  if (stagingRoot) {
    await assertUploadPath(path.dirname(path.dirname(stagingRoot)), path.join(stagingRoot, 'probe'))
    await mkdir(stagingRoot, { recursive: true })
  }
  const temporaryPath = path.join(directory, `travelatlas-upload-${randomUUID()}.part`)
  try {
    const { imageMetadata } = await stageUpload(request, temporaryPath, kind)
    if (stagingRoot) await assertUploadPath(path.dirname(path.dirname(stagingRoot)), destination)
    await publishUpload(temporaryPath, destination)
    return imageMetadata
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}
