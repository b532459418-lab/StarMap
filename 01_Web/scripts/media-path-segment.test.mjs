/** The shared Inbox path-segment rule (review D9). Pure; no file system access. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V2WriteError } from '../src/data/v2write/errors.ts'
import { isSafePathSegment, toSafePathSegment } from './media-path-segment.mjs'
import { safeSegment } from './local-editor-upload.mjs'

const control = (code) => String.fromCharCode(code)

test('D9: names that already are safe segments come back unchanged (existing folders keep their names)', () => {
  for (const name of ['Test City', 'Reykjavík', '京都・Kyoto', 'Test City (0000000a)', 'scene.jpg', 'a.b.c', '.hidden', 'CONSOLE', 'nullable',
    'COM10', 'LPT0', 'con-x', 'a'.repeat(120), 'Washington D.C._', 'CON_']) {
    assert.equal(isSafePathSegment(name), true, name)
    assert.equal(toSafePathSegment(name), name, name)
    assert.equal(safeSegment(name), name, name)
  }
})

test('D9: trailing dots and spaces, device names and control characters are escaped, not refused', () => {
  const cases = [
    ['Washington D.C.', 'Washington D.C._'],
    ['St. Kitts .', 'St. Kitts ._'],
    ['CON', 'CON_'],
    ['con', 'con_'],
    ['Nul.jpg', 'Nul_.jpg'],
    ['aux.tar.gz', 'aux_.tar.gz'],
    ['COM1', 'COM1_'],
    ['lpt9.png', 'lpt9_.png'],
    ['COM¹', 'COM¹_'],
    ['CONIN$', 'CONIN$_'],
    ['conout$.txt', 'conout$_.txt'],
    ['CON.', 'CON_._'],
    [`Tab${control(9)}City`, 'Tab-City'],
    [`Del${control(0x7f)}C1${control(0x85)}`, 'Del-C1-'],
    ['a<b>c:d"e/f\\g|h?i*j', 'a-b-c-d-e-f-g-h-i-j'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(toSafePathSegment(input), expected, JSON.stringify(input))
    assert.equal(isSafePathSegment(input), false, JSON.stringify(input))
    assert.equal(isSafePathSegment(expected), true, JSON.stringify(expected))
  }
})

test('D9: truncation keeps 120 code units without splitting a surrogate pair', () => {
  const astral = String.fromCodePoint(0x1f600)
  const name = `${'a'.repeat(119)}${astral}tail`
  const escaped = toSafePathSegment(name)
  assert.equal(escaped, 'a'.repeat(119))
  assert.equal(isSafePathSegment(escaped), true)
  assert.equal(toSafePathSegment(`${'a'.repeat(118)}${astral}tail`), `${'a'.repeat(118)}${astral}`)
  // A cut that ends on a dot is escaped like any trailing dot.
  assert.equal(toSafePathSegment(`${'b'.repeat(119)}.tail`), `${'b'.repeat(119)}._`)
})

test('D9: every escaped name is a safe segment; empty, "." and ".." are still refused with the field', () => {
  const inputs = ['  spaced  ', 'trailing.', 'trailing ', ' lead', 'PRN', 'nul ', `x${control(0)}y`, '..a', 'a..', '...x', 'x...', 'A:B', 'é'.repeat(130)]
  for (const input of inputs) assert.equal(isSafePathSegment(toSafePathSegment(input)), true, JSON.stringify(input))
  for (const value of ['', '   ', '.', '..', ' .. ', null, undefined]) {
    assert.throws(() => toSafePathSegment(value, 'media_city'), (error) => error instanceof V2WriteError
      && error.code === 'E_MEDIA_NAME_INVALID' && error.params.field === 'media_city')
  }
  assert.equal(isSafePathSegment(''), false)
  assert.equal(isSafePathSegment('x'.repeat(201)), false)
  assert.equal(isSafePathSegment(42), false)
})
