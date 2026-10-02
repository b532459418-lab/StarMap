import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalEditorError } from '../i18n/editorErrors.ts'
import { createLocalEditorCoordination } from './localEditorCoordination.ts'

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const busy = (error: unknown) => error instanceof LocalEditorError && error.code === 'E_MEDIA_IMPORT_BUSY'

test('ordinary writes may overlap but prevent media acquisition and reload until every lease ends', async () => {
  const coordination = createLocalEditorCoordination()
  const first = deferred<void>()
  const second = deferred<void>()
  let requests = 0
  const a = coordination.withLocalEditorWrite(async () => { requests += 1; await first.promise })
  const b = coordination.withLocalEditorWrite(async () => { requests += 1; await second.promise })
  assert.equal(requests, 2)
  assert.deepEqual(coordination.getSnapshot(), { writes: 2 })
  const snapshot = coordination.getSnapshot()
  assert.throws(() => coordination.beginMedia('city-a-photos'), busy)
  assert.throws(coordination.assertReloadAllowed, busy)
  assert.equal(coordination.getSnapshot(), snapshot)
  first.resolve(undefined)
  await a
  assert.deepEqual(coordination.getSnapshot(), { writes: 1 })
  assert.throws(() => coordination.beginMedia('city-a-photos'), busy)
  second.resolve(undefined)
  await b
  assert.deepEqual(coordination.getSnapshot(), { writes: 0 })
  assert.doesNotThrow(coordination.assertReloadAllowed)
})

test('media owner rejects foreign writes and capabilities before request/reload effects, while valid permit bypasses leases', async () => {
  const coordination = createLocalEditorCoordination()
  const permit = coordination.beginMedia('city-a-photos')
  const foreign = createLocalEditorCoordination().beginMedia('city-b-drone')
  const snapshot = coordination.getSnapshot()
  let requests = 0
  let reloads = 0
  for (const candidate of [undefined, foreign]) {
    await assert.rejects(coordination.withLocalEditorWrite(async () => { requests += 1 }, candidate), busy)
  }
  assert.throws(() => coordination.beginMedia('city-b-drone'), busy)
  assert.throws(() => coordination.releaseMedia(foreign), busy)
  assert.throws(() => { coordination.assertReloadAllowed(); reloads += 1 }, busy)
  assert.equal(requests, 0)
  assert.equal(reloads, 0)
  assert.equal(coordination.getSnapshot(), snapshot)
  assert.equal(await coordination.withLocalEditorWrite(async () => {
    requests += 1
    assert.equal(coordination.getSnapshot(), snapshot)
    return 'owner result'
  }, permit), 'owner result')
  assert.equal(requests, 1)
  assert.equal(coordination.getSnapshot().writes, 0)
  coordination.releaseMedia(permit)
  assert.deepEqual(coordination.getSnapshot(), { writes: 0 })
  assert.doesNotThrow(coordination.assertReloadAllowed)
})

test('ordinary failures preserve the thrown object and release leases including synchronous failures', async () => {
  const coordination = createLocalEditorCoordination()
  for (const error of [new Error('parse failed'), new TypeError('network failure'), { code: 'unknown rejection' }]) {
    await assert.rejects(coordination.withLocalEditorWrite(async () => { throw error }), (failure) => failure === error)
    assert.deepEqual(coordination.getSnapshot(), { writes: 0 })
  }
  const synchronous = new Error('synchronous failure')
  await assert.rejects(coordination.withLocalEditorWrite(() => { throw synchronous }), (failure) => failure === synchronous)
  const permit = coordination.beginMedia('media-after-failure')
  coordination.releaseMedia(permit)
})

test('owner operation failures retain the media lease, and released permits cannot authorize a new owner', async () => {
  const coordination = createLocalEditorCoordination()
  const first = coordination.beginMedia('city-a-photos')
  const error = new Error('unknown write result')
  await assert.rejects(coordination.withLocalEditorWrite(async () => { throw error }, first), (failure) => failure === error)
  assert.deepEqual(coordination.getSnapshot(), { target: 'city-a-photos', writes: 0 })
  await assert.rejects(coordination.withLocalEditorWrite(async () => undefined), busy)
  coordination.releaseMedia(first)
  let requests = 0
  const released = coordination.getSnapshot()
  await assert.rejects(coordination.withLocalEditorWrite(async () => { requests += 1 }, first), busy)
  assert.equal(requests, 0)
  assert.equal(coordination.getSnapshot(), released)
  const second = coordination.beginMedia('city-b-drone')
  await assert.rejects(coordination.withLocalEditorWrite(async () => { requests += 1 }, first), busy)
  assert.equal(requests, 0)
  assert.throws(() => coordination.releaseMedia(first), busy)
  assert.deepEqual(coordination.getSnapshot(), { target: 'city-b-drone', writes: 0 })
  coordination.releaseMedia(second)
})

test('coordination snapshots are frozen, stable between changes and delivered to subscribers', async () => {
  const coordination = createLocalEditorCoordination()
  const initial = coordination.getSnapshot()
  const snapshots: ReturnType<typeof coordination.getSnapshot>[] = []
  const unsubscribe = coordination.subscribe(() => snapshots.push(coordination.getSnapshot()))
  assert.equal(coordination.getSnapshot(), initial)
  await coordination.withLocalEditorWrite(async () => undefined)
  const permit = coordination.beginMedia('city-a-photos')
  coordination.releaseMedia(permit)
  assert.deepEqual(snapshots, [{ writes: 1 }, { writes: 0 }, { target: 'city-a-photos', writes: 0 }, { writes: 0 }])
  assert.ok(snapshots.every(Object.isFrozen))
  assert.deepEqual(initial, { writes: 0 })
  unsubscribe()
  await coordination.withLocalEditorWrite(async () => undefined)
  assert.equal(snapshots.length, 4)
})
