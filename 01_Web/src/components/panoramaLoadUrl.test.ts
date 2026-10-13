/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { panoramaLoadUrl } from './panoramaLoadUrl.ts'

test('The first panorama load uses the plain URL so the HTTP cache can answer it', () => {
  assert.equal(panoramaLoadUrl('/media/user/drone/pano.jpg', 0, 1700000000000), '/media/user/drone/pano.jpg')
  assert.equal(panoramaLoadUrl('/media/user/drone/pano.jpg?v=2', 0, 1700000000000), '/media/user/drone/pano.jpg?v=2')
})

test('Only a retry adds the cache-busting query, keeping an existing query', () => {
  assert.equal(panoramaLoadUrl('/media/user/drone/pano.jpg', 1, 1700000000000), '/media/user/drone/pano.jpg?starmapLoad=1700000000000-1')
  assert.equal(panoramaLoadUrl('/media/user/drone/pano.jpg?v=2', 4, 1700000000123), '/media/user/drone/pano.jpg?v=2&starmapLoad=1700000000123-4')
})

test('DronePanoramaModal builds every attempt through panoramaLoadUrl', () => {
  const modal = readFileSync(new URL('./DronePanoramaModal.tsx', import.meta.url), 'utf8')
  assert.match(modal, /image\.src = panoramaLoadUrl\(source, attempt, Date\.now\(\)\)/)
  assert.doesNotMatch(modal, /starmapLoad=/)
})
