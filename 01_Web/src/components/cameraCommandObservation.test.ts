import test from 'node:test'
import assert from 'node:assert/strict'
import { createCameraCommandObserver } from './cameraCommandObservation.ts'

test('stationary reads do not complete a flight; only its actual callback does', () => {
  let time = 100
  const observer = createCameraCommandObserver(() => time)
  const flight = observer.issue({ commandNumber: 1, source: 'city', selectedCityId: 'city_test' })
  flight.complete()
  assert.equal(observer.read()?.status, 'issued')
  flight.start()
  for (let i = 0; i < 5; i++) assert.equal(observer.read()?.status, 'flying')
  time = 200
  flight.complete()
  assert.deepEqual(observer.read(), {
    commandNumber: 1, source: 'city', selectedCityId: 'city_test', status: 'completed', issuedAt: 100, changedAt: 200,
  })
  flight.cancel()
  flight.start()
  assert.equal(observer.read()?.status, 'completed')
})

test('superseded command callbacks cannot complete or cancel the next flight', () => {
  const observer = createCameraCommandObserver()
  const old = observer.issue({ commandNumber: 1, source: 'country' })
  old.start()
  const next = observer.issue({ commandNumber: 2, source: 'city' })
  next.start()
  old.cancel()
  old.complete()
  old.fail()
  assert.equal(observer.read()?.commandNumber, 2)
  assert.equal(observer.read()?.status, 'flying')
  next.cancel()
  next.complete()
  assert.equal(observer.read()?.status, 'cancelled')
})

test('read returns a detached snapshot and unobserved commands remain issued', () => {
  const observer = createCameraCommandObserver()
  observer.issue({ commandNumber: 3, source: 'orientation-reset' })
  const snapshot = observer.read()!
  Object.assign(snapshot, { source: 'mutated', status: 'completed' })
  assert.equal(observer.read()?.source, 'orientation-reset')
  assert.equal(observer.read()?.status, 'issued')
})

test('clear invalidates disposed viewer callbacks even when command numbers repeat', () => {
  const observer = createCameraCommandObserver()
  const old = observer.issue({ commandNumber: 1, source: 'city' })
  old.start()
  observer.clear()
  old.complete()
  assert.equal(observer.read(), undefined)
  const next = observer.issue({ commandNumber: 1, source: 'city' })
  next.start()
  old.cancel()
  old.complete()
  assert.equal(observer.read()?.status, 'flying')
  next.fail()
  next.complete()
  assert.equal(observer.read()?.status, 'failed')
})

test('API reinstall retains a live viewer flight; replacement isolates previous viewer callbacks', () => {
  const observer = createCameraCommandObserver()
  const viewer = {}
  observer.bind(viewer)
  const flight = observer.issue({ commandNumber: 1, source: 'city' })
  flight.start()
  observer.bind(viewer)
  assert.equal(observer.read(viewer)?.status, 'flying')
  flight.complete()
  assert.equal(observer.read(viewer)?.status, 'completed')
  const nextViewer = {}
  observer.bind(nextViewer)
  assert.equal(observer.read(viewer), undefined)
  assert.equal(observer.read(nextViewer), undefined)
  const next = observer.issue({ commandNumber: 1, source: 'city' })
  next.start()
  flight.cancel()
  flight.complete()
  assert.equal(observer.read(viewer), undefined)
  assert.equal(observer.read(nextViewer)?.status, 'flying')
})
