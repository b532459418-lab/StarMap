import { test as base, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fixtureFileNames } from '../../scripts/browser-fixture.mjs'

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
  const started = performance.now()
  screenshotEvent(state, { phase: 'capture started', filename: typeof options?.path === 'string' ? path.basename(options.path) : null,
    explicitTimeoutMs: options?.timeout ?? null, configuredActionTimeoutMs: testInfo.project.use.actionTimeout ?? null })
  try {
    const buffer = await page.screenshot(options)
    screenshotEvent(state, { phase: 'capture returned', durationMs: performance.now() - started, bytes: buffer.length })
    return buffer
  } catch (error) {
    screenshotEvent(state, { phase: 'capture rejected', durationMs: performance.now() - started, error: safeMessage(error.message) })
    try { screenshotEvent(state, { phase: 'failure-only readonly snapshot', snapshot: await screenshotFailureState(page, state) }) }
    catch (diagnosticError) { screenshotEvent(state, { phase: 'snapshot unavailable', error: safeMessage(diagnosticError.message) }) }
    throw error
  } finally { await saveScreenshotObservations(state, testInfo) }
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
// Register before the save; waiting for the current document's load state alone
// can finish before the save triggers its same-URL reload. Keep configured
// navigation/action deadlines and all subsequent assertions unchanged.
export async function saveAndWaitForReload(page, save, options = {}) {
  const expectedUrl = page.url()
  recordReloadCheckpoint(page, 'before save and same-URL reload')
  const reloaded = page.waitForEvent('framenavigated', {
    predicate: frame => frame === page.mainFrame() && frame.url() === expectedUrl,
    ...(options.navigationTimeout === undefined ? {} : { timeout: options.navigationTimeout }),
  }).then(frame => frame.waitForLoadState('domcontentloaded'))
  await Promise.all([reloaded, save()])
  recordReloadCheckpoint(page, 'saved document reached DOM content loaded')
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
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
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
      expect(errors, 'No uncaught application error').toEqual([])
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

export const readFixture = async (key) => JSON.parse(await readFile(path.join(process.env.STARMAP_BROWSER_TEST_ROOT, 'data', 'v2', fixtureFileNames[key]), 'utf8'))
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
