/**
 * Every error code with a message has a source (robustness batch, design §5.4; the author's decision of 2026-11-05).
 *
 * Seven codes once kept their messages after the code that produced them was removed (#91), with only branches that
 * read them. So: each code of the editor's message table (src/data/editor/errors.ts) and of the page's error texts
 * (src/i18n/domainErrorResources.ts) must occur at least once in src/ or scripts/ outside those two files, the tests,
 * the fixtures and comments, in a form other than a comparison (`=== 'E_…'`) or a list of codes a reader checks
 * against. A code produced through a table (`E_STALE: 409`) or a call (`fail('E_…')`) counts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { V2_WRITE_ERROR_CODES } from '../src/data/editor/errors.ts'
import { domainErrorResources } from '../src/i18n/domainErrorResources.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const DEFINITIONS = new Set(['src/data/editor/errors.ts', 'src/i18n/domainErrorResources.ts'])
const excluded = (relative) => DEFINITIONS.has(relative) || /\.test\.(ts|mjs)$/.test(relative) || /fixture/i.test(relative)
  || relative.startsWith('src/data/editor/fixtures/')

function sources() {
  const files = []
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(full)
    }
  }
  for (const root of ['src', 'scripts']) walk(path.join(web, root))
  return files.map((full) => ({ relative: path.relative(web, full).split(path.sep).join('/'), full }))
    .filter(({ relative }) => !excluded(relative))
    .map(({ relative, full }) => ({ relative, lines: readFileSync(full, 'utf8').split(/\r?\n/) }))
}

/** Whether this line produces `code` (see the header): not a comment, not a comparison, not a list a reader keeps. */
export function produces(line, code) {
  const text = line.trim()
  if (!new RegExp(`\\b${code}\\b`).test(text)) return false
  if (/^(\*|\/\/|\/\*)/.test(text)) return false
  const literal = `['"\`]${code}['"\`]`
  if (new RegExp(`(?:===|!==)\\s*${literal}|${literal}\\s*(?:===|!==)`).test(text)) return false
  // A line that is only a list of quoted codes (a set or an array of codes a reader checks against).
  if (/^((['"])E_[A-Z0-9_]+\2\s*,?\s*)+(\]\)?\)?\s*,?)?$/.test(text)) return false
  return true
}

test('the check: a call, a table entry and a template produce; a comparison, a reader list and a comment do not', () => {
  assert.equal(produces("  fail('E_REQUIRED', { field })", 'E_REQUIRED'), true)
  assert.equal(produces('  E_STALE: 409, E_OPERATION_CONFLICT: 409,', 'E_STALE'), true)
  assert.equal(produces("throw new V2WriteError('E_MEDIA_EXTENSION')", 'E_MEDIA_EXTENSION'), true)
  assert.equal(produces("if (error.code === 'E_WRITE_FAILED') return true", 'E_WRITE_FAILED'), false)
  assert.equal(produces("  && (error.code === 'E_PARTIAL_WRITE' || error.code === 'E_EDITOR_RESPONSE_INVALID'))", 'E_PARTIAL_WRITE'), false)
  assert.equal(produces("  'E_MEDIA_DRONE_DATE', 'E_MEDIA_COORDINATES_RANGE', 'E_MEDIA_FOLDER_CONFLICT',", 'E_MEDIA_DRONE_DATE'), false)
  assert.equal(produces(' * refused with `E_MEDIA_INDEX_MISMATCH`.', 'E_MEDIA_INDEX_MISMATCH'), false)
  assert.equal(produces('// E_MEDIA_INDEX_MISMATCH', 'E_MEDIA_INDEX_MISMATCH'), false)
})

test('every error code with a message has a source outside its definitions, the tests and comments', () => {
  const codes = new Set([...V2_WRITE_ERROR_CODES, ...Object.keys(domainErrorResources.en).filter((key) => /^E_[A-Z0-9_]+$/.test(key))])
  const files = sources()
  const sourceless = [...codes].filter((code) => !files.some(({ lines }) => lines.some((line) => produces(line, code)))).sort()
  assert.deepEqual(sourceless, [], `codes with a message and no source: ${sourceless.join(', ')}`)
})
