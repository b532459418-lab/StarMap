/**
 * "Save to usable" in a real browser (3C-5 D, spec §2.4; external review §5-5, D9): from the click on a save until the
 * commit is done, the page shows the data of that revision and the next operation can run. Synthetic data only.
 *
 *   node scripts/save-latency-bench.mjs --dir <empty temp dir> [--scale real|small|tiny] [--runs 20] [--ops note,hide,order,maphide,collection,collectionRestore]
 *                                       [--out result.json] [--profile <file prefix> [--profile-runs 1,2] [--react]] [--throttle N] [--gpu]
 *
 * - Generates the store root of the scale (./store-mode-bench.mjs generateRoots: real = 100 countries, 2 900 cities,
 *   6 500 visits, 3 000 want-to-go items, 10 000 media) under <dir>, starts `vite --mode personal` on 127.0.0.1:5173 on it
 *   (port 5173 must be free; proxies are not used), and drives Chromium (Playwright) in English.
 * - Operations, each `--runs` times on its own item: `note` (a want-to-go note saved in Collection), `hide` (a want-to-go
 *   item hidden in Collection), `order` (the first country moved down one place by keyboard and the country list saved),
 *   `maphide` (on the map, from the want-to-go card that "View on map" opens: the item hidden; done when its badge has
 *   left the map).
 * - 3C-5 D (A′): the map pauses during a save. "Usable" includes the map: its loop runs again and has rendered a frame
 *   since (development: window.__travelAtlasDebugRenderLoop); each run also keeps how long the map was paused.
 * - The time starts in the page when the save button is clicked (performance.timeOrigin + now, kept in sessionStorage)
 *   and stops in the page, on the first animation frame where the result is shown and the control of the next operation
 *   is enabled. A page that reloads after the save (before 3C-5 D) is measured the same way, in the new document; the
 *   result says which (`reloaded`).
 * - Also kept per run: the requests of the save (start after the click, duration); the data store's own timings when the
 *   page has them (3C-5 D, development: window.__starmapTimings — delta, official view, sharing, derivation, time
 *   context, and in ms after the click when applying began, when React had committed, when the result showed); and
 *   the browser's own durations over the run (CDP Performance.getMetrics: script, style, layout, all tasks).
 * - While the page has not yet rendered a new revision (3C-5 D: <html data-starmap-revision>), each frame looks only at
 *   that attribute; then only at the target control (attribute selectors), so the measurement adds little work.
 * - Prints and writes { scale, ops: { <op>: { runs, reloaded, totalMs: stats, timings: [...] } } }.
 * - `--profile <prefix>` (diagnostics): the first run of each operation under the CPU profiler of the page; the profile
 *   goes to <prefix>-<op>.cpuprofile and the functions with the most self time are printed.
 *
 * - 性能续: `collection` (an operation of its own): each run reloads the page (the first run is the session's first
 *   load), waits until the data and the map are there, opens Collection from the header and measures until its first
 *   card has an enabled control (`shownMs`) and until all its cards are mounted (`allMs`, as many as the list's count
 *   says), each a frame more; then the map and Collection again (the second opening). The module requests of an
 *   opening (the lazy code) are kept too. 收藏页首开: a run ends on the map, so every reload starts there and the first
 *   opening is a click from the map (the page keeps its view state in sessionStorage: a reload on Collection restores
 *   Collection, and a click on it then changes nothing). 收藏页余量: each opening waits until the map has drawn more
 *   than 10 frames and Collection's code (loaded ahead after the map's first frame) has arrived. At 81d1598 the earlier
 *   check let the click come before the map was there, with the code loaded after the click: openings measured that
 *   way are not openings from the map. `collectionBack`: after the second opening, back to the map, from the click on
 *   Map until the globe has drawn a frame (`shownMs`) and a frame more (`totalMs`).
 * - 收藏页首开: `collectionRestore`: the page reloaded while on Collection (it restores Collection); from the start of
 *   the navigation until the first card has an enabled control (`shownMs`), all cards are mounted (`allMs`) and a frame
 *   more (`totalMs`), measured in the new document from its first frame on; `dataMs` is when the data were rendered.
 * - 性能续: every run keeps its long animation frames (≥ 50 ms, with script attribution). Diagnostics: `--profile-runs
 *   1,2` (which runs are profiled), `--react` (React commits of the profiled runs through a DevTools-hook stub: render
 *   time and the self time of each component), `--throttle N` (CDP CPU throttling).
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
// 性能续 (measurement only): which runs of each operation are profiled (1-based), React commits recorded in them through
// a DevTools-hook stub (--react: self render time per component), CDP CPU throttling (--throttle 4).
const profileRuns = argument('profile-runs', '1').split(',').map(Number)
const reactProfile = process.argv.includes('--react')
const throttle = Number(argument('throttle', '0'))
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
// The author's daily configuration: no StrictMode, and not the browser tests' comparison of incremental snapshots (③).
const env = { ...process.env, STARMAP_PRIVATE_ROOT: storeRoot, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '', VITE_STARMAP_STRICT_MODE: '', VITE_STARMAP_INCREMENTAL_VERIFY: '' }
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
  // 性能续: long animation frames (≥ 50 ms, with script attribution) for every run; React commits when asked.
  await context.addInitScript(({ react }) => {
    // 收藏页余量: development loads hundreds of modules; the default buffer (250 entries) dropped the later ones, among
    // them Collection's code, which settle() looks for.
    performance.setResourceTimingBufferSize?.(20000)
    window.__benchLoaf = []
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__benchLoaf.push({
            startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: entry.scripts.map((script) => ({ invoker: script.invoker, src: script.sourceURL, fn: script.sourceFunctionName, start: script.startTime, ms: script.duration, forcedLayoutMs: script.forcedStyleAndLayoutDuration })),
          })
        }
        if (window.__benchLoaf.length > 4000) window.__benchLoaf.splice(0, 2000)
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch { /* no LoAF */ }
    // 收藏页首开 (collectionRestore): in a document the bench reloaded on Collection, from its first frame on, each frame
    // looks at the first card (a live collection) and, once it is there, at the count of the list.
    if (sessionStorage.getItem('starmapBenchRestore') === '1') {
      sessionStorage.removeItem('starmapBenchRestore')
      const restore = window.__benchRestore = {}
      const cards = document.getElementsByClassName('collection-card')
      const frame = () => {
        const now = performance.now()
        if (restore.dataMs === undefined && document.documentElement.dataset.starmapRevision !== undefined) restore.dataMs = now
        if (restore.shownMs === undefined && cards[0]?.querySelector('button:not([disabled])')) restore.shownMs = now
        if (restore.shownMs !== undefined) {
          const expected = Number((document.querySelector('.collection-section-count')?.textContent ?? '').match(/[\d,]+/)?.[0].replace(/,/g, ''))
          if (!(expected > 0) || cards.length >= expected) {
            restore.allMs = now
            restore.cards = cards.length
            requestAnimationFrame(() => { restore.totalMs = performance.now() })
            return
          }
        }
        if (now < 170_000) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }
    if (!react) return
    // A DevTools hook (Vite's React Refresh wraps it): per commit, the self render time of each component that rendered
    // (React's development build keeps actualDuration), as React DevTools' profiler computes it.
    const state = { recording: false, byName: new Map(), commits: [] }
    const nameOf = (fiber) => {
      const type = fiber.type
      if (!type || typeof type === 'string') return null
      return type.displayName || type.name || type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name || null
    }
    let nextId = 1
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(), supportsFiber: true,
      inject(renderer) { const id = nextId++; this.renderers.set(id, renderer); return id },
      onScheduleFiberRoot() {}, onCommitFiberUnmount() {},
      onPostCommitFiberRoot() { if (state.recording && state.commits.length) state.commits.at(-1).postAt = performance.now() },
      onCommitFiberRoot(id, root) {
        if (!state.recording) return
        const at = performance.now()
        let rendered = 0
        const stack = [root.current]
        while (stack.length) {
          const fiber = stack.pop()
          const didRender = fiber.alternate === null || (fiber.flags & 1) === 1
          if (didRender && [0, 1, 11, 14, 15].includes(fiber.tag)) {
            rendered++
            let self = fiber.actualDuration ?? 0
            for (let child = fiber.child; child; child = child.sibling) self -= child.actualDuration || 0
            const name = nameOf(fiber) ?? `tag${fiber.tag}`
            const entry = state.byName.get(name) ?? { selfMs: 0, renders: 0 }
            entry.selfMs += self
            entry.renders++
            state.byName.set(name, entry)
          }
          // A subtree without work keeps the children of the previous tree.
          if (fiber.alternate !== null && fiber.child === fiber.alternate.child) continue
          for (let child = fiber.child; child; child = child.sibling) stack.push(child)
        }
        state.commits.push({ at, renderMs: root.current.actualDuration, rendered, walkMs: performance.now() - at })
      },
      checkDCE() {},
    }
    window.__benchReact = {
      start() { state.recording = true; state.byName.clear(); state.commits.length = 0; state.origin = performance.now() },
      stop() {
        state.recording = false
        return {
          commits: state.commits.map((commit) => ({ atMs: Math.round(commit.at - state.origin), renderMs: Math.round(commit.renderMs * 10) / 10, rendered: commit.rendered, passiveMs: commit.postAt ? Math.round(commit.postAt - commit.at) : undefined, walkMs: Math.round(commit.walkMs) })),
          components: [...state.byName].map(([name, entry]) => ({ name, selfMs: Math.round(entry.selfMs * 10) / 10, renders: entry.renders })).sort((a, b) => b.selfMs - a.selfMs),
        }
      },
    }
  }, { react: reactProfile })
  const page = await context.newPage()
  page.setDefaultTimeout(180_000)
  if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle })
  const loading = performance.now()
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).waitFor()
  result.firstLoadMs = Math.round(performance.now() - loading)

  /** The CPU profile of `work` (CDP), written to <prefix>-<op>-<run>.cpuprofile, its top self times printed. */
  async function profiling(op, work) {
    const run = (result.ops[op]?.samples.length ?? 0) + 1
    if (!profilePrefix || !profileRuns.includes(run)) return work()
    const session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 500 })
    if (reactProfile) await page.evaluate(() => window.__benchReact?.start())
    await session.send('Profiler.start')
    const answer = await work()
    const { profile } = await session.send('Profiler.stop')
    await writeFile(`${profilePrefix}-${op}-${run}.cpuprofile`, JSON.stringify(profile))
    if (reactProfile) {
      const react = await page.evaluate(() => window.__benchReact?.stop())
      await writeFile(`${profilePrefix}-${op}-${run}.react.json`, `${JSON.stringify(react, null, 1)}\n`)
      if (react) {
        console.log(`${op} #${run}: React commits ${JSON.stringify(react.commits)}`)
        for (const component of react.components.slice(0, 25)) console.log(`  react ${String(component.selfMs).padStart(8)} ms  ${String(component.renders).padStart(6)}x  ${component.name}`)
      }
    }
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
    const pausesBefore = await page.evaluate(() => window.__travelAtlasDebugRenderLoop?.state().episodes.length)
    const clicked = await page.evaluate(({ buttonLabel }) => {
      performance.clearResourceTimings()
      // `css:<selector>`: the button by a selector (a label shared by buttons of several pages).
      const button = buttonLabel.startsWith('css:') ? document.querySelector(buttonLabel.slice(4))
        : [...document.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === buttonLabel || candidate.textContent?.trim() === buttonLabel)
      if (!button || button.disabled) return false
      sessionStorage.setItem('starmapBenchStart', String(performance.timeOrigin + performance.now()))
      sessionStorage.setItem('starmapBenchDocument', String(performance.timeOrigin))
      button.click()
      return true
    }, { buttonLabel })
    if (!clicked) throw new Error(`no enabled button ${buttonLabel}`)
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const answer = await page.evaluate(({ source, args, revisionBefore, pausesBefore }) => new Promise((resolve) => {
          const check = new Function('args', `return (${source})(args)`)
          const deadline = performance.now() + 120_000
          // The map (A′): not paused, and a frame rendered since the last pause ended.
          const mapRendering = () => {
            const loop = window.__travelAtlasDebugRenderLoop?.state()
            return !loop || (!loop.paused && loop.frames > loop.framesAtResume)
          }
          const frame = () => {
            const moved = revisionBefore === undefined || document.documentElement.dataset.starmapRevision !== revisionBefore
            if (moved && check(args) && mapRendering()) {
              const loop = window.__travelAtlasDebugRenderLoop?.state()
              const pauses = loop && pausesBefore !== undefined ? loop.episodes.slice(pausesBefore) : undefined
              const start = Number(sessionStorage.getItem('starmapBenchStart')) - performance.timeOrigin
              // The requests of the save (the write, a pull): when they ended after the click, and how long they took.
              const requests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= start && /__travelatlas/.test(entry.name)).map((entry) => ({ path: new URL(entry.name).pathname.replace('/__travelatlas/', '').slice(0, 40), startMs: Math.round(entry.startTime - start), ms: Math.round(entry.duration) }))
              const timings = window.__starmapTimings ? { ...window.__starmapTimings, startedAt: window.__starmapTimings.startedAt === undefined ? undefined : Math.round(window.__starmapTimings.startedAt - start), committedAt: window.__starmapTimings.committedAt === undefined ? undefined : Math.round(window.__starmapTimings.committedAt - start), shownAt: Math.round(performance.now() - start) } : null
              resolve({ pauses, requests, totalMs: performance.timeOrigin + performance.now() - Number(sessionStorage.getItem('starmapBenchStart')), reloaded: String(performance.timeOrigin) !== sessionStorage.getItem('starmapBenchDocument'), timings })
            } else if (performance.now() > deadline) resolve(undefined)
            else requestAnimationFrame(frame)
          }
          frame()
        }), { source: condition.toString(), args, revisionBefore, pausesBefore })
        if (answer) {
          const after = await browserMetrics()
          const browser = Object.fromEntries(['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'].map((key) => [key.replace('Duration', 'Ms'), Math.round((after[key] - before[key]) * 1000)]))
          const longFrames = answer.reloaded ? undefined : await longFramesSince(Number(await page.evaluate(() => sessionStorage.getItem('starmapBenchStart'))), answer.totalMs)
          return { ...answer, totalMs: Math.round(answer.totalMs * 10) / 10, browser, longFrames }
        }
        // Diagnostics: what the page shows when the result never came.
        if (out) await page.screenshot({ path: `${out}.timeout.png` })
        throw new Error(`timed out: ${(await page.locator('body').innerText()).split(/[ \n\t]+/).join(' ').slice(0, 1500)}`)
      } catch (error) {
        // The page reloaded during the evaluation (before 3C-5 D): wait for the new document and look again.
        if (!/context was destroyed|navigation|Target closed|Execution context/i.test(String(error?.message))) throw error
        await page.waitForLoadState('domcontentloaded')
      }
    }
    throw new Error('the result never showed')
  }
  /** 性能续: the long animation frames from `startEpoch` (ms since the epoch) for `totalMs`: count, sum, max, the 4 longest. */
  async function longFramesSince(startEpoch, totalMs) {
    await delay(150)
    return page.evaluate(({ startEpoch, totalMs }) => {
      const start = startEpoch - performance.timeOrigin
      const short = (src) => (src || '').replace(/^.*\/(src|node_modules|@fs)\//, '$1/').replace(/\?.*$/, '')
      const frames = (window.__benchLoaf ?? []).filter((frame) => frame.startTime + frame.duration >= start && frame.startTime <= start + totalMs)
      return {
        count: frames.length,
        sumMs: Math.round(frames.reduce((sum, frame) => sum + frame.duration, 0)),
        maxMs: Math.round(Math.max(0, ...frames.map((frame) => frame.duration))),
        longest: [...frames].sort((a, b) => b.duration - a.duration).slice(0, 4).map((frame) => ({
          atMs: Math.round(frame.startTime - start), ms: Math.round(frame.duration), blockingMs: Math.round(frame.blockingDuration),
          renderMs: frame.renderStart ? Math.round(frame.startTime + frame.duration - frame.renderStart) : 0,
          styleLayoutMs: frame.styleAndLayoutStart ? Math.round(frame.startTime + frame.duration - frame.styleAndLayoutStart) : 0,
          scripts: [...frame.scripts].sort((a, b) => b.ms - a.ms).slice(0, 3).map((script) => `${script.invoker} ${short(script.src)}:${script.fn} ${Math.round(script.ms)}ms${script.forcedLayoutMs > 1 ? ` (forced layout ${Math.round(script.forcedLayoutMs)}ms)` : ''}`),
        })),
      }
    }, { startEpoch, totalMs })
  }
  /** 性能续: Collection opened from the header, from the click until its first card has an enabled control and a frame more. */
  async function openCollection() {
    const before = await browserMetrics()
    const answer = await page.evaluate(() => new Promise((resolve) => {
      const nav = [...document.querySelectorAll('nav button')].find((button) => button.textContent?.trim() === 'Collection')
      if (!nav) { resolve(undefined); return }
      // A live collection: each frame reads its first item instead of searching the whole document (a full search per
      // frame cost about 1.5 s of the main thread over a first opening in the profile).
      const cards = document.getElementsByClassName('collection-card')
      // The module requests of the opening (the page's lazy code): the buffer is emptied and enlarged first.
      performance.setResourceTimingBufferSize?.(5000)
      performance.clearResourceTimings()
      sessionStorage.setItem('starmapBenchStart', String(performance.timeOrigin + performance.now()))
      const start = performance.now()
      nav.click()
      let shownMs
      const done = (allMs) => {
        const modules = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= start && /\/(src|node_modules|@fs|@id)\//.test(entry.name))
        resolve({ totalMs: performance.now() - start, shownMs: Math.round(shownMs), allMs: Math.round(allMs), cards: cards.length,
          modules: { count: modules.length, lastEndMs: Math.round(Math.max(0, ...modules.map((entry) => entry.responseEnd)) - (modules.length ? start : 0)) } })
      }
      const frame = () => {
        if (shownMs === undefined && cards[0]?.querySelector('button:not([disabled])')) shownMs = performance.now() - start
        if (shownMs !== undefined) {
          // All cards mounted: as many as the list's count says (a frame more, like the first card).
          const expected = Number((document.querySelector('.collection-section-count')?.textContent ?? '').match(/[\d,]+/)?.[0].replace(/,/g, ''))
          if (!(expected > 0) || cards.length >= expected) {
            const allMs = performance.now() - start
            requestAnimationFrame(() => done(allMs))
            return
          }
        }
        if (performance.now() - start > 170_000) resolve(undefined)
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }))
    if (!answer) throw new Error('Collection did not open')
    const after = await browserMetrics()
    const browser = Object.fromEntries(['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'].map((key) => [key.replace('Duration', 'Ms'), Math.round((after[key] - before[key]) * 1000)]))
    const longFrames = await longFramesSince(Number(await page.evaluate(() => sessionStorage.getItem('starmapBenchStart'))), answer.totalMs)
    return { ...answer, totalMs: Math.round(answer.totalMs * 10) / 10, browser, longFrames }
  }
  /**
   * 收藏页余量: from Collection back to the map, from the click on Map until the globe has drawn a frame since (its frame
   * counter, development only: `shownMs`, also `allMs`) and a frame more (`totalMs`).
   */
  async function backToMap() {
    const before = await browserMetrics()
    const answer = await page.evaluate(() => new Promise((resolve) => {
      const nav = [...document.querySelectorAll('nav button')].find((button) => button.textContent?.trim() === 'Map')
      const frames = () => window.__travelAtlasDebugRenderLoop?.state().frames
      if (!nav || frames() === undefined) { resolve(undefined); return }
      const framesBefore = frames()
      sessionStorage.setItem('starmapBenchStart', String(performance.timeOrigin + performance.now()))
      const start = performance.now()
      nav.click()
      const frame = () => {
        if (frames() > framesBefore) {
          const drawnMs = performance.now() - start
          requestAnimationFrame(() => resolve({ totalMs: performance.now() - start, shownMs: Math.round(drawnMs), allMs: Math.round(drawnMs) }))
          return
        }
        if (performance.now() - start > 60_000) resolve(undefined)
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }))
    if (!answer) throw new Error('the map did not draw after Collection')
    const after = await browserMetrics()
    const browser = Object.fromEntries(['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'].map((key) => [key.replace('Duration', 'Ms'), Math.round((after[key] - before[key]) * 1000)]))
    const longFrames = await longFramesSince(Number(await page.evaluate(() => sessionStorage.getItem('starmapBenchStart'))), answer.totalMs)
    return { ...answer, totalMs: Math.round(answer.totalMs * 10) / 10, browser, longFrames }
  }
  /**
   * 性能续: the page has its data and the map has drawn frames; then a second of quiet. 收藏页余量: the map must be there
   * (its debug object, development only, and more than 10 frames: at 81d1598 the globe appears 4-5 s after the data, and
   * the earlier check let the click come before it, when Collection's code, loaded ahead after the map's first frame, was
   * not there yet), and Collection's code has arrived (its request ended, or Collection is already mounted).
   */
  async function settle() {
    await page.waitForFunction(() => document.documentElement.dataset.starmapRevision !== undefined
      && window.__travelAtlasDebugRenderLoop !== undefined && window.__travelAtlasDebugRenderLoop.state().frames > 10
      && (document.querySelector('.collection-card') !== null
        || performance.getEntriesByType('resource').some((entry) => entry.name.includes('/src/components/CollectionPage.tsx') && entry.responseEnd > 0)),
    undefined, { timeout: 170_000 })
    await delay(1000)
  }
  const goTo = async (name) => {
    const opening = name === 'Collection' && result.collectionOpenMs === undefined ? performance.now() : undefined
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    if (opening === undefined) return
    // The first opening of Collection (it mounts every card): until its cards are there and a frame has been drawn.
    await page.locator('.collection-card').first().waitFor()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    result.collectionOpenMs = Math.round(performance.now() - opening)
    console.log(`Collection opened in ${result.collectionOpenMs} ms`)
  }
  const record = (op, sample) => {
    const entry = result.ops[op] ??= { samples: [] }
    entry.samples.push(sample)
    console.log(`${op} #${entry.samples.length}: ${sample.totalMs} ms${sample.reloaded ? ' (reloaded)' : ''}${sample.pauses ? ` paused ${JSON.stringify(sample.pauses)}` : ''}${sample.timings ? ` ${JSON.stringify(sample.timings)}` : ''} requests ${JSON.stringify(sample.requests)} browser ${JSON.stringify(sample.browser)}${sample.cards ? ` cards ${sample.cards} shown ${sample.shownMs} ms all ${sample.allMs} ms${sample.modules ? ` modules ${JSON.stringify(sample.modules)}` : ''}${sample.dataMs !== undefined ? ` data ${sample.dataMs} ms` : ''}` : ''}${sample.longFrames ? ` long frames ${JSON.stringify(sample.longFrames)}` : ''}`)
  }
  // 性能续: Collection opened for the first time after a page load (each run reloads the page, the first run is the
  // first load of the session), then a second time after the map.
  if (ops.includes('collection')) {
    for (let run = 0; run < runs; run++) {
      if (run > 0) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).waitFor()
      }
      await settle()
      record('collectionFirst', await profiling('collectionFirst', () => openCollection()))
      await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
      await settle()
      record('collectionSecond', await profiling('collectionSecond', () => openCollection()))
      // 收藏页首开: back on the map (its view state is what the next reload restores), so that the next first opening is
      // a click from the map too. 收藏页余量: that way back is measured (`collectionBack`).
      record('collectionBack', await profiling('collectionBack', () => backToMap()))
      await page.waitForFunction(() => document.querySelector('.atlas-experience')?.getAttribute('data-page') === 'map')
      await delay(500)
    }
  }
  // 收藏页首开: the page reloaded while on Collection (it restores Collection), from the navigation until its cards.
  if (ops.includes('collectionRestore')) {
    if (await page.evaluate(() => document.querySelector('.atlas-experience')?.getAttribute('data-page')) !== 'collection') {
      await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
      await page.locator('.collection-card').first().waitFor()
    }
    for (let run = 0; run < runs; run++) {
      await settle()
      await page.evaluate(() => sessionStorage.setItem('starmapBenchRestore', '1'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      const restore = await (await page.waitForFunction(() => window.__benchRestore?.totalMs !== undefined && window.__benchRestore, undefined, { timeout: 170_000 })).jsonValue()
      const longFrames = await longFramesSince(await page.evaluate(() => performance.timeOrigin), restore.totalMs)
      record('collectionRestore', { totalMs: Math.round(restore.totalMs * 10) / 10, shownMs: Math.round(restore.shownMs), allMs: Math.round(restore.allMs), dataMs: Math.round(restore.dataMs ?? NaN), cards: restore.cards, longFrames })
    }
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
        // Only the target card is looked at (an attribute selector, not every card in script). It is the want-to-go card of
        // the place: a planned entry of the same place has the same heading, and no note button.
        const edit = document.querySelector(`.collection-card button[aria-label=${JSON.stringify(`Edit note for ${name}`)}]`)
        const card = edit?.closest('.collection-card')
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
        const restore = document.querySelector(`button[aria-label=${JSON.stringify(`Restore: ${name}`)}]`)
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
        const edit = document.querySelector('button[aria-label="Edit visited countries"]')
        const top = document.querySelector('.atlas-country-list [data-country-sort-id]')?.getAttribute('data-country-sort-id')
        return Boolean(edit && !edit.disabled && top && top !== first)
      }, { first }))
    }
  }
  if (ops.includes('maphide')) {
    for (let run = 0; run < runs; run++) {
      // Places without a planned record (./store-mode-bench.mjs: the city of plan-n is (7n mod cities)): only the hidden
      // item put them on the want-to-go layer, so the badge leaves the map. Taken from the end (not the other runs' items).
      const k = visibleItems.filter((item) => item % 7 !== 0 && item % 7 !== 5).at(-1 - run)
      const name = `City ${k}`
      // The place's entity id is its place id (./store-mode-bench.mjs syntheticV2Files: the cities follow the countries).
      const entityId = `01920000-0000-7000-8000-${(scale.countries + k).toString(16).padStart(12, '0')}`
      await goTo('Collection')
      const card = page.locator('.collection-card').filter({ has: page.getByRole('button', { name: `Edit note for ${name}`, exact: true }) })
      await card.getByRole('button', { name: `View on map: ${name}`, exact: true }).click()
      await page.locator('.atlas-wtg-card .atlas-wtg-card-hide').waitFor()
      // The camera has arrived and the badge is on the map before the save (a version without the debug API, before
      // 3C-5 D: the card is enough; the page reloads after the save).
      await page.waitForFunction((id) => !window.__travelAtlasDebugRenderLoop || window.__travelAtlasDebugRenderLoop.entityShowing(id).badge, entityId, { timeout: 20_000 })
      await page.waitForTimeout(500)
      record('maphide', await measure('maphide', 'css:.atlas-wtg-card .atlas-wtg-card-hide', ({ entityId }) => {
        const loop = window.__travelAtlasDebugRenderLoop
        // The map page is usable (its country list and editor toggle are there: after a reload too) and the card is gone.
        const edit = document.querySelector('button[aria-label="Edit visited countries"]')
        const usable = Boolean(edit && !edit.disabled && document.querySelector('.atlas-country-list [data-country-sort-id]'))
        return usable && !document.querySelector('.atlas-wtg-card') && (!loop || !loop.entityShowing(entityId).badge)
      }, { entityId }))
    }
  }
  for (const [op, entry] of Object.entries(result.ops)) {
    entry.reloaded = entry.samples.some((sample) => sample.reloaded)
    entry.totalMs = stats(entry.samples.map((sample) => sample.totalMs))
    for (const key of ['deltaMs', 'officialMs', 'deriveMs']) {
      const values = entry.samples.map((sample) => sample.timings?.[key]).filter((value) => typeof value === 'number')
      if (values.length) entry[key] = stats(values)
    }
    // How long the map was paused during each run (A′).
    const paused = entry.samples.filter((sample) => sample.pauses).map((sample) => sample.pauses.reduce((sum, pause) => sum + pause.pausedMs, 0))
    if (paused.length) entry.pausedMs = stats(paused)
    for (const key of ['shownMs', 'allMs', 'dataMs']) {
      const values = entry.samples.map((sample) => sample[key]).filter((value) => typeof value === 'number')
      if (values.length) entry[key] = stats(values)
    }
    const longest = entry.samples.filter((sample) => sample.longFrames).map((sample) => sample.longFrames.maxMs)
    if (longest.length) entry.longestFrameMs = stats(longest)
    console.log(`${op}: ${JSON.stringify(entry.totalMs)}${entry.reloaded ? ' (reloads)' : ''}${entry.pausedMs ? ` map paused ${JSON.stringify(entry.pausedMs)}` : ''}${entry.longestFrameMs ? ` longest frame ${JSON.stringify(entry.longestFrameMs)}` : ''}${entry.shownMs ? ` shown ${JSON.stringify(entry.shownMs)} all ${JSON.stringify(entry.allMs)}` : ''}`)
  }
  if (out) await writeFile(out, `${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser?.close()
  server.kill()
}
