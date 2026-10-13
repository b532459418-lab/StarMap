/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dialogTabWrapTarget } from './dialogFocus.ts'

const stops = [{}, {}, {}]
const at = (position: number, radioGroup?: string) => ({ position, radioGroup })

test('Tab on the last stop and Shift+Tab on the first stop or the dialog itself wrap around (MediaRecoveryCenter rule)', () => {
  assert.equal(dialogTabWrapTarget(stops, at(2), false), 0)
  assert.equal(dialogTabWrapTarget(stops, at(0), true), 2)
  // The dialog element (focused on open) sits before every stop.
  assert.equal(dialogTabWrapTarget(stops, at(-0.5), true), 2)
  assert.equal(dialogTabWrapTarget(stops, at(-0.5), false), undefined)
})

test('Inside the dialog the browser keeps its own order', () => {
  assert.equal(dialogTabWrapTarget(stops, at(1), false), undefined)
  assert.equal(dialogTabWrapTarget(stops, at(1), true), undefined)
  assert.equal(dialogTabWrapTarget(stops, at(0), false), undefined)
  assert.equal(dialogTabWrapTarget(stops, at(2), true), undefined)
})

test('A dialog without any stop swallows Tab', () => {
  assert.equal(dialogTabWrapTarget([], at(-0.5), false), null)
  assert.equal(dialogTabWrapTarget([], at(-0.5), true), null)
})

test('A focused element that is not a stop wraps by its document position', () => {
  assert.equal(dialogTabWrapTarget(stops, at(2.5), false), 0)
  assert.equal(dialogTabWrapTarget(stops, at(1.5), false), undefined)
  assert.equal(dialogTabWrapTarget(stops, at(0.5), true), undefined)
})

test('Tab leaves a radio group as a whole, so a group at either end wraps from any of its radios', () => {
  const choice = [{}, { radioGroup: 'journey' }, { radioGroup: 'journey' }]
  assert.equal(dialogTabWrapTarget(choice, at(1, 'journey'), false), 0)
  assert.equal(dialogTabWrapTarget(choice, at(2, 'journey'), false), 0)
  assert.equal(dialogTabWrapTarget(choice, at(1, 'journey'), true), undefined)
  const leading = [{ radioGroup: 'kind' }, { radioGroup: 'kind' }, {}]
  assert.equal(dialogTabWrapTarget(leading, at(1, 'kind'), true), 2)
  assert.equal(dialogTabWrapTarget(leading, at(1, 'kind'), false), undefined)
})

test('Every aria-modal dialog uses the shared focus hook', () => {
  for (const file of ['WantToGoAddDialog', 'ConvertToTravelDialog', 'CityPhotoGalleryModal', 'DronePanoramaModal', 'MediaRecoveryCenter']) {
    const source = readFileSync(new URL(`./${file}.tsx`, import.meta.url), 'utf8')
    assert.match(source, /aria-modal="true"/, file)
    assert.match(source, /useDialogFocus</, file)
    assert.match(source, /ref=\{dialogRef\}/, file)
    assert.match(source, /tabIndex=\{-1\}/, file)
    assert.match(source, /trapFocus/, file)
  }
})
