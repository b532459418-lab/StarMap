/**
 * 收藏页余量 C: a page switch must not restyle the whole page.
 *
 * App.tsx changes `data-page` on .atlas-experience and .atlas-overlay-frame at every page switch. Chrome builds its style
 * invalidation per attribute name, from the subject (the rightmost compound selector) of every rule that uses the
 * attribute: a subject without a class, id or pseudo-element (`[data-page='map'] > *`, `[data-page='map'] p`) makes a
 * change of `data-page` invalidate every element, or every element of that tag, under the element that changed. One
 * such header rule made each switch restyle about 157 000 elements (~1 s in the frame after Collection opened, and
 * again back on the map). This test keeps every rule that uses `data-page` to subjects Chrome can narrow down.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** A selector list split at its top-level commas (not inside `:is()`, `:not()` …). */
function splitList(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < list.length; index++) {
    const character = list[index]
    if (character === '(') depth++
    else if (character === ')') depth--
    else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index))
      start = index + 1
    }
  }
  parts.push(list.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** Every selector of the style sheet (at-rule preludes left out). */
const selectors = [...css.matchAll(/([^{}@;]+)\{/g)].flatMap((match) => splitList(match[1]))

/** The subject of a selector without its attribute selectors and functional pseudo-classes: what Chrome can key on. */
function subjectFeatures(selector: string): string {
  // Combinators outside parentheses separate compounds; the subject is the last one.
  let depth = 0
  let start = 0
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index]
    if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth--
    else if (depth === 0 && /[\s>+~]/.test(character)) start = index + 1
  }
  return selector.slice(start).replace(/\[[^\]]*\]/g, '').replace(/:(is|where|not|has)\((?:[^()]|\([^()]*\))*\)/g, '')
}

test('the style sheet has rules that use data-page (the check below is not vacuous)', () => {
  assert.ok(selectors.filter((selector) => selector.includes('[data-page')).length >= 8)
})

test('every rule that uses data-page has a class, an id or a pseudo-element in its subject', () => {
  const broad = selectors.filter((selector) => selector.includes('[data-page') && !/[.#]|::/.test(subjectFeatures(selector)))
  assert.deepEqual(broad, [])
})

test('the check finds the rules that restyled the whole page', () => {
  const broad = (selector: string) => !/[.#]|::/.test(subjectFeatures(selector))
  assert.equal(broad(".theme-night .atlas-app-header[data-page='map'] > *"), true)
  assert.equal(broad(".atlas-app-header[data-page='map'] p"), true)
  assert.equal(broad(".atlas-app-header[data-page='map'] .atlas-tabs button"), true)
  assert.equal(broad(".atlas-experience:is([data-page='journey'], [data-page='collection']) .atlas-overlay-frame .atlas-left-panel"), false)
  assert.equal(broad(".atlas-experience:is([data-page='journey'], [data-page='about']) .atlas-overlay-frame::before"), false)
  assert.equal(broad(".cesium-lab-page .atlas-overlay-frame:not([data-page='map']) .atlas-mobile-panel-switch"), false)
})
