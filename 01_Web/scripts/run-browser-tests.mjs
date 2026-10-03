import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserFixture } from './browser-fixture.mjs'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const large = process.argv.slice(2).includes('--performance')
const timeFilters = process.argv.slice(2).includes('--time-filters')
const criticalFlows = process.argv.slice(2).includes('--critical-flows')
if (process.argv.slice(2).some((arg) => !['--performance', '--time-filters', '--critical-flows'].includes(arg)) || [large, timeFilters, criticalFlows].filter(Boolean).length > 1) throw new Error('Supported options: --performance, --time-filters or --critical-flows')
const occupied = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: 5173 })
  socket.setTimeout(2000)
  socket.on('connect', () => { socket.destroy(); resolve(true) })
  socket.on('error', (error) => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error))
  socket.on('timeout', () => { socket.destroy(); reject(new Error('Port probe timed out')) })
})
if (occupied) throw new Error('Port 5173 is occupied. Stop your own preview before running browser tests; existing servers will not be reused or stopped.')
const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-browser-'))
function cleanupTarget(value) {
  const resolved = path.resolve(value)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('starmap-browser-')) throw new Error('Unsafe browser fixture cleanup target')
  return resolved
}
try {
  await createBrowserFixture(root, { large })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)), 'test', '--config', 'playwright.config.mjs', ...(timeFilters ? ['time-filter'] : criticalFlows ? ['critical-flows.spec.mjs'] : [])], {
    cwd: webRoot,
    stdio: 'inherit',
    env: { ...process.env, STARMAP_BROWSER_TEST_ROOT: root, STARMAP_BROWSER_PERFORMANCE: large ? '1' : '0', STARMAP_PRIVATE_ROOT: root, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '' },
  })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1)) })
  process.exitCode = code
} finally {
  await rm(cleanupTarget(root), { recursive: true, force: true, maxRetries: 3 })
}
