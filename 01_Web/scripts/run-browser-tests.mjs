import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, lstat, realpath } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserFixture } from './browser-fixture.mjs'
import { assertShardListed, listingArgs, parseBrowserTestArgs } from './browser-test-options.mjs'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
// Option rules (one group, optional --shard, nothing else) live in ./browser-test-options.mjs.
const { group, shard, playwrightArgs } = parseBrowserTestArgs(process.argv.slice(2))
const large = group === '--performance'
const mediaRecovery = group === '--media-recovery'
const mediaLifecycle = group === '--media-lifecycle'
const publicSmoke = group === '--public-smoke'
// 3C-4d: the fixture is migrated into the new library, except for `--migration`, which needs a root to migrate.
const migration = group === '--migration'
// The smoke serves the existing public build; it never builds by itself, so CI can search dist/ before serving it.
if (publicSmoke && !existsSync(path.join(webRoot, 'dist', 'index.html'))) throw new Error('--public-smoke serves dist/ through vite preview. Run npm run build:public first.')
const occupied = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: 5173 })
  socket.setTimeout(2000)
  socket.on('connect', () => { socket.destroy(); resolve(true) })
  socket.on('error', (error) => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error))
  socket.on('timeout', () => { socket.destroy(); reject(new Error('Port probe timed out')) })
})
if (occupied) throw new Error('Port 5173 is occupied. Stop your own preview before running browser tests; existing servers will not be reused or stopped.')
const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-browser-'))
const rootIdentity = await lstat(root, { bigint: true })
const canonicalTemp = await realpath(os.tmpdir())
function cleanupTarget(value) {
  const resolved = path.resolve(value)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('starmap-browser-')) throw new Error('Unsafe browser fixture cleanup target')
  return resolved
}
async function cleanupOwnedRoot() {
  const target = cleanupTarget(root), current = await lstat(target, { bigint: true })
  if (current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || path.dirname(await realpath(target)) !== canonicalTemp) throw new Error('Browser fixture ownership changed; refusing cleanup')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
}
try {
  // The public preview reads no private root, so the smoke leaves its temporary root empty.
  if (!publicSmoke) await createBrowserFixture(root, { large, mode: migration ? 'v2' : 'store' })
  const env = { ...process.env, STARMAP_BROWSER_TEST_ROOT: root, STARMAP_BROWSER_PERFORMANCE: large ? '1' : '0', STARMAP_BROWSER_MEDIA_DIAGNOSTIC: mediaLifecycle ? '1' : '0', STARMAP_BROWSER_MEDIA_SUITE: mediaRecovery ? '1' : '0', STARMAP_BROWSER_PUBLIC_SMOKE: publicSmoke ? '1' : '0', STARMAP_BROWSER_MIGRATION: migration ? '1' : '0', STARMAP_PRIVATE_ROOT: root, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '' }
  const run = (args, stdout) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', '--config', 'playwright.config.mjs', ...args], { cwd: webRoot, stdio: ['inherit', stdout, 'inherit'], env })
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { output += chunk })
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => resolve({ code: code ?? 1, output })) })
  }
  // Playwright passes a shard that received no case. List the shard first (same selection, same environment; it
  // starts no server) and refuse it when it is empty (batch 4B).
  if (shard) {
    const listing = await run(listingArgs(playwrightArgs), 'pipe')
    if (listing.code !== 0) {
      process.stdout.write(listing.output)
      throw new Error(`Listing the cases of ${shard} failed with exit code ${listing.code}.`)
    }
    console.log(`${shard}: ${assertShardListed(shard, listing.output)} cases listed.`)
  }
  process.exitCode = (await run(playwrightArgs, 'inherit')).code
} finally {
  await cleanupOwnedRoot()
}
