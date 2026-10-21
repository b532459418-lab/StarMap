/// <reference types="node" />
/** The drone labels without a file name (3C-5B spec §2.6), and unchanged with one. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { droneMarkerName, droneMediaMetaLine } from './droneMediaLabels.ts'

const withFile = { fileName: 'DJI_0042.JPG', resolution: '4000x3000', titleEn: 'Harbor at dawn' }
const withoutFile = { fileName: undefined, resolution: '4000x3000', titleEn: 'Harbor at dawn' }

test('with a file name both labels are what they were: "<file> · <resolution>" and "<English title> <file>"', () => {
  assert.equal(droneMediaMetaLine(withFile, '黎明的港口', '无人机航拍照片'), 'DJI_0042.JPG · 4000x3000')
  assert.equal(droneMarkerName(withFile), 'Harbor at dawn DJI_0042.JPG')
})

test('without a file name the viewer shows the title, or else the type name, with the resolution; never undefined or a lone "· resolution"', () => {
  for (const fileName of [undefined, '']) {
    const item = { ...withoutFile, fileName }
    assert.equal(droneMediaMetaLine(item, '黎明的港口', '无人机航拍照片'), '黎明的港口 · 4000x3000')
    assert.equal(droneMediaMetaLine(item, '', 'Drone 360° Panorama'), 'Drone 360° Panorama · 4000x3000')
    assert.equal(droneMediaMetaLine({ ...item, resolution: '' }, '', 'Drone Aerial Photo'), 'Drone Aerial Photo')
    for (const text of [droneMediaMetaLine(item, '', 'Drone Aerial Photo'), droneMarkerName(item)]) {
      assert.ok(!text.includes('undefined') && !text.startsWith(' ·') && !text.startsWith('·'), text)
    }
  }
})

test('without a file name the globe marker is named by the title alone', () => {
  assert.equal(droneMarkerName(withoutFile), 'Harbor at dawn')
  assert.equal(droneMarkerName({ ...withoutFile, fileName: '' }), 'Harbor at dawn')
})

test('the viewer and the globe use these labels', () => {
  const modal = readFileSync(new URL('./DronePanoramaModal.tsx', import.meta.url), 'utf8')
  assert.match(modal, /droneMediaMetaLine\(item, title, t\(item\.type === 'panorama360' \? 'dronePanorama' : 'droneAerialPhoto'\)\)/)
  assert.doesNotMatch(modal, /\{item\.fileName\} · \{item\.resolution\}/)
  const globe = readFileSync(new URL('./CesiumAtlasGlobe.tsx', import.meta.url), 'utf8')
  assert.match(globe, /name=\{droneMarkerName\(item\)\}/)
  assert.doesNotMatch(globe, /\$\{item\.titleEn\} \$\{item\.fileName\}/)
})
