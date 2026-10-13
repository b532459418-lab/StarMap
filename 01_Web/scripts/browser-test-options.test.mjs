/** Option rules of `npm run test:browser` (batch 4, E2): one group, an optional --shard passed through, nothing else. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_TEST_GROUPS, parseBrowserTestArgs } from './browser-test-options.mjs'

test('without options every spec case runs and nothing is passed to Playwright', () => {
  assert.deepEqual(parseBrowserTestArgs([]), { group: null, shard: null, playwrightArgs: [] })
})

test('each group keeps its existing Playwright selection', () => {
  assert.deepEqual(BROWSER_TEST_GROUPS, ['--performance', '--time-filters', '--critical-flows', '--media-recovery', '--media-lifecycle', '--public-smoke'])
  const expected = {
    '--performance': [],
    '--time-filters': ['time-filter'],
    '--critical-flows': ['critical-flows.spec.mjs'],
    '--media-recovery': ['media-recovery.spec.mjs'],
    '--media-lifecycle': ['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss'],
    // The config selects *.smoke.mjs for this group (see playwright-config.test.mjs).
    '--public-smoke': [],
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
