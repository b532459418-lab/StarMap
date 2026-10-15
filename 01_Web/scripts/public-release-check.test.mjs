/**
 * scripts/public-release-check.mjs: the sanitized environment of the clean-room commands, and the output of a failing
 * command (batch 7, review S5). Synthetic values only; the release check itself is not run here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { releaseCheckEnvironment, run } from './public-release-check.mjs'

test('the clean-room commands inherit only the allowlisted variables', () => {
  const source = {
    Path: 'C:\\synthetic\\bin',
    SystemRoot: 'C:\\Windows',
    HOME: '/home/synthetic',
    TEMP: 'C:\\Temp',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    no_proxy: 'localhost',
    CI: 'true',
    STARMAP_PRIVATE_ROOT: 'C:\\synthetic\\private',
    STARMAP_ANYTHING: 'x',
    VITE_CESIUM_ION_TOKEN: 'synthetic-token',
    VITE_GOOGLE_MAPS_API_KEY: 'synthetic-key',
    GITHUB_TOKEN: 'synthetic-token',
    NPM_TOKEN: 'synthetic-token',
    'npm_config_//registry.npmjs.org/:_authToken': 'synthetic-token',
    npm_config_registry: 'https://registry.example',
    NODE_OPTIONS: '--require ./synthetic.js',
    AWS_SECRET_ACCESS_KEY: 'synthetic-secret',
    UNDEFINED_VALUE: undefined,
  }
  assert.deepEqual(releaseCheckEnvironment(source), {
    Path: 'C:\\synthetic\\bin',
    SystemRoot: 'C:\\Windows',
    HOME: '/home/synthetic',
    TEMP: 'C:\\Temp',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    no_proxy: 'localhost',
    CI: 'true',
  })
})

test('the default environment never carries the private root or a VITE_ value', () => {
  const environment = releaseCheckEnvironment()
  for (const name of Object.keys(environment)) {
    assert.ok(!/^(STARMAP_|VITE_)|TOKEN|SECRET/i.test(name), name)
  }
  assert.ok(Object.keys(environment).some((name) => name.toUpperCase() === 'PATH'))
})

test('a failing command prints the output it captured before the error, and the child sees the sanitized environment', async () => {
  const written = []
  const write = (stream, text) => written.push([stream, text])
  const script = 'console.log("synthetic stdout " + (process.env.STARMAP_PRIVATE_ROOT ?? "absent")); console.error("synthetic stderr"); process.exit(3)'
  const env = releaseCheckEnvironment({ ...process.env, STARMAP_PRIVATE_ROOT: 'C:\\synthetic\\private' })
  await assert.rejects(run(process.execPath, ['-e', script], tmpdir(), { env, write }), /Failed to run/)
  assert.deepEqual(written.map(([stream, text]) => [stream, text.trim()]), [
    ['stdout', 'synthetic stdout absent'],
    ['stderr', 'synthetic stderr'],
  ])
})

test('a successful command prints its output as before', async () => {
  const written = []
  await run(process.execPath, ['-e', 'console.log("synthetic ok")'], tmpdir(), { write: (stream, text) => written.push([stream, text.trim()]) })
  assert.deepEqual(written, [['stdout', 'synthetic ok']])
})
