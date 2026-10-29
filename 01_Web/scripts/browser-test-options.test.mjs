/**
 * Option rules of `npm run test:browser` (batch 4, E2): one group, an optional --shard passed through, nothing else.
 * Batch 4B: a shard whose listing has no case is refused.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_TEST_GROUPS, assertShardListed, listedTestCount, listingArgs, parseBrowserTestArgs } from './browser-test-options.mjs'

test('without options every spec case runs and nothing is passed to Playwright', () => {
  assert.deepEqual(parseBrowserTestArgs([]), { group: null, shard: null, playwrightArgs: [] })
})

test('3C-4d (review §7-2): CI runs the --migration group in browser-checks, whose result Public checks requires', async () => {
  const { readFile } = await import('node:fs/promises')
  // Windows checkouts may hold CRLF line endings.
  const workflow = (await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')).split(String.fromCharCode(13)).join('')
  const job = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`)
    assert.ok(start >= 0, name)
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/)
    return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
  }
  assert.match(job('browser-checks'), /- suite: migration\n\s+flag: --migration\n\s+shard: 1\n\s+shards: 1\n/)
  assert.match(job('browser-checks'), /npm run test:browser -- \$\{\{ matrix\.flag \}\}/)
  const required = job('public-checks')
  assert.match(required, /needs: \[[^\]]*\bbrowser-checks\b[^\]]*\]/)
  assert.match(required, /BROWSER_RESULT: \$\{\{ needs\['browser-checks'\]\.result \}\}/)
  assert.match(required, /test "\$BROWSER_RESULT" = success/)
})

test('each group keeps its existing Playwright selection', () => {
  assert.deepEqual(BROWSER_TEST_GROUPS, ['--performance', '--time-filters', '--critical-flows', '--media-recovery', '--media-lifecycle', '--public-smoke', '--migration'])
  const expected = {
    '--performance': [],
    '--time-filters': ['time-filter'],
    '--critical-flows': ['critical-flows.spec.mjs', 'map-recovery.spec.mjs'],
    '--media-recovery': ['media-recovery.spec.mjs'],
    '--media-lifecycle': ['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss'],
    // The config selects *.smoke.mjs for this group (see playwright-config.test.mjs).
    '--public-smoke': [],
    // 3C-4d: the config selects *.migration.mjs for this group.
    '--migration': [],
  }
  for (const group of BROWSER_TEST_GROUPS) {
    assert.deepEqual(parseBrowserTestArgs([group]), { group, shard: null, playwrightArgs: expected[group] }, group)
  }
})

test('a valid --shard is passed to Playwright unchanged, alone or after the group selection in either order', () => {
  assert.deepEqual(parseBrowserTestArgs(['--shard=2/3']), { group: null, shard: '--shard=2/3', playwrightArgs: ['--shard=2/3'] })
  assert.deepEqual(parseBrowserTestArgs(['--time-filters', '--shard=3/3']), { group: '--time-filters', shard: '--shard=3/3', playwrightArgs: ['time-filter', '--shard=3/3'] })
  assert.deepEqual(parseBrowserTestArgs(['--shard=1/3', '--time-filters']), { group: '--time-filters', shard: '--shard=1/3', playwrightArgs: ['time-filter', '--shard=1/3'] })
  assert.deepEqual(parseBrowserTestArgs(['--media-lifecycle', '--shard=1/1']).playwrightArgs, ['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss', '--shard=1/1'])
  for (const shard of ['--shard=1/1', '--shard=3/3', '--shard=10/12', '--shard=1/40']) {
    assert.deepEqual(parseBrowserTestArgs([shard]).playwrightArgs, [shard], shard)
  }
})

test('malformed or out-of-range shards are refused', () => {
  const invalid = [
    '--shard', '--shard=', '--shard=3', '--shard=/3', '--shard=1/', '--shard=0/3', '--shard=4/3', '--shard=1/0', '--shard=01/3', '--shard=1/03',
    '--shard=1/3/2', '--shard=a/b', '--shard=1-3', '--shard=-1/3', '--shard=1.5/3', '--shard=1/3 ', '--shard= 1/3', '--shard 1/3', '--sharding=1/3',
  ]
  for (const arg of invalid) assert.throws(() => parseBrowserTestArgs([arg]), /Invalid shard/, arg)
  // The value must be part of the same argument, as Playwright's own --shard=<i>/<n> form.
  assert.throws(() => parseBrowserTestArgs(['--shard', '1/3']), /Invalid shard/)
  assert.throws(() => parseBrowserTestArgs(['--time-filters', '--shard=0/1']), /Invalid shard/)
})

test('only one shard and only one group are accepted', () => {
  assert.throws(() => parseBrowserTestArgs(['--shard=1/3', '--shard=2/3']), /Only one --shard/)
  assert.throws(() => parseBrowserTestArgs(['--shard=1/3', '--shard=1/3']), /Only one --shard/)
  assert.throws(() => parseBrowserTestArgs(['--time-filters', '--critical-flows']), /Only one group/)
  assert.throws(() => parseBrowserTestArgs(['--media-recovery', '--shard=1/2', '--media-recovery']), /Only one group/)
})

test('any other option is refused, including Playwright options and bare file filters', () => {
  for (const arg of ['--grep', '--grep=media', '--workers=2', '--headed', '--list', '--critical', 'time-filter', 'critical-flows.spec.mjs', '-g', '']) {
    assert.throws(() => parseBrowserTestArgs([arg]), /Unknown option/, arg)
    assert.throws(() => parseBrowserTestArgs(['--time-filters', '--shard=1/3', arg]), /Unknown option/, arg)
  }
})

test('results are fresh arrays, so a caller cannot change later selections', () => {
  const first = parseBrowserTestArgs(['--media-lifecycle'])
  first.playwrightArgs.push('--headed')
  assert.deepEqual(parseBrowserTestArgs(['--media-lifecycle']).playwrightArgs, ['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss'])
})

test('a listing keeps the run selection and only adds --list with the plain list reporter', () => {
  for (const args of [['--time-filters', '--shard=2/3'], ['--media-lifecycle', '--shard=1/1'], ['--shard=1/2'], ['--critical-flows']]) {
    const { playwrightArgs } = parseBrowserTestArgs(args)
    assert.deepEqual(listingArgs(playwrightArgs), ['--list', '--reporter=list', ...playwrightArgs], args.join(' '))
  }
})

test('the listed case count is read from the single summary line, singular or plural, LF or CRLF', () => {
  assert.equal(listedTestCount('Listing tests:\nTotal: 0 tests in 0 files\n'), 0)
  assert.equal(listedTestCount('Listing tests:\n  a.spec.mjs:3:1 › one\nTotal: 1 test in 1 file\n'), 1)
  assert.equal(listedTestCount('Listing tests:\r\n  a.spec.mjs:3:1 › one\r\n  b.spec.mjs:4:1 › two\r\nTotal: 12 tests in 2 files\r\n'), 12)
})

test('a listing without exactly one summary line is an error, never zero cases', () => {
  for (const output of ['', 'Listing tests:\n', 'Total: tests in 1 file\n', '  Total: 3 tests in 1 file\n', 'Total: 1 test in 1 file\nTotal: 2 tests in 1 file\n']) {
    assert.throws(() => listedTestCount(output), /Expected one "Total: <n> tests in <m> files" line/, JSON.stringify(output))
    assert.throws(() => assertShardListed('--shard=1/2', output), /Expected one/, JSON.stringify(output))
  }
})

test('an empty shard is refused; a shard with cases returns its count', () => {
  assert.throws(() => assertShardListed('--shard=3/3', 'Listing tests:\nTotal: 0 tests in 0 files\n'), /--shard=3\/3 received no test cases/)
  assert.equal(assertShardListed('--shard=1/3', 'Listing tests:\n  a.spec.mjs:3:1 › one\nTotal: 1 test in 1 file\n'), 1)
})

// Reads Playwright's real list output, so a reporter change in an upgrade fails here and not silently in CI. The
// config only checks the fixture path's form; listing starts no server and creates nothing there.
test('the real Playwright listing of an empty and a filled shard is read correctly', async () => {
  const webRoot = fileURLToPath(new URL('../', import.meta.url))
  const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
  const list = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', 'playwright.config.mjs', ...listingArgs(parseBrowserTestArgs(args).playwrightArgs)], {
      cwd: webRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STARMAP_BROWSER_TEST_ROOT: path.join(os.tmpdir(), 'starmap-browser-options-test'), STARMAP_BROWSER_PERFORMANCE: '0', STARMAP_BROWSER_PUBLIC_SMOKE: '0' },
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
  // Far more shards than the group has cases, so the last one is empty however the group is split.
  const empty = await list(['--critical-flows', '--shard=40/40'])
  assert.equal(empty.code, 0, 'Playwright itself accepts the empty shard')
  assert.equal(listedTestCount(empty.output), 0)
  assert.throws(() => assertShardListed('--shard=40/40', empty.output), /received no test cases/)
  const filled = await list(['--critical-flows', '--shard=1/1'])
  assert.equal(filled.code, 0)
  assert.ok(assertShardListed('--shard=1/1', filled.output) > 0)
})
