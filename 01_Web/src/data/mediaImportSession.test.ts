import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalEditorError } from '../i18n/editorErrors.ts'
import { createMediaImportSession, getMediaImportSession, MediaImportSessionGuardError } from './mediaImportSession.ts'

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const editorError = (code: string, params?: Record<string, unknown>) => new LocalEditorError({
  code, params, error: 'original server error', details: 'original diagnostics\r\n',
})
const readySession = async () => {
  const session = createMediaImportSession<string>()
  await session.upload(['photo'], async () => ({ sourcePath: 'Country/City/photos/photo.jpg' }))
  return session
}

test('failed second upload retains confirmed first path and never automatically imports', async () => {
  const session = createMediaImportSession<string>()
  const error = editorError('E_MEDIA_IMAGE_INVALID')
  const calls: string[] = []
  const snapshots: ReturnType<typeof session.getSnapshot>[] = []
  session.subscribe(() => snapshots.push(session.getSnapshot()))
  await assert.rejects(session.upload(['first', 'second', 'third'], async (file) => {
    calls.push(file)
    if (file === 'second') throw error
    return { sourcePath: `photos/${file}.jpg` }
  }), (failure) => failure === error)
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(session.getSnapshot(), { phase: 'pending', sourcePaths: ['photos/first.jpg'], selectedCount: 3, error })
  assert.ok(snapshots.some((state) => state.phase === 'uploading' && state.sourcePaths[0] === 'photos/first.jpg'))
  await assert.rejects(session.upload(['first'], async () => { throw new Error('must not upload again') }), MediaImportSessionGuardError)
})

test('retrying explicit import reuses confirmed paths without invoking uploader, then clears state', async () => {
  const session = createMediaImportSession<string>()
  let uploads = 0
  await session.upload(['a', 'b'], async (file) => { uploads += 1; return { sourcePath: `photos/${file}.jpg` } })
  const blocked = editorError('E_MEDIA_IMPORT_BLOCKED')
  const captured: string[][] = []
  await assert.rejects(session.importMedia(async (paths) => { captured.push([...paths]); throw blocked }), (error) => error === blocked)
  assert.equal(session.getSnapshot().phase, 'pending')
  assert.equal(session.getSnapshot().error, blocked)
  await session.importMedia(async (paths) => { captured.push([...paths]) })
  assert.deepEqual(captured, [['photos/a.jpg', 'photos/b.jpg'], ['photos/a.jpg', 'photos/b.jpg']])
  assert.equal(uploads, 2)
  assert.deepEqual(session.getSnapshot(), { phase: 'idle', sourcePaths: [], selectedCount: 0 })
})

test('synchronous upload/import guards reject overlaps without changing snapshots or error', async () => {
  const session = createMediaImportSession<string>()
  const first = deferred<{ sourcePath: string }>()
  let uploads = 0
  const uploading = session.upload(['a'], async () => { uploads += 1; return first.promise })
  const activeUpload = session.getSnapshot()
  assert.equal(activeUpload.phase, 'uploading')
  await assert.rejects(session.upload(['b'], async () => ({ sourcePath: 'b' })), MediaImportSessionGuardError)
  await assert.rejects(session.importMedia(async () => undefined), MediaImportSessionGuardError)
  assert.equal(session.getSnapshot(), activeUpload)
  first.resolve({ sourcePath: 'a' })
  await uploading
  const second = deferred<void>()
  let imports = 0
  const importing = session.importMedia(async () => { imports += 1; return second.promise })
  const activeImport = session.getSnapshot()
  assert.equal(activeImport.phase, 'importing')
  await assert.rejects(session.importMedia(async () => undefined), MediaImportSessionGuardError)
  await assert.rejects(session.upload(['b'], async () => ({ sourcePath: 'b' })), MediaImportSessionGuardError)
  assert.equal(session.getSnapshot(), activeImport)
  second.resolve(undefined)
  await importing
  assert.equal(uploads, 1)
  assert.equal(imports, 1)
})

test('only typed, explicitly nonwriting upload validation failures allow new upload', async () => {
  const safeCodes = [
    'E_MEDIA_NAME_INVALID', 'E_MEDIA_NAME_EXHAUSTED', 'E_MEDIA_UPLOAD_EMPTY', 'E_MEDIA_UPLOAD_TOO_LARGE',
    'E_MEDIA_IMAGE_INVALID', 'E_MEDIA_PANORAMA_RATIO', 'E_MEDIA_KIND_INVALID', 'E_MEDIA_LOCATION_NOT_FOUND',
    'E_MEDIA_EXTENSION', 'E_MEDIA_DRONE_DATE', 'E_MEDIA_COORDINATES_RANGE', 'E_MEDIA_FOLDER_CONFLICT',
    'E_COORDINATES_PAIR', 'E_EDITOR_WRITE_FORBIDDEN', 'E_LEGACY_UNMIGRATED', 'E_INTEGRITY',
  ]
  for (const code of safeCodes) {
    const session = createMediaImportSession<string>()
    const error = editorError(code)
    await assert.rejects(session.upload(['a'], async () => { throw error }), (failure) => failure === error)
    assert.equal(session.getSnapshot().phase, 'idle', code)
    assert.equal(session.getSnapshot().error, error)
    await session.upload(['corrected'], async () => ({ sourcePath: 'photos/corrected.jpg' }))
    assert.equal(session.getSnapshot().phase, 'pending')
    assert.equal(session.getSnapshot().error, undefined)
  }
})

test('unknown upload outcomes lock the session, including malformed success and original transport errors', async () => {
  for (const error of [
    new TypeError('Failed to fetch'), new DOMException('Aborted', 'AbortError'),
    editorError('E_EDITOR_RESPONSE_INVALID'), editorError('E_UNEXPECTED'), editorError('E_MEDIA_UPLOAD_REJECTED'),
    editorError('E_FUTURE'), Object.assign(new Error('system error'), { code: 'E_MEDIA_IMAGE_INVALID' }),
    { code: 'E_MEDIA_IMAGE_INVALID' },
  ]) {
    const session = createMediaImportSession<string>()
    await assert.rejects(session.upload(['a'], async () => { throw error }), (failure) => failure === error)
    const locked = session.getSnapshot()
    assert.equal(locked.phase, 'uncertain')
    assert.equal(locked.error, error)
    await assert.rejects(session.upload(['a'], async () => ({ sourcePath: 'a' })), MediaImportSessionGuardError)
    await assert.rejects(session.importMedia(async () => undefined), MediaImportSessionGuardError)
    assert.equal(session.getSnapshot(), locked)
  }
  const malformed = createMediaImportSession<string>()
  await assert.rejects(malformed.upload(['a'], async () => ({ sourcePath: '' })), (error) => error instanceof LocalEditorError && error.code === 'E_MEDIA_UPLOAD_RESULT_UNKNOWN')
  assert.equal(malformed.getSnapshot().phase, 'uncertain')
})

test('unknown failure after a confirmed upload retains earlier paths but prevents import', async () => {
  const session = createMediaImportSession<string>()
  const error = new TypeError('network response lost')
  await assert.rejects(session.upload(['a', 'b'], async (file) => {
    if (file === 'b') throw error
    return { sourcePath: 'photos/a.jpg' }
  }), (failure) => failure === error)
  assert.deepEqual(session.getSnapshot().sourcePaths, ['photos/a.jpg'])
  assert.equal(session.getSnapshot().phase, 'uncertain')
  await assert.rejects(session.importMedia(async () => undefined), MediaImportSessionGuardError)
})

test('known import refusals retain paths for retry; partial or unknown results lock instead', async () => {
  const safeErrors = [
    editorError('E_MEDIA_IMPORT_FAILED', { stage: 'apply', reason: 'raw failure' }),
    editorError('E_MEDIA_IMPORT_BLOCKED'), editorError('E_MEDIA_IMPORT_PATH_INVALID'), editorError('E_REQUIRED'),
    editorError('E_LEGACY_UNMIGRATED'), editorError('E_EDITOR_WRITE_FORBIDDEN'), editorError('E_INTEGRITY'),
    editorError('E_WRITE_FAILED', { written: [] }),
  ]
  const unsafeErrors = [
    editorError('E_PARTIAL_WRITE'), editorError('E_EDITOR_RESPONSE_INVALID'),
    editorError('E_WRITE_FAILED', { written: ['media'] }), editorError('E_WRITE_FAILED'),
    editorError('E_WRITE_FAILED', { written: null }), editorError('E_UNEXPECTED'), editorError('E_LOCAL_EDITOR_FAILED'),
    editorError('E_FUTURE'), editorError('E_MEDIA_UPLOAD_REJECTED'), new TypeError('Failed to fetch'),
    new DOMException('Aborted', 'AbortError'), { diagnostic: 'unknown error' },
  ]
  for (const [errors, phase] of [[safeErrors, 'pending'], [unsafeErrors, 'uncertain']] as const) {
    for (const error of errors) {
      const session = await readySession()
      await assert.rejects(session.importMedia(async () => { throw error }), (failure) => failure === error)
      assert.equal(session.getSnapshot().phase, phase)
      assert.equal(session.getSnapshot().error, error)
      assert.deepEqual(session.getSnapshot().sourcePaths, ['Country/City/photos/photo.jpg'])
    }
  }
})

test('snapshots remain immutable and stable, inputs are captured and importer receives an independent list', async () => {
  const session = createMediaImportSession<string>()
  const initial = session.getSnapshot()
  assert.equal(session.getSnapshot(), initial)
  const first = deferred<{ sourcePath: string }>()
  const selected = ['first', 'second']
  const calls: string[] = []
  const uploading = session.upload(selected, async (file) => {
    calls.push(file)
    return file === 'first' ? first.promise : { sourcePath: `photos/${file}.jpg` }
  })
  const early = session.getSnapshot()
  selected.push('late change')
  first.resolve({ sourcePath: ' photos/first.jpg ' })
  await uploading
  const pending = session.getSnapshot()
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(Object.isFrozen(pending), true)
  assert.equal(Object.isFrozen(pending.sourcePaths), true)
  assert.deepEqual(initial, { phase: 'idle', sourcePaths: [], selectedCount: 0 })
  assert.deepEqual(early, { phase: 'uploading', sourcePaths: [], selectedCount: 2 })
  const failed = editorError('E_MEDIA_IMPORT_FAILED')
  await assert.rejects(session.importMedia(async (paths) => { paths.splice(0); throw failed }), (error) => error === failed)
  assert.deepEqual(session.getSnapshot().sourcePaths, [' photos/first.jpg ', 'photos/second.jpg'])
  assert.deepEqual(pending.sourcePaths, [' photos/first.jpg ', 'photos/second.jpg'])
})

test('registry survives subscriber remounts and isolates city/media target keys', async () => {
  const target = JSON.stringify(['session-test-country', 'session-test-city', 'photos'])
  const otherTarget = JSON.stringify(['session-test-country', 'session-test-city', 'drone'])
  const session = getMediaImportSession(target)
  let notifications = 0
  const unsubscribe = session.subscribe(() => { notifications += 1 })
  await session.upload([{} as File], async () => ({ sourcePath: 'photos/confirmed.jpg' }))
  assert.ok(notifications > 0)
  unsubscribe()
  const remounted = getMediaImportSession(target)
  assert.equal(remounted, session)
  assert.equal(remounted.getSnapshot().phase, 'pending')
  assert.deepEqual(remounted.getSnapshot().sourcePaths, ['photos/confirmed.jpg'])
  assert.notEqual(getMediaImportSession(otherTarget), session)
  assert.equal(getMediaImportSession(otherTarget).getSnapshot().phase, 'idle')
  const oldNotifications = notifications
  await remounted.importMedia(async () => undefined)
  assert.equal(notifications, oldNotifications)
})
