/**
 * City 3D initial state (./city3dPreference.ts). A stored 'on' must never hide the globe when there is no Google key:
 * localStorage on 127.0.0.1:5173 is shared by the public, personal and preview profiles, and without a key neither
 * the tiles nor the toggle render.
 *
 * Run with npm test (Node type stripping; node:test only).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { city3DTilesPresence, resolveInitialCity3DEnabled } from './city3dPreference.ts'

test('Without a Google key City 3D starts off and the stored preference is not even read', () => {
  let reads = 0
  const storedOn = () => { reads += 1; return true }
  assert.equal(resolveInitialCity3DEnabled(false, storedOn), false)
  assert.equal(resolveInitialCity3DEnabled(false, () => false), false)
  assert.equal(reads, 0)
})

test('With a Google key the stored preference decides', () => {
  assert.equal(resolveInitialCity3DEnabled(true, () => true), true)
  assert.equal(resolveInitialCity3DEnabled(true, () => false), false)
})

test('Without window (Node) the default reader reports off, so a configured key still starts off', () => {
  assert.equal(resolveInitialCity3DEnabled(true), false)
})

test('App wiring: initial state, the globe flag and tile failures all go through the key gate', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  assert.match(app, /useState\(\(\) => resolveInitialCity3DEnabled\(googleConfigured\)\)/)
  assert.match(app, /const city3DActive = googleConfigured && city3DEnabled/)
  assert.match(app, /showCity3DTiles=\{city3DActive\}/)
  assert.match(app, /onCity3DUnavailable=\{disableCity3D\}/)
  assert.doesNotMatch(app, /useState\(getInitialCity3DEnabled\)/)
  const tiles = readFileSync(new URL('./GooglePhotorealisticTiles.tsx', import.meta.url), 'utf8')
  assert.match(tiles, /onUnavailable\?\.\(\)/)
})

test('Google 3D tiles stay mounted across pages while City 3D is on with a key; only their visibility follows the Map page', () => {
  assert.deepEqual(city3DTilesPresence(true, true, true), { mounted: true, show: true })
  assert.deepEqual(city3DTilesPresence(true, true, false), { mounted: true, show: false })
  for (const onMapPage of [true, false]) {
    assert.deepEqual(city3DTilesPresence(false, true, onMapPage), { mounted: false, show: false }, 'City 3D off unmounts')
    assert.deepEqual(city3DTilesPresence(true, false, onMapPage), { mounted: false, show: false }, 'no key, no tiles')
    assert.deepEqual(city3DTilesPresence(false, false, onMapPage), { mounted: false, show: false })
  }
})

test('Globe wiring: a page change reaches the tileset only through show, keeping the explicit option props', () => {
  const globe = readFileSync(new URL('../components/CesiumAtlasGlobe.tsx', import.meta.url), 'utf8')
  assert.match(globe, /<GooglePhotorealisticTiles enabled=\{showCity3DTiles\} visible=\{showMapContent\}/)
  const tiles = readFileSync(new URL('./GooglePhotorealisticTiles.tsx', import.meta.url), 'utf8')
  assert.match(tiles, /city3DTilesPresence\(enabled, googleConfigured, visible\)/)
  assert.match(tiles, /if \(!mounted\) return null/)
  assert.match(tiles, /show=\{show\}/)
  for (const prop of ['cacheBytes={CACHE_BYTES}', 'maximumCacheOverflowBytes={MAXIMUM_CACHE_OVERFLOW_BYTES}', 'enableCollision']) {
    assert.ok(tiles.includes(prop), prop)
  }
})
