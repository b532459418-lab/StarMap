// Temporary (test stability follow-ups, round 1; from the test stability batch): runs Playwright with any arguments (--grep, --repeat-each) on the same isolated
// synthetic fixture and with the same environment as scripts/run-browser-tests.mjs, which refuses those arguments.
// Usage (from 01_Web): node ../followups-probe/run.mjs [--lifecycle] -- <playwright test arguments>
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const web = process.cwd()
const separator = process.argv.indexOf('--')
const own = separator === -1 ? [] : process.argv.slice(2, separator)
const playwrightArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1)
const lifecycle = own.includes('--lifecycle')
const { createBrowserFixture } = await import(pathToFileURL(path.join(web, 'scripts', 'browser-fixture.mjs')).href)

const occupied = await new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: 5173 })
  socket.on('connect', () => { socket.destroy(); resolve(true) })
  socket.on('error', () => resolve(false))
})
if (occupied) throw new Error('Port 5173 is occupied.')
const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-browser-'))
try {
  await createBrowserFixture(root, { large: false, mode: 'store' })
  const env = {
    ...process.env, STARMAP_BROWSER_TEST_ROOT: root, STARMAP_BROWSER_PERFORMANCE: '0', STARMAP_BROWSER_MEDIA_DIAGNOSTIC: lifecycle ? '1' : '0',
    STARMAP_BROWSER_MEDIA_SUITE: '0', STARMAP_BROWSER_PUBLIC_SMOKE: '0', STARMAP_BROWSER_MIGRATION: '0', STARMAP_PRIVATE_ROOT: root,
    VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '',
  }
  const cli = path.join(web, 'node_modules', '@playwright', 'test', 'cli.js')
  console.log(`stability probe: playwright test ${playwrightArgs.join(' ')}`)
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', 'playwright.config.mjs', ...playwrightArgs], { cwd: web, stdio: 'inherit', env })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
