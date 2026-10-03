/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAYER_TIME_FILTERS_STORAGE_KEY, readLayerTimeFilters, rememberLayerTimeFilters } from './layerTimeFilters.ts'
import type { LayerTimeFilters } from '../worldgraph/timeQuery.ts'

function storage(initial: string | null = null) {
  let value = initial
  const keys: string[] = []
  return { getItem: (key: string) => { keys.push(key); return value },
    setItem: (key: string, text: string) => { keys.push(key); value = text },
    value: () => value, keys }
}

test('Missing preferences return fresh all-time conditions for each layer', () => {
  const store = storage()
  const first = readLayerTimeFilters(store)
  assert.deepEqual(first, { filters: { travel: { includeUncertain: false }, want_to_go: { includeUncertain: false } }, warning: false, restored: false })
  assert.notEqual(first.filters.travel, readLayerTimeFilters(store).filters.travel)
  assert.notEqual(first.filters.travel, first.filters.want_to_go)
  assert.deepEqual(store.keys, [LAYER_TIME_FILTERS_STORAGE_KEY, LAYER_TIME_FILTERS_STORAGE_KEY])
})

test('Two independent conditions and open ranges survive a round trip', () => {
  const filters = Object.freeze({ travel: Object.freeze({ from: '2024-02-29', includeUncertain: true }),
    want_to_go: Object.freeze({ to: '2030-12-31', includeUncertain: false }) })
  const store = storage()
  assert.equal(rememberLayerTimeFilters(filters, store), true)
  assert.deepEqual(readLayerTimeFilters(store), { filters, warning: false, restored: true })
})

test('Invalid saved layer falls back independently, retaining the other valid layer', () => {
  const store = storage(JSON.stringify({ version: 1, filters: {
    travel: { from: '2025-02-29', includeUncertain: true }, want_to_go: { to: '2026-01-01', includeUncertain: true },
  } }))
  assert.deepEqual(readLayerTimeFilters(store), { filters: { travel: { includeUncertain: false },
    want_to_go: { to: '2026-01-01', includeUncertain: true } }, warning: true, restored: true })
})

test('Broken JSON, unsupported versions and malformed envelopes never prevent startup', () => {
  for (const value of ['{broken', 'null', '[]', '{}', '{"version":2,"filters":{}}', '{"version":1,"filters":[]}', '{"version":1,"filters":null}']) {
    assert.equal(readLayerTimeFilters(storage(value)).warning, true, value)
    assert.equal(readLayerTimeFilters(storage(value)).filters.travel?.from, undefined)
  }
})

test('Restored conditions validate calendar bounds, order and boolean types', () => {
  for (const travel of [null, [], { from: null }, { to: 2025 }, { from: '2025-03-01', to: '2025-02-01' },
    { includeUncertain: 'true' }, { from: '0000-01-01' }, { to: '2024-04-31' }]) {
    const result = readLayerTimeFilters(storage(JSON.stringify({ version: 1, filters: { travel } })))
    assert.equal(result.warning, true)
    assert.deepEqual(result.filters.travel, { includeUncertain: false })
  }
})

test('Unknown layers and unrelated properties are ignored, not revived or persisted', () => {
  const store = storage(JSON.stringify({ version: 1, filters: { unknown: { from: 'bad' }, travel: { from: '', notes: 'private' } } }))
  const restored = readLayerTimeFilters(store)
  assert.equal(restored.warning, false)
  assert.deepEqual(Object.keys(restored.filters), ['travel', 'want_to_go'])
  assert.equal(rememberLayerTimeFilters({ ...restored.filters, unknown: { from: 'bad' },
    travel: { from: '2025-01-01', includeUncertain: false, note: 'private', recordId: 'secret' } } as LayerTimeFilters, store), true)
  assert.equal(store.value()?.includes('private'), false)
  assert.equal(store.value()?.includes('secret'), false)
  assert.equal(store.value()?.includes('unknown'), false)
})

test('Rejecting an invalid effective condition preserves previously saved preferences', () => {
  const store = storage('previous')
  assert.equal(rememberLayerTimeFilters({ travel: { from: '2025-02-29', includeUncertain: false } }, store), false)
  assert.equal(store.value(), 'previous')
  assert.equal(rememberLayerTimeFilters({ travel: null } as unknown as LayerTimeFilters, store), false)
})

test('Clearing writes all-time preferences and removes the previous range on reload', () => {
  const store = storage()
  rememberLayerTimeFilters({ travel: { from: '2025-01-01', to: '2025-12-31', includeUncertain: true } }, store)
  assert.equal(rememberLayerTimeFilters({}, store), true)
  assert.deepEqual(readLayerTimeFilters(store).filters, { travel: { includeUncertain: false }, want_to_go: { includeUncertain: false } })
})

test('Blocked and absent stores report a recoverable warning or false write result', () => {
  const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
  assert.equal(readLayerTimeFilters(blocked).warning, true)
  assert.equal(rememberLayerTimeFilters({}, blocked), false)
  assert.equal(readLayerTimeFilters(null).warning, true)
  assert.equal(rememberLayerTimeFilters({}, null), false)
})

test('Server-side import and default reading have no browser dependency', () => {
  assert.equal(readLayerTimeFilters().warning, false)
  assert.equal(rememberLayerTimeFilters({}), false)
})

test('A restored hint needs a valid saved condition, not an empty or wholly rejected save', () => {
  for (const filters of [{}, { travel: { includeUncertain: false } }, { travel: { from: 'invalid' } }]) {
    assert.equal(readLayerTimeFilters(storage(JSON.stringify({ version: 1, filters }))).restored, false)
  }
  assert.equal(readLayerTimeFilters(storage(JSON.stringify({ version: 1,
    filters: { want_to_go: { includeUncertain: true } } }))).restored, true)
})

test('A browser localStorage getter refusal is contained, not just getItem failures', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw new Error('SecurityError') },
  } })
  try {
    assert.equal(readLayerTimeFilters().warning, true)
    assert.equal(rememberLayerTimeFilters({}), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
