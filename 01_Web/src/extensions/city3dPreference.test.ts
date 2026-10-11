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
import { resolveInitialCity3DEnabled } from './city3dPreference.ts'

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
