/** Local-editor upload validation and byte-preserving delivery, without private-profile state. */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'
import { exists } from './json-file.mjs'
import { V2WriteError } from '../src/data/v2write/errors.ts'

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024

const nameFieldOf = (label) => ({
  文件名: 'media_filename',
  国家名: 'media_country',
  城市名: 'media_city',
})[label] ?? label

export const safeSegment = (value, label = 'media_filename') => {
  // eslint-disable-next-line no-control-regex -- Windows file names must reject ASCII control characters.
  const cleaned = String(value ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new V2WriteError('E_MEDIA_NAME_INVALID', { field: nameFieldOf(label) })
  return cleaned.slice(0, 120)
}

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

export const writeUpload = async (request, destination, kind) => {
  const contentLength = Number(request.headers['content-length'] ?? 0)
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw new V2WriteError('E_MEDIA_UPLOAD_EMPTY')
  if (contentLength > MAX_UPLOAD_BYTES) throw tooLarge()

  const temporaryPath = path.join(tmpdir(), `travelatlas-upload-${process.pid}-${Date.now()}`)
  let received = 0
  request.on('data', (chunk) => {
    received += chunk.length
    if (received > MAX_UPLOAD_BYTES) request.destroy(tooLarge())
  })

  try {
    await pipeline(request, createWriteStream(temporaryPath, { flags: 'wx' }))
    if (received === 0) throw new V2WriteError('E_MEDIA_UPLOAD_EMPTY')
    let imageMetadata
    try {
      imageMetadata = await sharp(temporaryPath).metadata()
    } catch (cause) {
      const error = new V2WriteError('E_MEDIA_IMAGE_INVALID')
      if (cause instanceof Error) error.details = cause.message
      throw error
    }
    if (!imageMetadata.width || !imageMetadata.height) throw new V2WriteError('E_MEDIA_IMAGE_INVALID')
    const dimensions = orientedImageDimensions(imageMetadata)
    if (kind === 'panorama360' && !isLikelyEquirectangularPanorama(dimensions)) {
      throw new V2WriteError('E_MEDIA_PANORAMA_RATIO', {
        width: dimensions?.width ?? imageMetadata.width,
        height: dimensions?.height ?? imageMetadata.height,
      })
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await pipeline(createReadStream(temporaryPath), createWriteStream(destination, { flags: 'wx' }))
    return imageMetadata
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}
