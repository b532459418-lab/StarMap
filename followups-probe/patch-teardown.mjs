// Temporary (test stability follow-ups, rounds 1-2, G1; design §1.3, §10.1): adds timing records of each case's teardown to
// tests/browser/helpers.mjs in the runner's checkout only. Nothing is committed. Run after patch-helpers.mjs.
// For each case, one line in STARMAP_PROBE_OUT/teardown.jsonl per phase:
//   page fixture: from the end of the case's body (use) to the start of context.close(), and context.close() itself;
//   browser fixture: the size of Playwright's temporary browser profile just before browser.close() (bytes, files,
//   the largest top-level folders), then browser.close() itself.
// Usage: node followups-probe/patch-teardown.mjs <path of helpers.mjs>
import { readFileSync, writeFileSync } from 'node:fs'

const NL = String.fromCharCode(10)
const file = process.argv[2]
let source = readFileSync(file, 'utf8').split(String.fromCharCode(13) + NL).join(NL)
const once = (from, to, what) => {
  if (source.split(from).length !== 2) throw new Error('patch-teardown ' + what + ': anchor not found exactly once')
  source = source.replace(from, () => to)
}

const helpers = [
  '// followups probe (temporary): teardown timing records',
  'const probeTeardown = async (testInfo, record) => {',
  '  if (!process.env.STARMAP_PROBE_OUT) return',
  '  const { appendFileSync, mkdirSync } = await import(\'node:fs\')',
  '  mkdirSync(process.env.STARMAP_PROBE_OUT, { recursive: true })',
  '  appendFileSync(path.join(process.env.STARMAP_PROBE_OUT, \'teardown.jsonl\'), JSON.stringify({ file: path.basename(testInfo.file), title: testInfo.title,',
  '    repeat: testInfo.repeatEachIndex, status: testInfo.status, at: Date.now(), ...record }) + String.fromCharCode(10))',
  '}',
  'const probeProfileSize = async () => {',
  '  const { readdir, stat } = await import(\'node:fs/promises\')',
  '  const started = performance.now()',
  '  const profiles = (await readdir(os.tmpdir())).filter((name) => name.startsWith(\'playwright_chromium\'))',
  '  let bytes = 0, files = 0',
  '  const folders = {}',
  '  for (const profile of profiles) {',
  '    const base = path.join(os.tmpdir(), profile)',
  '    const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => [])',
  '    for (const entry of entries) {',
  '      if (!entry.isFile()) continue',
  '      const full = path.join(entry.parentPath ?? entry.path, entry.name)',
  '      const size = (await stat(full).catch(() => ({ size: 0 }))).size',
  '      bytes += size; files++',
  '      const top = path.relative(base, full).split(path.sep).slice(0, 2).join(\'/\')',
  '      folders[top] = (folders[top] ?? 0) + size',
  '    }',
  '  }',
  '  const largest = Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 8)',
  '  return { profiles: profiles.length, profileBytes: bytes, profileFiles: files, largest, sizedInMs: Math.round(performance.now() - started) }',
  '}',
  '',
].join(NL)
once('export const test = base.extend({' + NL, helpers + 'export const test = base.extend({' + NL, 'helpers')

// The browser fixture: profile size, then browser.close() timed.
once("      try { await browser.close(); mediaPhase(state, 'fixture browser close finished') }" + NL,
  '      const probeProfile = await probeProfileSize().catch((error) => ({ profileError: String(error?.message ?? error) }))' + NL
  + '      const probeBrowserAt = performance.now()' + NL
  + "      try { await browser.close(); mediaPhase(state, 'fixture browser close finished'); await probeTeardown(testInfo, { phase: 'browser close', ms: Math.round(performance.now() - probeBrowserAt), ...probeProfile }) }" + NL,
  'browser close')

// The page fixture: the end of the case's body, then context.close() timed.
once('      await use(page)' + NL, '      await use(page)' + NL + '      testInfo.__probeUsedAt = performance.now()' + NL, 'use')
once('      await context.close()' + NL,
  '      const probeContextAt = performance.now()' + NL
  + '      await probeTeardown(testInfo, { phase: \'page body to context close\', ms: testInfo.__probeUsedAt === undefined ? null : Math.round(probeContextAt - testInfo.__probeUsedAt) })' + NL
  + '      await context.close()' + NL
  + '      await probeTeardown(testInfo, { phase: \'context close\', ms: Math.round(performance.now() - probeContextAt) })' + NL,
  'context close')

writeFileSync(file, source)
console.log('followups probe teardown records added to ' + file)
