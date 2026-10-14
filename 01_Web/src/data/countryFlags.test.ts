/**
 * Bundled country flags (./countryFlags.ts, batch 7, review S4). The Vite glob in ../components/countryFlagUrl.ts
 * cannot run under Node, so the tests build the same map from flag-icons' directory: every two-letter
 * `flags/4x3/<code>.svg`, keyed `./<code>.svg` as the glob's `base` option makes them.
 *
 * The next line must stay; see the header of src/worldgraph/adapters/travel.test.ts.
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import worldCountries from 'world-countries'

import { flagUrlFor, flagUrlsByCode } from './countryFlags.ts'

const FLAG_DIRECTORY = new URL('../../node_modules/flag-icons/flags/4x3/', import.meta.url)
/** What `import.meta.glob('/node_modules/flag-icons/flags/4x3/[a-z][a-z].svg', { base, … })` returns, with fake URLs. */
const globbedFlags = (): Record<string, string> => Object.fromEntries(readdirSync(FLAG_DIRECTORY)
  .filter((file) => /^[a-z][a-z]\.svg$/.test(file))
  .map((file) => [`./${file}`, `/assets/${file.replace('.svg', '')}-hash.svg`]))

/** Country codes from world-countries without a flag file; they keep the emoji / dot fallback. None today. */
const CODES_WITHOUT_FLAG: readonly string[] = []

test('the glob result becomes a two-letter code map; other names are ignored', () => {
  const urls = flagUrlsByCode({ './is.svg': '/assets/is-1.svg', './fo.svg': '/assets/fo-2.svg', './gb-eng.svg': '/x.svg', 'is.svg': '/y.svg', './IS.svg': '/z.svg' })
  assert.deepEqual([...urls], [['is', '/assets/is-1.svg'], ['fo', '/assets/fo-2.svg']])
})

test('flagUrlFor: letter case and spaces do not matter; no code, a malformed code or a code without a file gives undefined', () => {
  const urls = flagUrlsByCode({ './is.svg': '/assets/is-1.svg' })
  assert.equal(flagUrlFor(urls, 'is'), '/assets/is-1.svg')
  assert.equal(flagUrlFor(urls, ' IS '), '/assets/is-1.svg')
  for (const code of [undefined, '', 'i', 'isl', 'i5', 'fo']) assert.equal(flagUrlFor(urls, code), undefined, String(code))
})

test('every country code in world-countries has a bundled flag, checked one by one (the listed exceptions keep the fallback)', () => {
  const urls = flagUrlsByCode(globbedFlags())
  const codes = worldCountries.map((country) => country.cca2.toLowerCase())
  assert.equal(codes.length, new Set(codes).size)
  assert.ok(codes.length >= 250, String(codes.length))
  const missing: string[] = []
  for (const code of codes) {
    const url = flagUrlFor(urls, code)
    if (url === undefined) missing.push(code)
    else assert.equal(url, `/assets/${code}-hash.svg`, code)
  }
  assert.deepEqual(missing, CODES_WITHOUT_FLAG)
})
