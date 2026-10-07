import { test as base, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fixtureFileNames } from '../../scripts/browser-fixture.mjs'

const reloadObservations = new WeakMap()
const diagnosticFiles = new Set(['time-filter-boundaries.spec.mjs', 'time-filter-camera.spec.mjs'])
const safePath = value => {
  try { const url = new URL(value); return url.origin === 'http://127.0.0.1:5173' ? url.pathname : '[other origin]' } catch { return '[invalid URL]' }
}
const safeMessage = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, safePath).slice(0, 1200)
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
        return {
          observedAt: Date.now(), pathname: location.pathname, readyState: document.readyState,
          visibility: document.visibilityState, view,
          headings: [...document.querySelectorAll('.atlas-info-panel h2')].map(node => node.textContent?.slice(0, 80)),
          collectionCards: document.querySelectorAll('.collection-card').length,
          canvasCount: document.querySelectorAll('.cesium-widget canvas').length,
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
  const probe = readReloadState(page).then(snapshot => observe(state, { event: 'snapshot', label, snapshot }))
  state.pending.add(probe)
  void probe.finally(() => state.pending.delete(probe))
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
  testBrowser: async ({ playwright, browserName, launchOptions, headless, channel }, use) => {
    const browser = await playwright[browserName].launch({ ...launchOptions, headless, channel })
    try { await use(browser) } finally { await browser.close() }
  },
  page: async ({ testBrowser, contextOptions, baseURL, viewport, locale, serviceWorkers }, use, testInfo) => {
    const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Browser observations require isolated synthetic data.')
    const context = await testBrowser.newContext({ ...contextOptions, baseURL, viewport, locale, serviceWorkers })
    const page = await context.newPage()
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
      await context.close()
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
