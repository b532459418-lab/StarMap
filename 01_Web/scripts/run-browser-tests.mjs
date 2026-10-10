import { spawn } from 'node:child_process'
import { mkdtemp, rm, lstat, realpath } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserFixture } from './browser-fixture.mjs'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const large = process.argv.slice(2).includes('--performance')
const timeFilters = process.argv.slice(2).includes('--time-filters')
const criticalFlows = process.argv.slice(2).includes('--critical-flows')
const mediaRecovery = process.argv.slice(2).includes('--media-recovery')
const mediaLifecycle = process.argv.slice(2).includes('--media-lifecycle')
const repositoryPreview = process.argv.slice(2).includes('--repository-preview')
if (process.argv.slice(2).some((arg) => !['--performance', '--time-filters', '--critical-flows', '--media-recovery', '--media-lifecycle', '--repository-preview'].includes(arg)) || [large, timeFilters, criticalFlows, mediaRecovery, mediaLifecycle, repositoryPreview].filter(Boolean).length > 1) throw new Error('Supported options: --performance, --time-filters, --critical-flows, --media-recovery, --media-lifecycle or --repository-preview')
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
  if (!repositoryPreview) await createBrowserFixture(root, { large })
  // Preview cannot inherit VITE_* or private configuration from its caller.
  // Only runtime discovery and OS process essentials cross this boundary.
  const inherited = repositoryPreview
    ? Object.fromEntries(Object.keys(process.env).filter(key => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'CI', 'PLAYWRIGHT_BROWSERS_PATH', 'STARMAP_BROWSER_ARTIFACT_DIR'].includes(key.toUpperCase())).map(key => [key, process.env[key]]))
    : process.env
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)), 'test', '--config', 'playwright.config.mjs', ...(repositoryPreview ? ['repository-preview.spec.mjs'] : timeFilters ? ['time-filter'] : criticalFlows ? ['critical-flows.spec.mjs'] : mediaRecovery ? ['media-recovery.spec.mjs'] : mediaLifecycle ? ['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss'] : [])], {
    cwd: webRoot,
    stdio: 'inherit',
    env: { ...inherited, STARMAP_BROWSER_TEST_ROOT: root, STARMAP_BROWSER_REPOSITORY_PREVIEW: repositoryPreview ? '1' : '0', STARMAP_BROWSER_PERFORMANCE: large ? '1' : '0', STARMAP_BROWSER_MEDIA_DIAGNOSTIC: mediaLifecycle ? '1' : '0', STARMAP_BROWSER_MEDIA_SUITE: mediaRecovery ? '1' : '0', STARMAP_PRIVATE_ROOT: repositoryPreview ? '' : root, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '' },
  })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1)) })
  process.exitCode = code
} finally {
  await cleanupOwnedRoot()
}
