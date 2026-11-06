import { test as base, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readFixtureFiles } from '../../scripts/browser-fixture.mjs'

const reloadObservations = new WeakMap()
const mediaPhases = new WeakMap()
const mediaTests = new WeakMap()
const screenshotObservations = new WeakMap()
const diagnosticFiles = new Set(['critical-flows.spec.mjs', 'time-filter-boundaries.spec.mjs', 'time-filter-camera.spec.mjs', 'time-filters.spec.mjs'])
const safePath = value => {
  try { const url = new URL(value); return url.origin === 'http://127.0.0.1:5173' ? url.pathname : '[other origin]' } catch { return '[invalid URL]' }
}
const safeMessage = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, safePath).slice(0, 1200)
function screenshotEvent(state, event) {
  if (state.events.length < 32) state.events.push({ at: Date.now(), elapsedMs: performance.now() - state.startedAt, ...event })
  else state.droppedEvents++
}
async function saveScreenshotObservations(state, testInfo) {
  // A timed-out body can finish while afterEach is closing the page. Serialize
  // writes, and collect the latest state inside the queued job, not at enqueue.
  const prior = state.writes ?? Promise.resolve()
  const write = prior.then(async () => {
    try {
      const target = testInfo.outputPath('screenshot-observations.json')
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify({ test: testInfo.title, testStatusAtCollection: testInfo.status,
        events: state.events, droppedEvents: state.droppedEvents, pendingReadonlyRequests: state.pending.size,
        screenshotOptionsUnchanged: true, diagnosticDeadlineIsNotRpcCancellation: true }, null, 2) + '\n')
      await testInfo.attach('Screenshot phase observations', { path: target, contentType: 'application/json' })
    } catch (error) { console.warn('Screenshot evidence unavailable:', safeMessage(error.message)) }
  })
  state.writes = write
  await write
}
async function screenshotFailureState(page, state) {
  if (state.suppressSnapshots) return { unavailable: 'Further snapshots disabled after diagnostic deadline' }
  const request = page.evaluate(() => {
    const bounds = node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        display: style.display, visibility: style.visibility, opacity: style.opacity, transform: style.transform }
    }
    let activePage
    try { activePage = JSON.parse(sessionStorage.getItem('starmap:view-state:v1') ?? 'null')?.activePage } catch { activePage = 'unreadable' }
    const animations = document.getAnimations()
    return { observedAt: Date.now(), readyState: document.readyState, visibility: document.visibilityState,
      activePage, fontsStatus: document.fonts.status, viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
      layout: ['main', '.atlas-experience', '.atlas-journey-stage'].map(selector => {
        const node = document.querySelector(selector); return { selector, bounds: node ? bounds(node) : null }
      }),
      canvases: [...document.querySelectorAll('canvas')].slice(0, 4).map(node => ({ width: node.width, height: node.height,
        clientWidth: node.clientWidth, clientHeight: node.clientHeight, bounds: bounds(node) })),
      animationCount: animations.length, animations: animations.slice(0, 16).map(animation => {
        const timing = animation.effect?.getTiming()
        return { playState: animation.playState, currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : null,
          targetTag: animation.effect?.target?.tagName, duration: String(timing?.duration), iterations: String(timing?.iterations) }
      }) }
  })
  state.pending.add(request)
  void request.then(() => state.pending.delete(request), () => state.pending.delete(request))
  let timer
  try {
    return await Promise.race([request, new Promise(resolve => { timer = setTimeout(() => {
      state.suppressSnapshots = true
      resolve({ unavailable: '1500ms diagnostic deadline; original RPC may still be pending' })
    }, 1500) })])
  } catch (error) { return { unavailable: safeMessage(error.message) } }
  finally { clearTimeout(timer) }
}
/** Preserve the real screenshot's original options, buffer and error. Normal
 * capture sends no additional browser queries; sampling happens only on failure.
 */
export async function screenshotWithObservations(page, testInfo, options) {
  const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Screenshot observations require isolated synthetic data.')
  let state = screenshotObservations.get(page)
  if (!state) {
    state = { startedAt: performance.now(), events: [], droppedEvents: 0, pending: new Set(), suppressSnapshots: false }
    screenshotObservations.set(page, state)
  }
  const filename = typeof options?.path === 'string' ? path.basename(options.path) : null
  // Test stability F5-1: capture once the page keeps up (its frames come at their usual pace again).
  const keptUp = await pageKeepsUp(page)
  screenshotEvent(state, { phase: 'page keeps up', ...keptUp })
  // F5-2: a bounded scheduler trace of the capture, kept only when it fails.
  await armSchedulerTrace(page)
  let failed = false
  const started = performance.now()
  screenshotEvent(state, { phase: 'capture started', filename,
    explicitTimeoutMs: options?.timeout ?? null, configuredActionTimeoutMs: testInfo.project.use.actionTimeout ?? null })
  try {
    const buffer = await page.screenshot(options)
    const durationMs = performance.now() - started
    screenshotEvent(state, { phase: 'capture returned', durationMs, bytes: buffer.length })
    // F5-2: the capture's duration in every run's log, so that CI shows its usual range.
    console.info('Screenshot', JSON.stringify({ filename, durationMs: Math.round(durationMs), waitedForPageMs: keptUp.waitedMs, keptUp: keptUp.keptUp }))
    return buffer
  } catch (error) {
    failed = true
    screenshotEvent(state, { phase: 'capture rejected', durationMs: performance.now() - started, error: safeMessage(error.message) })
    try { screenshotEvent(state, { phase: 'failure-only readonly snapshot', snapshot: await screenshotFailureState(page, state) }) }
    catch (diagnosticError) { screenshotEvent(state, { phase: 'snapshot unavailable', error: safeMessage(diagnosticError.message) }) }
    throw error
  } finally {
    await finishSchedulerTrace(page, testInfo, { retain: failed, name: 'screenshot-scheduler', label: 'Screenshot scheduler trace' })
    await saveScreenshotObservations(state, testInfo)
  }
}
/**
 * Test stability F5-1: before the evidence screenshot, wait until `frames` animation frames in a row each came within
 * `frameIntervalMs` of the one before (at most `timeoutMs`; the capture follows either way, with the wait recorded). The
 * capture that timed out on CI (2026-11-05, time 2/3) started while the page drew a frame only every 2.4-5.4 s (its
 * trace's screencast frames); before and after that, frames came every 0.3-0.8 s, as the globe's frames do on CI's
 * software GL (the A′ cases' CPU profiles: every 0.25-0.7 s).
 */
const PAGE_KEEPS_UP = Object.freeze({ frames: 3, frameIntervalMs: 1000, timeoutMs: 15000 })
async function pageKeepsUp(page) {
  const started = performance.now()
  const seen = await page.evaluate(({ frames, frameIntervalMs, timeoutMs }) => new Promise((resolve) => {
    const intervals = []
    let previous
    let done = false
    const finish = (keptUp) => {
      if (done) return
      done = true
      resolve({ keptUp, intervals: intervals.slice(-8).map((interval) => Math.round(interval)) })
    }
    setTimeout(() => finish(false), timeoutMs)
    const frame = (at) => {
      if (done) return
      if (previous !== undefined) intervals.push(at - previous)
      previous = at
      if (intervals.length >= frames && intervals.slice(-frames).every((interval) => interval <= frameIntervalMs)) finish(true)
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }), PAGE_KEEPS_UP).catch((error) => ({ keptUp: false, error: safeMessage(error.message) }))
  return { ...seen, waitedMs: Math.round(performance.now() - started) }
}
/** A diagnostic RPC's answer within 1.5 s, or a rejection; the deadline discards a late answer, it does not cancel the RPC. */
export const diagnosticDeadline = (request) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Render profile diagnostic deadline')), 1500)
  request.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
})
const schedulerTraces = new WeakMap()
/**
 * The trace's ring buffer. 3 MB since the A′ trace is armed before the settled-map wait (D3): at 1 MB a failed case kept
 * only its last ~9 s of events (CI, 2026-11-06, run 42187578007: 2.9 MB of JSON, 14 640 events), which no longer reached
 * back to the save's click, 11 s before the end. 3 MB keeps about three times that and stays under the caps below
 * (16 MB of JSON, 60 000 events).
 */
const SCHEDULER_TRACE_BUFFER_KB = 3072
const schedulerCategories = ['gpu', 'cc', 'viz', 'renderer.scheduler', 'devtools.timeline', 'disabled-by-default-devtools.timeline.frame']
/**
 * A bounded Chromium trace of the scheduler, GPU and compositor (gpu, cc, viz, frames), armed before an action and kept
 * only when it is wanted (diagnostic only: no trace arguments, sources, URLs or machine data are kept). First used by the
 * A′ cases (critical-flows.spec.mjs); test stability F5-2 uses it around the Journey evidence screenshot.
 */
export async function armSchedulerTrace(page) {
  let session
  try {
    session = await page.context().browser().newBrowserCDPSession()
    const entry = { session, active: true }
    entry.complete = new Promise((resolve) => { entry.completed = resolve })
    session.once('Tracing.tracingComplete', entry.completed)
    schedulerTraces.set(page, entry)
    entry.armedBefore = { monotonicMs: performance.now(), wallMs: Date.now() }
    await session.send('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json',
      traceConfig: { recordMode: 'recordContinuously', traceBufferSizeInKb: SCHEDULER_TRACE_BUFFER_KB, enableSampling: false,
        enableSystrace: false, enableArgumentFilter: true, includedCategories: schedulerCategories } })
    entry.armedAfter = { monotonicMs: performance.now(), wallMs: Date.now() }
  } catch (error) {
    const entry = schedulerTraces.get(page)
    if (entry?.completed) session?.off('Tracing.tracingComplete', entry.completed)
    if (entry) entry.active = false
    schedulerTraces.set(page, { session, setupFailure: error.name })
  }
}
/**
 * Ends the trace of `armSchedulerTrace`. `retain` (by default: the case failed) keeps it as `<name>.json`, attached as
 * `label`; otherwise it is discarded. A wanted trace that cannot be had leaves `<name>-unavailable.json`.
 */
export async function finishSchedulerTrace(page, info, {
  retain = info && info.status !== info.expectedStatus, name = 'render-recovery-scheduler', label = 'Render recovery scheduler trace',
} = {}) {
  const entry = schedulerTraces.get(page)
  if (!entry) return
  schedulerTraces.delete(page)
  try {
    entry.stage = 'setup'
    if (entry.setupFailure) throw Object.assign(new Error('Render scheduler trace unavailable'), { name: entry.setupFailure })
    const collect = async () => {
      const stoppingAt = { monotonicMs: performance.now(), wallMs: Date.now() }
      entry.collectionStartedMs = stoppingAt.monotonicMs
      entry.stage = 'stop'
      await entry.session.send('Tracing.end')
      entry.stage = 'completion'
      const { stream, dataLossOccurred } = await entry.complete
      const completedAt = { monotonicMs: performance.now(), wallMs: Date.now() }
      try {
        if (!retain || !entry.active) return undefined
        let bytes = 0
        const chunks = []
        entry.stage = 'read'
        for (;;) {
          const part = await entry.session.send('IO.read', { handle: stream, size: 262144 })
          if (!entry.active) return undefined
          const buffer = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8')
          bytes += buffer.length
          entry.receivedBytes = bytes
          if (bytes > 16000000) throw new Error('Render scheduler trace exceeds16MB')
          chunks.push(buffer)
          if (part.eof) break
        }
        entry.stage = 'parse'
        const { traceEvents } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!Array.isArray(traceEvents) || traceEvents.length > 60000) throw new Error('Render scheduler event cap exceeded')
        entry.stage = 'sanitize'
        const clean = traceEvents.map((event) => {
          // Keep event timing/flow identities, never arbitrary trace arguments, source, URLs or machine metadata.
          const result = {}
          for (const key of ['pid', 'tid', 'ts', 'dur', 'tts', 'tdur']) if (Number.isFinite(event[key])) result[key] = event[key]
          for (const key of ['ph', 'name', 'cat', 's', 'bp']) if (typeof event[key] === 'string') {
            result[key] = event[key].replace(/https?:\/\/[^\s]+|[A-Za-z]:[\\/][^\s]+|\/(?:Users|home|tmp|private|var)\/[^\s]+/g, '[path]').slice(0, 240)
          }
          for (const key of ['id', 'bind_id']) if (typeof event[key] === 'number'
            || (typeof event[key] === 'string' && /^[a-z0-9x]{1,80}$/i.test(event[key]))) result[key] = event[key]
          if (event.id2 && typeof event.id2 === 'object') {
            result.id2 = Object.fromEntries(Object.entries(event.id2).filter(([key, value]) => ['local', 'global'].includes(key)
              && (typeof value === 'number' || (typeof value === 'string' && /^[a-z0-9x]{1,80}$/i.test(value)))))
          }
          if (event.ph === 'M' && ['process_name', 'thread_name'].includes(event.name) && typeof event.args?.name === 'string') {
            result.args = { name: event.args.name.replace(/[^a-zA-Z0-9_ :.-]/g, '_').slice(0, 120) }
          }
          return result
        })
        let firstEventUs, lastEventUs
        for (const event of clean) if (event.ph !== 'M' && Number.isFinite(event.ts) && event.ts > 0) {
          firstEventUs = firstEventUs === undefined ? event.ts : Math.min(firstEventUs, event.ts)
          lastEventUs = lastEventUs === undefined ? event.ts : Math.max(lastEventUs, event.ts)
        }
        return { format: 'starmap.render-scheduler-trace', traceEvents: clean, armedBefore: entry.armedBefore,
          armedAfter: entry.armedAfter, categories: schedulerCategories, nativeBufferKb: SCHEDULER_TRACE_BUFFER_KB, rawBytes: bytes,
          stoppingAt, completedAt, firstEventUs, lastEventUs, dataLossOccurred,
          timingAlignmentHasProtocolUncertainty: true, diagnosticOnly: true }
      } finally { await entry.session.send('IO.close', { handle: stream }).catch(() => {}) }
    }
    const trace = await diagnosticDeadline(collect())
    if (!trace || !retain) return
    const text = JSON.stringify(trace)
    if (Buffer.byteLength(text) > 16000000) throw new Error('Sanitized render scheduler trace exceeds16MB')
    const destination = info.outputPath(`${name}.json`)
    entry.stage = 'retain'
    await writeFile(destination, text)
    await info.attach(label, { path: destination, contentType: 'application/json' })
  } catch (error) {
    if (retain) await writeFile(info.outputPath(`${name}-unavailable.json`), JSON.stringify({
      format: 'starmap.render-scheduler-unavailable', errorName: error.name,
      stage: entry.stage, receivedBytes: entry.receivedBytes,
      elapsedCollectionMs: entry.collectionStartedMs === undefined ? undefined : performance.now() - entry.collectionStartedMs,
      reason: error.message === 'Render profile diagnostic deadline' ? 'diagnostic-response-deadline'
        : ['Render scheduler trace exceeds16MB', 'Render scheduler event cap exceeded', 'Sanitized render scheduler trace exceeds16MB'].includes(error.message)
          ? 'bounded-cap' : 'protocol-or-parse-unavailable',
      diagnosticDeadlineMs: 1500, deadlineDoesNotCancelRpc: true })).catch(() => {})
  } finally {
    entry.active = false
    if (entry.completed) entry.session?.off('Tracing.tracingComplete', entry.completed)
    if (entry.session) await diagnosticDeadline(entry.session.detach()).catch(() => {})
  }
}
export async function retainScreenshotObservations(page, testInfo) {
  const state = screenshotObservations.get(page)
  if (state) {
    screenshotEvent(state, { phase: 'test ended before page close', status: testInfo.status })
    await saveScreenshotObservations(state, testInfo)
  }
}
/** The page has closed before draining. A deadline is recorded as remaining
 * work, not cancellation; the existing per-case browser fixture closes next.
 */
export async function settleScreenshotObservations(page, testInfo) {
  const state = screenshotObservations.get(page)
  if (!state) return
  let timer
  try { await Promise.race([Promise.allSettled([...state.pending]), new Promise(resolve => { timer = setTimeout(resolve, 1500) })]) }
  finally { clearTimeout(timer) }
  screenshotEvent(state, { phase: 'closed-page diagnostic drain', pending: state.pending.size, status: testInfo.status })
  await saveScreenshotObservations(state, testInfo)
}
function mediaPhase(state, label, details = {}) {
  if (!state) return
  const elapsedMs = performance.now() - state.startedAt
  const event = { at: Date.now(), label, elapsedMs, observedTimeoutMs: state.testInfo.timeout,
    remainingEstimateMs: Math.max(0, state.testInfo.timeout - elapsedMs), ...details }
  if (state.events.length < 160) state.events.push(event)
  else { state.droppedEvents++; return }
  console.info('MR phase', JSON.stringify(event))
}
// Node-side observations only. The clock starts at this fixture, not at the
// runner's budget origin; its remaining estimate never controls test execution.
export function recordMediaPhase(page, label) {
  mediaPhase(mediaPhases.get(page), label)
}
export async function retainMediaFailure(page, testInfo) {
  if (testInfo.status === testInfo.expectedStatus) return
  try {
    const target = testInfo.outputPath('media-failure.png')
    await mkdir(path.dirname(target), { recursive: true })
    await page.screenshot({ path: target, timeout: 1500 })
    await testInfo.attach('Media failure viewport', { path: target, contentType: 'image/png' })
  } catch (error) { console.warn('MR failure screenshot unavailable:', safeMessage(error.message)) }
}
export async function closeMediaTestContext(context, page, testInfo) {
  const state = mediaPhases.get(page)
  mediaPhase(state, 'secondary context close started', { connected: context.browser()?.isConnected() })
  try {
    await context.close()
    mediaPhase(state, 'secondary context close finished')
  } catch (error) {
    const connected = context.browser()?.isConnected()
    mediaPhase(state, 'secondary context close error', { connected, error: safeMessage(error.message) })
    // Only a recorded primary failure plus confirmed browser teardown permits
    // ignoring this secondary cleanup error. Success-path errors still fail.
    if (testInfo.status !== testInfo.expectedStatus && testInfo.errors.length && connected === false) return
    throw error
  }
}
function observe(state, event) {
  if (state.events.length < 160) state.events.push({ at: Date.now(), ...event })
  else state.droppedEvents++
}
async function readReloadState(page) {
  let timer
  try {
    return await Promise.race([
      page.evaluate(() => {
        let view
        try {
          const raw = JSON.parse(sessionStorage.getItem('starmap:view-state:v1') ?? 'null')
          view = raw && Object.fromEntries(['activePage', 'selectionMode', 'selectedCityId', 'selectedCountryId', 'selectedDayId'].map(key => [key, raw[key]]))
        } catch { view = { unreadable: true } }
        const navigation = performance.getEntriesByType('navigation')[0]
        const collectionScroll = document.querySelector('.atlas-collection-stage .atlas-journey-scroll')
        const bounds = node => {
          const rect = node.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
        return {
          observedAt: Date.now(), pathname: location.pathname, readyState: document.readyState,
          visibility: document.visibilityState, view,
          headings: [...document.querySelectorAll('.atlas-info-panel h2')].map(node => node.textContent?.slice(0, 80)),
          collectionCards: document.querySelectorAll('.collection-card').length,
          canvasCount: document.querySelectorAll('.cesium-widget canvas').length,
          viewport: { width: innerWidth, height: innerHeight },
          collectionScroll: collectionScroll && { scrollTop: collectionScroll.scrollTop, scrollLeft: collectionScroll.scrollLeft, ...bounds(collectionScroll) },
          collectionActions: [...document.querySelectorAll('.collection-card .collection-action-primary')].slice(0, 12).map(node => ({ label: node.getAttribute('aria-label')?.slice(0, 100), disabled: node.disabled, ...bounds(node) })),
          navigation: navigation && Object.fromEntries(['type', 'startTime', 'domInteractive', 'domContentLoadedEventEnd', 'loadEventEnd', 'duration'].map(key => [key, navigation[key]])),
        }
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'snapshot deadline' }), 1500) }),
    ])
  } catch (error) { return { unavailable: safeMessage(error.message) } }
  finally { clearTimeout(timer) }
}
// Observe without delaying the next assertion or extending its original timeout.
export function recordReloadCheckpoint(page, label) {
  const state = reloadObservations.get(page)
  if (!state) return
  observe(state, { event: 'checkpoint', label })
  if (screenshotObservations.get(page)?.suppressSnapshots) return
  const probe = readReloadState(page).then(snapshot => observe(state, { event: 'snapshot', label, snapshot }))
  state.pending.add(probe)
  void probe.finally(() => state.pending.delete(probe))
}
/** The revision of the data the page has rendered (3C-5 D, development only: <html data-starmap-revision>). */
export const renderedRevision = (page) => page.evaluate(() => document.documentElement.dataset.starmapRevision)

/** Wait until the page has rendered a revision other than `before` (or at least `revision`, when given). */
export async function waitForRenderedRevision(page, { before, revision, timeout = 30000 } = {}) {
  await page.waitForFunction(({ before, revision }) => {
    const current = document.documentElement.dataset.starmapRevision
    if (current === undefined) return false
    return revision === undefined ? current !== before : Number(current) >= revision
  }, { before, revision }, { timeout })
  return Number(await renderedRevision(page))
}

/**
 * 3C-5 D: a save no longer reloads the page. Run `save`, then wait until the page has rendered the new revision of the
 * data; the save must not navigate: the main frame does not navigate and a value left on `window` before the save is
 * still there. Resolves the new revision.
 */
export async function saveAndWaitForRevision(page, save, options = {}) {
  const before = await renderedRevision(page)
  const mark = await page.evaluate(() => (window.__starmapNoReload = Math.random()))
  let navigations = 0
  const onNavigation = frame => { if (frame === page.mainFrame()) navigations++ }
  page.on('framenavigated', onNavigation)
  recordReloadCheckpoint(page, 'before save (no reload)')
  try {
    await save()
    const revision = await waitForRenderedRevision(page, { before, ...(options.timeout ? { timeout: options.timeout } : {}) })
    expect(navigations, 'a save does not reload the page').toBe(0)
    expect(await page.evaluate(() => window.__starmapNoReload), 'the page was not reloaded').toBe(mark)
    recordReloadCheckpoint(page, 'saved revision rendered')
    return revision
  } finally {
    page.off('framenavigated', onNavigation)
  }
}

export async function retainReloadFailure(page, testInfo) {
  const state = reloadObservations.get(page)
  if (!state || state.retained || testInfo.status === testInfo.expectedStatus) return
  state.retained = true
  recordReloadCheckpoint(page, 'assertion failure before page close and fixture reset')
  await Promise.allSettled([...state.pending])
  // Persist JSON separately as well as in the report/trace. Playwright retains
  // the configured failure screenshot while page.close() is awaited below.
  const target = testInfo.outputPath('reload-observations.json')
  await writeFile(target, JSON.stringify({ test: testInfo.title, events: state.events, droppedEvents: state.droppedEvents }, null, 2) + '\n')
  await testInfo.attach('Save and reload observations', {
    path: target,
    contentType: 'application/json',
  })
}

export const test = base.extend({
  // SwiftShader allocations can survive closed contexts in a long-lived process.
  // End the actual browser after each case while retaining the shared synthetic service.
  testBrowser: async ({ playwright, browserName, launchOptions, headless, channel }, use, testInfo) => {
    const state = path.basename(testInfo.file) === 'media-recovery.spec.mjs'
      ? { testInfo, startedAt: performance.now(), events: [], droppedEvents: 0 } : null
    if (state) mediaTests.set(testInfo, state)
    mediaPhase(state, 'fixture browser launch started')
    const browser = await playwright[browserName].launch({ ...launchOptions, headless, channel })
    mediaPhase(state, 'fixture browser launch finished')
    if (state) browser.on('disconnected', () => mediaPhase(state, 'fixture browser disconnected'))
    try { await use(browser) } finally {
      mediaPhase(state, 'fixture browser close started', { status: testInfo.status })
      try { await browser.close(); mediaPhase(state, 'fixture browser close finished') }
      finally {
        if (state) {
          try {
            const target = testInfo.outputPath('media-phase-observations.json')
            await mkdir(path.dirname(target), { recursive: true })
            await writeFile(target, JSON.stringify({ status: testInfo.status,
              clockOrigin: 'custom browser fixture start; remaining estimate is not runner authority',
              events: state.events, droppedEvents: state.droppedEvents }, null, 2) + '\n')
            await testInfo.attach('Media phase and cleanup observations', { path: target, contentType: 'application/json' })
          } catch (error) { console.warn('MR phase evidence unavailable:', safeMessage(error.message)) }
          finally { mediaTests.delete(testInfo) }
        }
      }
    }
  },
  page: async ({ testBrowser, contextOptions, baseURL, viewport, locale, serviceWorkers }, use, testInfo) => {
    const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Browser observations require isolated synthetic data.')
    const context = await testBrowser.newContext({ ...contextOptions, baseURL, viewport, locale, serviceWorkers })
    const page = await context.newPage()
    const media = mediaTests.get(testInfo)
    if (media) {
      mediaPhases.set(page, media)
      mediaPhase(media, 'fixture page ready')
      context.on('close', () => mediaPhase(media, 'fixture context closed'))
    }
    // Uncaught errors of this page and of every other page the case opens in its context (another tab), and the errors
    // an error boundary caught, which the dev server reports as uncaught ones (src/data/caughtErrorReport.ts).
    const errors = []
    const expected = []
    const watchErrors = (target) => target.on('pageerror', (error) => errors.push(error.message))
    watchErrors(page)
    context.on('page', watchErrors)
    pageErrorStates.set(page, { errors, expected })
    const diagnostic = diagnosticFiles.has(path.basename(testInfo.file))
    if (diagnostic) {
      const state = { events: [], droppedEvents: 0, pending: new Set(), retained: false }
      reloadObservations.set(page, state)
      // Playwright already traces custom contexts under retain-on-failure.
      page.on('pageerror', error => observe(state, { event: 'pageerror', message: safeMessage(error.message) }))
      page.on('console', message => { if (message.type() === 'error') observe(state, { event: 'console-error', message: safeMessage(message.text()) }) })
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) observe(state, { event: 'main-frame-navigation', pathname: safePath(frame.url()) }) })
      for (const event of ['domcontentloaded', 'load', 'close', 'crash']) page.on(event, () => observe(state, { event }))
      page.on('request', request => {
        const pathname = safePath(request.url())
        if (request.isNavigationRequest() || (request.method() !== 'GET' && pathname.startsWith('/__travelatlas/editor/'))) observe(state, { event: 'request', pathname, method: request.method(), resource: request.resourceType() })
      })
      page.on('response', response => {
        const request = response.request(), pathname = safePath(response.url())
        if (request.isNavigationRequest() || response.status() >= 400 || (request.method() !== 'GET' && pathname.startsWith('/__travelatlas/editor/'))) observe(state, { event: 'response', pathname, status: response.status(), method: request.method() })
      })
      page.on('requestfailed', request => observe(state, { event: 'requestfailed', pathname: safePath(request.url()), resource: request.resourceType(), reason: safeMessage(request.failure()?.errorText) }))
    }
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.origin === 'http://127.0.0.1:5173' ? route.continue() : route.abort()
        : route.continue()
    })
    await page.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'en'))
    try {
      await use(page)
      const unexpected = errors.filter((message) => !expected.some((pattern) => pageErrorMatches(pattern, message)))
      expect(unexpected, 'No uncaught application error').toEqual([])
      for (const pattern of expected) expect(errors.some((message) => pageErrorMatches(pattern, message)), `The expected page error ${pattern} occurred`).toBe(true)
    } finally {
      if (diagnostic) {
        try {
          await retainReloadFailure(page, testInfo)
        } catch (error) {
          await testInfo.attach('Reload evidence collection error', { body: Buffer.from(safeMessage(error.message)), contentType: 'text/plain' })
        }
      }
      mediaPhase(media, 'fixture context close started', { status: testInfo.status })
      await context.close()
      mediaPhase(media, 'fixture context close finished')
    }
  },
})
export { expect }

const pageErrorStates = new WeakMap()
const pageErrorMatches = (pattern, message) => pattern instanceof RegExp ? pattern.test(message) : message.includes(pattern)
/**
 * A case expects this page error (a RegExp, or text the message contains): it does not fail the case, and it must occur
 * at least once (the fixture checks both after the case). An error an error boundary caught is reported as
 * `starmap:caught-error [<boundary>] <message>` (src/data/caughtErrorReport.ts).
 */
export function expectPageError(page, pattern) {
  const state = pageErrorStates.get(page)
  if (!state) throw new Error('expectPageError needs the fixture page')
  state.expected.push(pattern)
}
/** The page errors seen so far on the fixture page and the other pages of its context (a copy). */
export function pageErrors(page) {
  const state = pageErrorStates.get(page)
  if (!state) throw new Error('pageErrors needs the fixture page')
  return [...state.errors]
}

/** One of the fixture's five values as the App reads it: the store's projection (3C-4d), or a V2 file of a 'v2' root. */
export const readFixture = async (key) => (await readFixtureFiles(process.env.STARMAP_BROWSER_TEST_ROOT))[key]
export async function openMap(page) {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
}
export async function selectReykjavik(page) {
  await page.getByRole('button', { name: 'Iceland', exact: true }).click()
  await page.getByRole('button', { name: 'Reykjavik', exact: true }).click()
  await expect(page.locator('.atlas-info-panel h2')).toHaveText('Reykjavik')
}
export async function openCollection(page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
}
