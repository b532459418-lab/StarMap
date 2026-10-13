/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { activateOnKey } from './keyboardActivation.ts'

const press = (key: string) => {
  const event = { key, prevented: false, preventDefault() { this.prevented = true } }
  let activations = 0
  const handled = activateOnKey(event, () => { activations += 1 })
  return { handled, activations, prevented: event.prevented }
}

test('Enter and Space run the click handler once and are consumed, so Space never scrolls the page', () => {
  assert.deepEqual(press('Enter'), { handled: true, activations: 1, prevented: true })
  assert.deepEqual(press(' '), { handled: true, activations: 1, prevented: true })
})

test('Other keys keep their default behaviour and do not activate', () => {
  for (const key of ['Tab', 'Escape', 'ArrowDown', 'a', 'Spacebar']) {
    assert.deepEqual(press(key), { handled: false, activations: 0, prevented: false }, key)
  }
})

test('Every role="button" element in InfoCard and DroneMediaCard answers the keyboard with its click handler', () => {
  for (const file of ['InfoCard', 'DroneMediaCard']) {
    const source = readFileSync(new URL(`./${file}.tsx`, import.meta.url), 'utf8')
    const elements = source.split('role="button"').slice(1).map((rest) => rest.slice(0, rest.search(/\n\s*>/)))
    assert.ok(elements.length > 0, file)
    for (const element of elements) {
      const click = element.match(/onClick=\{(?:\(event\) => \{ event\.stopPropagation\(\); )?(\w+)/)?.[1]
      assert.ok(click, `${file}: role="button" without a named click handler`)
      assert.match(element, new RegExp(`activateOnKey\\(event, ${click}\\)`), `${file}: ${click} must also run from the keyboard`)
    }
  }
})
