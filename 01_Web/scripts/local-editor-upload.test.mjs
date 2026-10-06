import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { AsyncLocalStorage } from 'node:async_hooks'
import sharp from 'sharp'
import { V2WriteError } from '../src/data/v2write/errors.ts'
import {
  MAX_UPLOAD_BYTES,
  isLikelyEquirectangularPanorama,
  orientedImageDimensions,
  reserveDestination,
  safeSegment,
  writeUpload as actualWriteUpload,
} from './local-editor-upload.mjs'

const uploadRoots = new AsyncLocalStorage()
const writeUpload = (request, destination, kind) => actualWriteUpload(request, destination, kind,
  { stagingRoot: path.join(uploadRoots.getStore(), 'operations', 'uploads') })

const fixture = async (run) => {
  const root = await mkdtemp(path.join(tmpdir(), 'starmap-upload-test-'))
  const directory = path.join(root, 'files')
  await mkdir(directory)
  try {
    await uploadRoots.run(root, () => run(directory))
    const files = await readdir(path.join(root, 'operations', 'uploads')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    assert.deepEqual(files, [], 'Every test-owned upload temporary file must be removed')
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('starmap-upload-test-'))
    await rm(root, { recursive: true, force: true })
  }
}

const requestOf = (chunks, contentLength) => {
  const request = Readable.from(chunks, { objectMode: false })
  request.headers = contentLength === undefined ? {} : { 'content-length': String(contentLength) }
  return request
}

const image = async (width, height, orientation) => {
  let source = sharp({ create: { width, height, channels: 3, background: '#808080' } }).jpeg()
  if (orientation !== undefined) source = source.withMetadata({ orientation })
  return source.toBuffer()
}

const rejectsCode = (operation, code, params) => assert.rejects(operation, (error) => {
  assert.ok(error instanceof V2WriteError)
  assert.equal(error.code, code)
  if (params !== undefined) assert.deepEqual(error.params, params)
  return true
})

test('Filename sanitization preserves Unicode and maps legacy labels into structured fields', () => {
  assert.equal(safeSegment('  Neutral<>:"/\\|?*\u0000.JPG  '), 'Neutral----------.JPG')
  assert.equal(safeSegment('京都・Kyoto.jpg'), '京都・Kyoto.jpg')
  assert.equal(safeSegment('a'.repeat(125)), 'a'.repeat(120))
  for (const [label, field] of [['文件名', 'media_filename'], ['国家名', 'media_country'], ['城市名', 'media_city']]) {
    for (const value of ['', '   ', '.', '..', null]) {
      assert.throws(() => safeSegment(value, label), (error) => error instanceof V2WriteError
        && error.code === 'E_MEDIA_NAME_INVALID' && error.params.field === field)
    }
    assert.throws(() => safeSegment('', field), (error) => error.params.field === field)
  }
})

test('Destination selection lowercases extensions and never modifies existing same-name files', async () => fixture(async (directory) => {
  await writeFile(path.join(directory, 'neutral.jpg'), 'first neutral file')
  await writeFile(path.join(directory, 'neutral-1.jpg'), 'second neutral file')
  const destination = await reserveDestination(directory, 'neutral.JPG')
  assert.equal(destination, path.join(directory, 'neutral-2.jpg'))
  assert.equal(await readFile(path.join(directory, 'neutral.jpg'), 'utf8'), 'first neutral file')
  assert.equal(await readFile(path.join(directory, 'neutral-1.jpg'), 'utf8'), 'second neutral file')
  assert.deepEqual((await readdir(directory)).sort(), ['neutral-1.jpg', 'neutral.jpg'])
}))

test('A thousand occupied destination names fail without overwriting or reserving another file', async () => fixture(async (directory) => {
  for (let first = 0; first < 1000; first += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, offset) => {
      const index = first + offset
      return writeFile(path.join(directory, `neutral${index ? `-${index}` : ''}.jpg`), `neutral ${index}`)
    }))
  }
  await rejectsCode(reserveDestination(directory, 'neutral.JPG'), 'E_MEDIA_NAME_EXHAUSTED')
  assert.equal((await readdir(directory)).length, 1000)
  assert.equal(await readFile(path.join(directory, 'neutral-999.jpg'), 'utf8'), 'neutral 999')
}))

test('Oriented dimensions and the inclusive panorama ratio boundaries remain unchanged', () => {
  for (const orientation of [1, 2, 3, 4, undefined]) assert.deepEqual(orientedImageDimensions({ width: 100, height: 50, orientation }), { width: 100, height: 50 })
  for (const orientation of [5, 6, 7, 8]) assert.deepEqual(orientedImageDimensions({ width: 50, height: 100, orientation }), { width: 100, height: 50 })
  assert.equal(orientedImageDimensions({ width: 100 }), undefined)
  assert.equal(isLikelyEquirectangularPanorama(undefined), false)
  for (const width of [190, 200, 210]) assert.equal(isLikelyEquirectangularPanorama({ width, height: 100 }), true)
  for (const width of [189, 211, 100]) assert.equal(isLikelyEquirectangularPanorama({ width, height: 100 }), false)
})

test('Invalid or excessive declared lengths reject before consuming content or creating files', async () => fixture(async (directory) => {
  for (const contentLength of [undefined, 0, -1, 'not a length', Infinity]) {
    let reads = 0
    const request = requestOf((function* () { reads += 1; yield Buffer.from('neutral') })(), contentLength)
    await rejectsCode(writeUpload(request, path.join(directory, 'neutral.jpg'), 'photo'), 'E_MEDIA_UPLOAD_EMPTY')
    assert.equal(reads, 0)
    request.destroy()
  }
  let reads = 0
  const request = requestOf((function* () { reads += 1; yield Buffer.from('neutral') })(), MAX_UPLOAD_BYTES + 1)
  await rejectsCode(writeUpload(request, path.join(directory, 'neutral.jpg'), 'photo'), 'E_MEDIA_UPLOAD_TOO_LARGE', { limitMiB: 250, limitBytes: MAX_UPLOAD_BYTES })
  assert.equal(reads, 0)
  request.destroy()
  assert.deepEqual(await readdir(directory), [])
}))

test('Actual streaming overflow rejects despite an understated length and removes its temporary file', async () => fixture(async (directory) => {
  // Reuse 8 MiB of neutral bytes rather than retaining an entire oversized file in memory.
  const chunk = Buffer.alloc(8 * 1024 * 1024)
  const request = requestOf((function* () { for (let index = 0; index < 32; index += 1) yield chunk })(), 1)
  await rejectsCode(writeUpload(request, path.join(directory, 'neutral.jpg'), 'photo'), 'E_MEDIA_UPLOAD_TOO_LARGE', { limitMiB: 250, limitBytes: MAX_UPLOAD_BYTES })
  assert.equal(request.destroyed, true)
  assert.deepEqual(await readdir(directory), [])
}))

test('Empty streams and undecodable images leave no destination and retain raw sharp diagnostics', async () => fixture(async (directory) => {
  const destination = path.join(directory, 'neutral.jpg')
  await rejectsCode(writeUpload(requestOf([], 1), destination, 'photo'), 'E_MEDIA_UPLOAD_EMPTY')
  const source = Buffer.from('Neutral artificial invalid image bytes')
  const diagnosticInput = path.join(directory, 'neutral-invalid-input.bin')
  await writeFile(diagnosticInput, source)
  let diagnostic
  try { await sharp(diagnosticInput).metadata() } catch (error) { diagnostic = error.message }
  await rm(diagnosticInput)
  assert.ok(diagnostic)
  await assert.rejects(writeUpload(requestOf([source], source.length), destination, 'photo'), (error) => {
    assert.ok(error instanceof V2WriteError)
    assert.equal(error.code, 'E_MEDIA_IMAGE_INVALID')
    assert.equal(error.details, diagnostic)
    return true
  })
  assert.deepEqual(await readdir(directory), [])
}))

test('Real EXIF orientation controls panorama validation without changing delivered source bytes or raw metadata', async () => fixture(async (directory) => {
  const source = await image(50, 100, 6)
  const destination = path.join(directory, 'nested', 'neutral.jpg')
  const metadata = await writeUpload(requestOf([source], source.length), destination, 'panorama360')
  assert.equal(metadata.width, 50)
  assert.equal(metadata.height, 100)
  assert.equal(metadata.orientation, 6)
  assert.deepEqual(await readFile(destination), source)
  const invalid = await image(100, 50, 6)
  await rejectsCode(writeUpload(requestOf([invalid], invalid.length), path.join(directory, 'invalid.jpg'), 'panorama360'), 'E_MEDIA_PANORAMA_RATIO', { width: 50, height: 100 })
  assert.deepEqual(await readdir(directory), ['nested'])
  const aerial = path.join(directory, 'aerial.jpg')
  await writeUpload(requestOf([invalid], invalid.length), aerial, 'aerialPhoto')
  assert.deepEqual(await readFile(aerial), invalid)
}))

test('A destination created after selection remains untouched when the exclusive write fails', async () => fixture(async (directory) => {
  const destination = await reserveDestination(directory, 'neutral.jpg')
  const original = Buffer.from('Neutral pre-existing source')
  await writeFile(destination, original)
  const source = await image(100, 50)
  await assert.rejects(writeUpload(requestOf([source], source.length), destination, 'photo'), (error) => error.code === 'EEXIST')
  assert.deepEqual(await readFile(destination), original)
  assert.deepEqual(await readdir(directory), ['neutral.jpg'])
}))

test('Transport errors remain unwrapped while upload temporary files are removed', async () => fixture(async (directory) => {
  const source = await image(100, 50)
  const interrupted = new Error('Neutral stream interrupted')
  const request = requestOf((async function* () { yield source.subarray(0, 20); throw interrupted })(), source.length)
  await assert.rejects(writeUpload(request, path.join(directory, 'neutral.jpg'), 'photo'), (error) => error === interrupted)
  assert.deepEqual(await readdir(directory), [])
}))
