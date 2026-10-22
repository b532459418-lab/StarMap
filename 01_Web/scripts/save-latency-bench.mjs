/**
 * "Save to usable" in a real browser (3C-5 D, spec §2.4; external review §5-5, D9): from the click on a save until the
 * commit is done, the page shows the data of that revision and the next operation can run. Synthetic data only.
 *
 *   node scripts/save-latency-bench.mjs --dir <empty temp dir> [--scale real|small|tiny] [--runs 20] [--ops note,hide,order]
 *                                       [--out result.json] [--profile <file prefix>] [--gpu]
 *
 * - Generates the store root of the scale (./store-mode-bench.mjs generateRoots: real = 100 countries, 2 900 cities,
 *   6 500 visits, 3 000 want-to-go items, 10 000 media) under <dir>, starts `vite --mode personal` on 127.0.0.1:5173 on it
 *   (port 5173 must be free; proxies are not used), and drives Chromium (Playwright) in English.
 * - Operations, each `--runs` times on its own item: `note` (a want-to-go note saved in Collection), `hide` (a want-to-go
 *   item hidden in Collection), `order` (the first country moved down one place by keyboard and the country list saved).
 * - The time starts in the page when the save button is clicked (performance.timeOrigin + now, kept in sessionStorage)
 *   and stops in the page, on the first animation frame where the result is shown and the control of the next operation
 *   is enabled. A page that reloads after the save (before 3C-5 D) is measured the same way, in the new document; the
 *   result says which (`reloaded`).
 * - Also kept per run: the requests of the save (start after the click, duration); the data store's own timings when the
 *   page has them (3C-5 D, development: window.__starmapTimings — delta, official view, sharing, derivation, time
 *   context, and in ms after the click when applying began, when React had committed, when the result showed); and
 *   the browser's own durations over the run (CDP Performance.getMetrics: script, style, layout, all tasks).
 * - While the page has not yet rendered a new revision (3C-5 D: <html data-starmap-revision>), each frame looks only at
 *   that attribute, so the measurement itself adds little work to the page.
 * - Prints and writes { scale, ops: { <op>: { runs, reloaded, totalMs: stats, timings: [...] } } }.
 * - `--profile <prefix>` (diagnostics): the first run of each operation under the CPU profiler of the page; the profile
 *   goes to <prefix>-<op>.cpuprofile and the functions with the most self time are printed.
 *
 * Run it in another worktree to measure another version (it uses only the page's labels, which did not change).
 */
/* global document, window, requestAnimationFrame -- page functions run in the browser (page.evaluate) */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { MODE_BENCH_SCALES, generateRoots, stats } from './store-mode-bench.mjs'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const dir = argument('dir')
if (!dir) throw new Error('--dir <empty temp dir> is required')
const scaleName = argument('scale', 'real')
const scale = MODE_BENCH_SCALES[scaleName]
if (!scale) throw new Error(`unknown scale ${scaleName}`)
const runs = Number(argument('runs', '20'))
const ops = argument('ops', 'note,hide,order').split(',')
const out = argument('out')
const profilePrefix = argument('profile')
// --gpu: the machine's GPU (the browser's own default); without it, SwiftShader as in the browser tests.
const gpu = process.argv.includes('--gpu')

const answering = () => new Promise((resolve) => {
  const request = http.get({ host: '127.0.0.1', port: 5173, path: '/', agent: false }, (response) => { response.resume(); resolve(true) })
  request.on('error', () => resolve(false))
  request.setTimeout(5000, () => { request.destroy(); resolve(false) })
})

console.log(`generating the ${scaleName} store root…`)
await generateRoots(dir, scale)
const storeRoot = path.join(dir, 'store-root')
if (await answering()) throw new Error('Port 5173 is occupied.')
const env = { ...process.env, STARMAP_PRIVATE_ROOT: storeRoot, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '' }
for (const key of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key]
const vite = path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js')
if (!existsSync(vite)) throw new Error('vite is not installed (npm ci)')
const server = spawn(process.execPath, [vite, '--mode', 'personal', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: webRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk })
server.stderr.on('data', (chunk) => { serverLog += chunk })
const result = { scale: scaleName, runs, ops: {} }
let browser
try {
  for (let waited = 0; !(await answering()); waited++) {
    if (waited > 120) throw new Error(`the dev server did not start:\n${serverLog.slice(-2000)}`)
    await delay(500)
  }
  browser = await chromium.launch(gpu ? { args: ['--enable-gpu', '--ignore-gpu-blocklist'] } : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(180_000)
  const loading = performance.now()
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).waitFor()
  result.firstLoadMs = Math.round(performance.now() - loading)

  const profiled = new Set()
  /** The CPU profile of `work` (CDP), written to <prefix>-<op>.cpuprofile, its top self times printed. */
  async function profiling(op, work) {
    if (!profilePrefix || profiled.has(op)) return work()
    profiled.add(op)
    const session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 500 })
    await session.send('Profiler.start')
    const answer = await work()
    const { profile } = await session.send('Profiler.stop')
    await writeFile(`${profilePrefix}-${op}.cpuprofile`, JSON.stringify(profile))
    const self = new Map()
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    profile.samples.forEach((id, index) => {
      const frame = byId.get(id).callFrame
      const key = `${frame.functionName || '(anonymous)'} ${frame.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${frame.lineNumber + 1}`
      self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000)
    })
    console.log(`${op}: top self time`)
    for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${key}`)
    await session.detach()
    return answer
  }
  /** Click `buttonLabel` in the page and measure until `condition` (page function source) holds on an animation frame. */
  const measure = (op, buttonLabel, condition, args) => profiling(op, () => measureOnce(buttonLabel, condition, args))
  const metricsSession = await page.context().newCDPSession(page)
  await metricsSession.send('Performance.enable')
  const browserMetrics = async () => Object.fromEntries((await metricsSession.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
  async function measureOnce(buttonLabel, condition, args) {
    const before = await browserMetrics()
    const revisionBefore = await page.evaluate(() => document.documentElement.dataset.starmapRevision)
    const clicked = await page.evaluate(({ buttonLabel }) => {
      performance.clearResourceTimings()
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === buttonLabel || candidate.textContent?.trim() === buttonLabel)
      if (!button || button.disabled) return false
      sessionStorage.setItem('starmapBenchStart', String(performance.timeOrigin + performance.now()))
      sessionStorage.setItem('starmapBenchDocument', String(performance.timeOrigin))
      button.click()
      return true
    }, { buttonLabel })
    if (!clicked) throw new Error(`no enabled button ${buttonLabel}`)
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const answer = await page.evaluate(({ source, args, revisionBefore }) => new Promise((resolve) => {
          const check = new Function('args', `return (${source})(args)`)
          const deadline = performance.now() + 120_000
          const frame = () => {
            const moved = revisionBefore === undefined || document.documentElement.dataset.starmapRevision !== revisionBefore
            if (moved && check(args)) {
              const start = Number(sessionStorage.getItem('starmapBenchStart')) - performance.timeOrigin
              // The requests of the save (the write, a pull): when they ended after the click, and how long they took.
              const requests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= start && /__travelatlas/.test(entry.name)).map((entry) => ({ path: new URL(entry.name).pathname.replace('/__travelatlas/', '').slice(0, 40), startMs: Math.round(entry.startTime - start), ms: Math.round(entry.duration) }))
              const timings = window.__starmapTimings ? { ...window.__starmapTimings, startedAt: window.__starmapTimings.startedAt === undefined ? undefined : Math.round(window.__starmapTimings.startedAt - start), committedAt: window.__starmapTimings.committedAt === undefined ? undefined : Math.round(window.__starmapTimings.committedAt - start), shownAt: Math.round(performance.now() - start) } : null
              resolve({ requests, totalMs: performance.timeOrigin + performance.now() - Number(sessionStorage.getItem('starmapBenchStart')), reloaded: String(performance.timeOrigin) !== sessionStorage.getItem('starmapBenchDocument'), timings })
            } else if (performance.now() > deadline) resolve(undefined)
            else requestAnimationFrame(frame)
          }
          frame()
        }), { source: condition.toString(), args, revisionBefore })
        if (answer) {
          const after = await browserMetrics()
          const browser = Object.fromEntries(['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'].map((key) => [key.replace('Duration', 'Ms'), Math.round((after[key] - before[key]) * 1000)]))
          return { ...answer, totalMs: Math.round(answer.totalMs * 10) / 10, browser }
        }
        throw new Error('timed out')
      } catch (error) {
        // The page reloaded during the evaluation (before 3C-5 D): wait for the new document and look again.
        if (!/context was destroyed|navigation|Target closed|Execution context/i.test(String(error?.message))) throw error
        await page.waitForLoadState('domcontentloaded')
      }
    }
    throw new Error('the result never showed')
  }
  const goTo = async (name) => {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
  }
  const record = (op, sample) => {
    const entry = result.ops[op] ??= { samples: [] }
    entry.samples.push(sample)
    console.log(`${op} #${entry.samples.length}: ${sample.totalMs} ms${sample.reloaded ? ' (reloaded)' : ''}${sample.timings ? ` ${JSON.stringify(sample.timings)}` : ''} requests ${JSON.stringify(sample.requests)} browser ${JSON.stringify(sample.browser)}`)
  }
  // Items of the synthetic data: wish-k is on "City k" (k < cities), every 20th is hidden, odd ones have a note.
  const visibleItems = Array.from({ length: 400 }, (_, k) => k + 1).filter((k) => k % 20 !== 0)
  if (ops.includes('note')) {
    await goTo('Collection')
    for (let run = 0; run < runs; run++) {
      const name = `City ${visibleItems[run]}`
      const text = `Bench note ${run}`
      await page.getByRole('button', { name: `Edit note for ${name}`, exact: true }).click()
      await page.locator('.collection-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).locator('textarea').fill(text)
      record('note', await measure('note', `Save note for ${name}`, ({ name, text }) => {
        const card = [...document.querySelectorAll('.collection-card')].find((candidate) => candidate.querySelector('h4')?.textContent === name)
        const edit = card && [...card.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Edit note for ${name}`)
        return Boolean(card?.querySelector('.collection-card-note')?.textContent?.includes(text) && edit && !edit.disabled)
      }, { name, text }))
    }
  }
  if (ops.includes('hide')) {
    await goTo('Collection')
    for (let run = 0; run < runs; run++) {
      const name = `City ${visibleItems[runs + run]}`
      await page.getByRole('button', { name: `Hide: ${name}`, exact: true }).scrollIntoViewIfNeeded()
      record('hide', await measure('hide', `Hide: ${name}`, ({ name }) => {
        const restore = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Restore: ${name}`)
        return Boolean(restore && !restore.disabled)
      }, { name }))
    }
  }
  if (ops.includes('order')) {
    await goTo('Map')
    for (let run = 0; run < runs; run++) {
      await page.getByRole('button', { name: 'Edit visited countries', exact: true }).click()
      const first = await page.locator('.atlas-country-list [data-country-sort-id]').first().getAttribute('data-country-sort-id')
      await page.getByRole('button', { name: /^Drag to reorder / }).first().focus()
      await page.keyboard.press('ArrowDown')
      record('order', await measure('order', 'Save country changes', ({ first }) => {
        const edit = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Edit visited countries')
        const top = document.querySelector('.atlas-country-list [data-country-sort-id]')?.getAttribute('data-country-sort-id')
        return Boolean(edit && !edit.disabled && top && top !== first)
      }, { first }))
    }
  }
  for (const [op, entry] of Object.entries(result.ops)) {
    entry.reloaded = entry.samples.some((sample) => sample.reloaded)
    entry.totalMs = stats(entry.samples.map((sample) => sample.totalMs))
    for (const key of ['deltaMs', 'officialMs', 'deriveMs']) {
      const values = entry.samples.map((sample) => sample.timings?.[key]).filter((value) => typeof value === 'number')
      if (values.length) entry[key] = stats(values)
    }
    console.log(`${op}: ${JSON.stringify(entry.totalMs)}${entry.reloaded ? ' (reloads)' : ''}`)
  }
  if (out) await writeFile(out, `${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser?.close()
  server.kill()
}
