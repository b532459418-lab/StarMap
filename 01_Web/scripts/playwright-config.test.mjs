/** Browser-test configuration (batch 4): which files and which server each runner mode uses. Evaluates the real config. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const configUrl = new URL('../playwright.config.mjs', import.meta.url)
const fakeRoot = path.join(os.tmpdir(), 'starmap-browser-config-test')
let evaluation = 0

// The config reads its environment once, at import; a fresh query string evaluates it again.
async function configWith(env) {
  const names = ['STARMAP_BROWSER_TEST_ROOT', 'STARMAP_BROWSER_PERFORMANCE', 'STARMAP_BROWSER_PUBLIC_SMOKE', 'CI']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, { STARMAP_BROWSER_TEST_ROOT: fakeRoot, STARMAP_BROWSER_PERFORMANCE: '0', STARMAP_BROWSER_PUBLIC_SMOKE: '0' })
  delete process.env.CI
  Object.assign(process.env, env)
  try {
    return (await import(`${configUrl.href}?evaluation=${++evaluation}`)).default
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

test('the default run uses *.spec.mjs against the personal dev server', async () => {
  const config = await configWith({})
  assert.equal(config.testMatch, '**/*.spec.mjs')
  assert.equal(config.webServer.command, 'npm run dev:personal')
  assert.equal(config.webServer.reuseExistingServer, false)
  assert.equal(config.globalSetup, './tests/browser/dev-server-warmup.mjs')
})

test('--public-smoke uses only *.smoke.mjs against vite preview of the public build on port 5173', async () => {
  const config = await configWith({ STARMAP_BROWSER_PUBLIC_SMOKE: '1' })
  assert.equal(config.testMatch, '**/*.smoke.mjs')
  assert.equal(config.webServer.command, 'npm run preview -- --mode public --host 127.0.0.1 --port 5173 --strictPort')
  assert.equal(config.webServer.url, 'http://127.0.0.1:5173')
  assert.equal(config.webServer.reuseExistingServer, false)
  assert.equal(config.globalSetup, undefined, 'vite preview needs no dev-server warm-up')
})

test('the performance baseline keeps its own files and the dev server', async () => {
  const config = await configWith({ STARMAP_BROWSER_PERFORMANCE: '1' })
  assert.equal(config.testMatch, '**/*.perf.mjs')
  assert.equal(config.webServer.command, 'npm run dev:personal')
  assert.equal(config.globalSetup, undefined, 'the baseline keeps measuring an unwarmed first load')
})

test('a committed test.only fails only under CI', async () => {
  assert.equal((await configWith({})).forbidOnly, false)
  assert.equal((await configWith({ CI: 'true' })).forbidOnly, true)
})

test('every browser test file belongs to exactly one runner mode, and the smoke and warm-up files are not specs', async () => {
  const files = (await readdir(new URL('../tests/browser/', import.meta.url))).filter((name) => !['helpers.mjs', 'dev-server-warmup.mjs'].includes(name))
  for (const name of files) {
    const modes = ['.spec.mjs', '.smoke.mjs', '.perf.mjs'].filter((suffix) => name.endsWith(suffix))
    assert.equal(modes.length, 1, name)
  }
  assert.ok(files.includes('public-build.smoke.mjs'))
  assert.equal(files.filter((name) => name.endsWith('.smoke.mjs')).some((name) => name.endsWith('.spec.mjs')), false)
})
