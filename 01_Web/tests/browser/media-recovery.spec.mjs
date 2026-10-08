import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { test, expect, openMap, openCollection, readFixture, recordMediaPhase, closeMediaTestContext, saveAndWaitForReload, retainMediaFailure } from './helpers.mjs'
import { fixtureIds } from '../../scripts/browser-fixture.mjs'

const jobsUrl = '/__travelatlas/editor/media/jobs'
const confirmScope = 'I confirm this whole Inbox scope, including other cities and any removals.'
const confirmFiles = 'I confirm these files match the original task names and sizes.'
const isReceive = request => request.method() === 'POST' && /\/editor\/media\/jobs\/[^/]+\/files\//.test(request.url())
const isImport = request => request.method() === 'POST' && /\/editor\/media\/jobs\/[^/]+\/import$/.test(request.url())
const exactCard = (page, id) => page.locator(`[data-testid="media-job-card"][data-job-id="${id}"]`)
const center = page => page.getByTestId('media-recovery-center')
const lifecycleDiagnostics = new WeakMap()

// Observe context events in each new document without cancelling or restoring them.
function installGraphicsEvents() {
  const events = []
  window.__starmapMediaGraphicsEvents = events
  const record = event => {
    const canvas = event.target instanceof HTMLCanvasElement ? event.target : document.querySelector('.cesium-widget canvas')
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    const entry = { type: event.type, at: new Date().toISOString(), performanceMs: performance.now(),
      visibility: document.visibilityState, defaultPrevented: event.defaultPrevented,
      width: canvas?.width, height: canvas?.height, clientWidth: canvas?.clientWidth, clientHeight: canvas?.clientHeight,
      drawingBufferWidth: gl?.drawingBufferWidth, drawingBufferHeight: gl?.drawingBufferHeight, contextLost: gl?.isContextLost() }
    if (events.length === 64) events.shift()
    events.push(entry)
    console.debug('MR WebGL event', JSON.stringify(entry))
  }
  document.addEventListener('webglcontextlost', record, true)
  document.addEventListener('webglcontextrestored', record, true)
}

test.afterEach(async ({ page }, testInfo) => {
  await retainMediaFailure(page, testInfo)
  const diagnostic = lifecycleDiagnostics.get(page)
  if (!diagnostic) return
  try {
    await diagnostic.settle()
    await diagnostic.capture(page, 'original', 'test ended, before fixture disposal')
    const sourceHashes = Object.fromEntries(await Promise.all(['src/components/CesiumAtlasGlobe.tsx', 'tests/browser/media-recovery.spec.mjs', 'tests/browser/helpers.mjs', 'playwright.config.mjs'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
    const target = await artifactPath(testInfo, 'media-scene-health.json')
    await writeFile(target, JSON.stringify({ status: testInfo.status, graphicsMode: 'Chromium SwiftShader; physical GPU unverified', sourceHashes, graphics: diagnostic.graphics, samples: diagnostic.samples }, null, 2))
    await testInfo.attach('Scene observations, including assertion failure', { path: target, contentType: 'application/json' })
  } catch (error) {
    // Diagnostics must not replace the original assertion's failure.
    console.warn('MR scene diagnostic could not be saved:', error.message)
  } finally { lifecycleDiagnostics.delete(page) }
})

async function artifactPath(testInfo, name) {
  const target = testInfo.outputPath(name)
  await mkdir(path.dirname(target), { recursive: true })
  return target
}

async function selectReykjavik(page) {
  const countries = page.locator('.atlas-country-list')
  const country = countries.locator('.atlas-country-button').filter({ has: page.getByText('Iceland', { exact: true }) })
  if (await country.getAttribute('aria-expanded') !== 'true') {
    await country.scrollIntoViewIfNeeded()
    await expect(country).toBeInViewport()
    await country.click()
  }
  // Accessible names also include the real drone-availability badge once media exists.
  const city = countries.locator('.atlas-city-button').filter({ has: page.getByText('Reykjavik', { exact: true }) })
  if (await city.getAttribute('data-selected') !== 'true') {
    await city.scrollIntoViewIfNeeded()
    await expect(city).toBeInViewport()
    await city.click()
  }
  await expect(page.locator('.atlas-info-panel h2')).toHaveText('Reykjavik')
}

// These cases intentionally preserve task history in the runner's shared synthetic library.
// A failed unfinished task blocks later media creation; skip dependent cases after a failure.
test.describe.configure({ mode: 'serial' })

function syntheticRoot() {
  const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Synthetic browser fixture required')
  return root
}

async function image(name, color) {
  const buffer = await sharp({ create: { width: 64, height: 40, channels: 3, background: color } }).png().toBuffer()
  return { name, mimeType: 'image/png', buffer }
}

async function sourceSnapshot() {
  const result = {}
  const root = path.join(syntheticRoot(), 'MediaInbox')
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (/\.(png|jpe?g|webp|avif)$/i.test(entry.name)) {
        const bytes = await readFile(target)
        const info = await stat(target)
        result[path.relative(root, target).split(path.sep).join('/')] = { hash: createHash('sha256').update(bytes).digest('hex'), size: info.size, mtimeMs: info.mtimeMs }
      }
    }
  }
  await walk(root)
  return result
}

async function openTasks(page) {
  if (!await center(page).isVisible()) await page.getByTestId('media-recovery-entry').click()
  await expect(center(page)).toBeVisible()
}

async function checkTasks(page) {
  const result = page.waitForResponse(response => response.url().endsWith(jobsUrl) && response.request().method() === 'GET')
  await center(page).getByRole('button', { name: 'Check tasks', exact: true }).click()
  const response = await result
  expect(response.ok()).toBe(true)
  return response.json()
}

async function review(page, id) {
  const response = page.waitForResponse(response => response.url().endsWith(`${jobsUrl}/${id}/preview`))
  await exactCard(page, id).getByRole('button', { name: 'Review import scope', exact: true }).click()
  const result = await response
  expect(result.ok()).toBe(true)
  const preview = await result.json()
  await expect(exactCard(page, id).getByTestId('media-import-preview')).toBeVisible()
  return { ...preview, selectedFileIds: preview.plan.selectedFileIds }
}

async function receivePhotos(page, files, reuseReadyDocument = false) {
  // Only the second lifecycle batch reuses the document whose photo save has
  // already completed a real reload. All first/fresh entry points still navigate.
  if (reuseReadyDocument) expect(page.url()).toBe('http://127.0.0.1:5173/')
  else await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const created = page.waitForResponse(response => response.url().endsWith(jobsUrl) && response.request().method() === 'POST')
  await page.locator('.atlas-info-panel input[type=file]').setInputFiles(files)
  const response = await created
  expect(response.ok()).toBe(true)
  const body = await response.json()
  await expect(center(page)).toBeVisible()
  return body.job.jobId
}

async function seedHiddenAndRemovedMedia(page, first) {
  const removed = await image('old-removed-from-inbox.png', { r: 19, g: 58, b: 81 })
  const baseline = { ...first, name: 'old-hidden-photo.png' }
  const id = await receivePhotos(page, [removed, baseline])
  recordMediaPhase(page, 'baseline files received')
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.files.map(file => file.status), { timeout: 30000 }).toEqual(['pending', 'pending'])
  await expect(exactCard(page, id).getByRole('button', { name: 'Review import scope', exact: true })).toBeEnabled()
  await review(page, id)
  recordMediaPhase(page, 'baseline import preview complete')
  await exactCard(page, id).getByRole('checkbox', { name: confirmScope, exact: true }).check()
  await exactCard(page, id).getByRole('button', { name: 'Import confirmed files', exact: true }).click()
  await expect(exactCard(page, id).locator('header strong')).toHaveText('Completed', { timeout: 30000 })
  recordMediaPhase(page, 'baseline import completed')
  await exactCard(page, id).getByRole('button', { name: 'Close completed task', exact: true }).click()
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.status).toBe('closed')
  recordMediaPhase(page, 'baseline task closed')
  await center(page).getByRole('button', { name: 'Close panel', exact: true }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const hiddenId = `media-${createHash('sha256').update(first.buffer).digest('hex').slice(0, 16)}`
  await page.locator(`.atlas-info-panel [data-flip-id="${hiddenId}"]`).getByRole('button', { name: 'Hide photo', exact: true }).click()
  const saved = page.waitForResponse(response => response.url().endsWith('/editor/state') && response.request().method() === 'PUT')
  // Ordinary city-photo saves reload the document; finish that navigation before the next batch.
  const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
  const [, response] = await Promise.all([
    reloaded, saved,
    page.getByRole('button', { name: 'Save city photos', exact: true }).click(),
  ])
  expect(response.ok()).toBe(true)
  recordMediaPhase(page, 'baseline hidden-photo save / real reload complete')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
  await expect.poll(async () => (await readFixture('editorState')).hiddenMediaIds).toContain(hiddenId)
  const removedId = `media-${createHash('sha256').update(removed.buffer).digest('hex').slice(0, 16)}`
  const index = JSON.parse(await readFile(path.join(syntheticRoot(), 'data', 'v2', 'media-source-index.local.json'), 'utf8'))
  expect(index.sourcesById[removedId]).toHaveLength(1)
  return { removed, removedId, sourcePath: index.sourcesById[removedId][0], hiddenId }
}

async function canvasState(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.cesium-widget canvas')
    const rect = canvas?.getBoundingClientRect()
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    return { url: location.href, width: canvas?.width, height: canvas?.height, clientWidth: rect?.width, clientHeight: rect?.height,
      at: new Date().toISOString(), performanceMs: performance.now(), visibility: document.visibilityState,
      drawingBufferWidth: gl?.drawingBufferWidth, drawingBufferHeight: gl?.drawingBufferHeight,
      contextEvents: window.__starmapMediaGraphicsEvents ?? [],
      contextLost: gl?.isContextLost(), errorPanel: Boolean(document.querySelector('.cesium-widget-errorPanel')),
      pose: window.__travelAtlasDebugCamera?.getCameraPose() }
  })
}

async function verifyLiveScene(page, returnFromCollection = false, sample = async () => {}) {
  await page.bringToFront()
  await center(page).getByRole('button', { name: 'Close panel', exact: true }).click()
  if (returnFromCollection) await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await selectReykjavik(page)
  await expect.poll(async () => (await canvasState(page)).pose?.height, { timeout: 15000 }).toBeGreaterThan(0)
  const countryPanel = page.locator('aside').filter({ has: page.locator('.atlas-country-list') })
  if (!await countryPanel.getByRole('button', { name: 'Reset globe to overview', exact: true }).isVisible()) {
    await countryPanel.getByRole('button', { name: 'Globe scale', exact: true }).click()
  }
  // Settle the real city flight before issuing the next real view command.
  let previous
  let stable = 0
  await expect.poll(async () => {
    const height = (await canvasState(page)).pose?.height
    stable = Number.isFinite(height) && Math.abs(height - previous) < 0.1 ? stable + 1 : 0
    previous = height
    return stable
  }, { timeout: 15000, intervals: [250, 350] }).toBeGreaterThanOrEqual(2)
  const before = await canvasState(page)
  await sample('before reset camera', before)
  await countryPanel.getByRole('button', { name: 'Reset globe to overview', exact: true }).click()
  let after
  try {
    await expect.poll(async () => Math.abs((await canvasState(page)).pose?.height - before.pose.height), { timeout: 15000 }).toBeGreaterThan(1)
    after = await canvasState(page)
  } finally { await sample('after reset camera poll, including failure', after) }
  for (const dimension of ['width', 'height', 'clientWidth', 'clientHeight']) expect(after[dimension], `Live canvas ${dimension}`).toBeGreaterThan(0)
  expect(after.contextLost).toBe(false)
  expect(after.errorPanel).toBe(false)
  await openTasks(page)
  return { before, after }
}

test('lost responses, storage loss, partial resume, whole Inbox consent and cross-tab stale plans preserve durable facts', async ({ page, testBrowser }, testInfo) => {
  test.setTimeout(360000)
  page.setDefaultTimeout(15000)
  page.setDefaultNavigationTimeout(45000)
  recordMediaPhase(page, 'lifecycle body started / original 360-second budget')
  const graphics = []
  const samples = []
  const errorSamples = new Set()
  let errorSampleCount = 0
  let phase = 'baseline and original page'
  const capture = async (target, label, reason, observedHealth) => {
    const observedPhase = phase
    let timer
    let entry
    try {
      const health = observedHealth ?? await Promise.race([canvasState(target), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read-only scene sampling exceeded 2000ms')), 2000)
      })])
      entry = { page: label, phase: observedPhase, reason, health }
    } catch (error) { entry = { page: label, phase: observedPhase, reason, at: new Date().toISOString(), samplingError: error.message } }
    finally { clearTimeout(timer) }
    if (samples.length === 64) samples.shift()
    samples.push(entry)
  }
  lifecycleDiagnostics.set(page, { capture, samples, graphics, settle: () => Promise.all([...errorSamples]) })
  const observeGraphics = (target, label) => target.on('console', message => {
    if (/rendering|DeveloperError|MR pagehide|MR WebGL event/.test(message.text())) {
      if (graphics.length === 128) graphics.shift()
      graphics.push({ page: label, phase, at: new Date().toISOString(), type: message.type(), text: message.text() })
    }
    if (message.type() === 'error' && /Rendering has stopped|DeveloperError|Fragment shader failed/.test(message.text()) && errorSampleCount < 8) {
      errorSampleCount++
      const pending = capture(target, label, 'console render error')
      errorSamples.add(pending)
      void pending.finally(() => errorSamples.delete(pending))
    }
  })
  observeGraphics(page, 'original')
  await page.addInitScript(installGraphicsEvents)
  await page.addInitScript(() => addEventListener('pagehide', () => console.debug('MR pagehide', location.href)))
  console.info('MR lifecycle: starting real lost-reception test')
  const first = await image('recovery-first.png', { r: 42, g: 118, b: 210 })
  const second = await image('recovery-second.png', { r: 183, g: 96, b: 51 })
  const baseline = await seedHiddenAndRemovedMedia(page, first)
  recordMediaPhase(page, 'baseline import / hide / source index complete')
  console.info('MR lifecycle: actual baseline imported, one photo hidden, removable source indexed')
  let receives = 0
  let imports = 0
  page.on('request', request => { if (isReceive(request)) receives++; if (isImport(request)) imports++ })
  let dropped = false
  await page.route('**/editor/media/jobs/*/files/*?*', async route => {
    if (!dropped) {
      dropped = true
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    } else await route.continue()
  })
  const id = await receivePhotos(page, [first, second], true)
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.files.map(file => file.status)).toEqual(['pending', 'not_received'])
  expect(receives).toBe(1)
  expect(imports).toBe(0)
  const initialSources = await sourceSnapshot()
  expect(Object.values(initialSources).filter(item => item.hash === createHash('sha256').update(first.buffer).digest('hex'))).toHaveLength(2)
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await page.reload()
  await openTasks(page)
  const discovered = (await checkTasks(page)).jobs.find(job => job.jobId === id)
  expect(discovered.status).toBe('pending')
  expect(receives).toBe(1)
  expect(imports).toBe(0)
  expect(await sourceSnapshot()).toEqual(initialSources)
  console.info('MR lifecycle: lost reception and storage-clear reload recovered from GET')
  recordMediaPhase(page, 'lost reception and storage-clear discovery complete')

  await exactCard(page, id).getByRole('button', { name: 'Pause for now', exact: true }).click()
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.paused).toBe(true)
  await center(page).getByRole('button', { name: 'Close panel', exact: true }).click()
  await openCollection(page)
  await page.getByRole('button', { name: 'Edit note for Akureyri', exact: true }).click()
  await page.locator('.collection-card textarea').fill('Durable media pause permits ordinary edits')
  const saved = page.waitForResponse(response => response.url().includes('/editor/wanttogo/') && response.request().method() === 'POST')
  await saveAndWaitForReload(page, () => page.getByRole('button', { name: 'Save note for Akureyri', exact: true }).click(), { navigationTimeout: 45000 })
  expect((await saved).ok()).toBe(true)
  await expect(page.locator('.collection-card textarea')).toHaveCount(0)
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  await expect(page.locator('.atlas-info-panel input[type=file]')).toBeDisabled()
  await openTasks(page)
  console.info('MR lifecycle: paused task allowed ordinary note save; new photo selection blocked')
  recordMediaPhase(page, 'paused task / ordinary edit / blocked photo complete')
  await center(page).getByRole('button', { name: 'Close panel', exact: true }).click()
  await openCollection(page)
  await openTasks(page)

  const otherContext = await testBrowser.newContext({ baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  const other = await otherContext.newPage()
  otherContext.on('close', () => recordMediaPhase(page, 'secondary context closed event'))
  recordMediaPhase(page, 'secondary context created')
  other.setDefaultTimeout(15000)
  other.setDefaultNavigationTimeout(45000)
  const errors = []
  phase = 'fresh context'
  observeGraphics(other, 'fresh')
  await other.addInitScript(installGraphicsEvents)
  await other.addInitScript(() => addEventListener('pagehide', () => console.debug('MR pagehide', location.href)))
  other.on('pageerror', error => errors.push(error.message))
  other.on('request', request => { if (isReceive(request)) receives++; if (isImport(request)) imports++ })
  await otherContext.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://127.0.0.1:5173' ? route.abort() : route.continue()
  })
  await other.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('starmap.uiLocale', 'en') })
  try {
    await other.goto('/', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await expect(other.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    await expect(other.locator('.cesium-widget canvas')).toBeVisible()
    await openTasks(other)
    expect((await checkTasks(other)).jobs.find(job => job.jobId === id)?.files.map(file => file.status)).toEqual(['pending', 'not_received'])
    const stale = await review(other, id)
    console.info('MR lifecycle: fresh browser context found partial task and previewed scope')
    recordMediaPhase(page, 'secondary context / partial discovery / stale preview complete')
    expect(stale.selectedFileIds).toHaveLength(1)
    expect(imports).toBe(0)

    await openTasks(page)
    await checkTasks(page)
    await page.bringToFront()
    const current = exactCard(page, id)
    await current.getByLabel('Reselect unsent files', { exact: true }).setInputFiles({ ...second, name: 'wrong-name.png' })
    await current.getByRole('checkbox', { name: confirmFiles, exact: true }).check()
    await current.getByRole('button', { name: 'Receive selected files', exact: true }).click()
    await expect(center(page).locator('.atlas-media-recovery-error')).toBeVisible()
    expect(receives).toBe(1)
    await checkTasks(page)
    console.info('MR lifecycle: wrong name rejected locally; explicit discovery restored controls')
    recordMediaPhase(page, 'wrong name refusal / control discovery complete')
    await current.getByLabel('Reselect unsent files', { exact: true }).setInputFiles({ ...second, buffer: Buffer.concat([second.buffer, Buffer.from([0])]) })
    await current.getByRole('checkbox', { name: confirmFiles, exact: true }).check()
    await current.getByRole('button', { name: 'Receive selected files', exact: true }).click()
    await expect(center(page).locator('.atlas-media-recovery-error')).toBeVisible()
    expect(receives).toBe(1)
    await checkTasks(page)
    console.info('MR lifecycle: wrong size rejected locally; explicit discovery restored controls')
    recordMediaPhase(page, 'wrong size refusal / control discovery complete')
    await current.getByLabel('Reselect unsent files', { exact: true }).setInputFiles(second)
    await current.getByRole('checkbox', { name: confirmFiles, exact: true }).check()
    const receivedResponse = page.waitForResponse(response => isReceive(response.request()), { timeout: 45000 })
    await current.getByRole('button', { name: 'Receive selected files', exact: true }).click()
    const receivedResult = await receivedResponse
    const receivedBody = await receivedResult.json()
    console.info('MR lifecycle: resumed reception response', JSON.stringify({ status: receivedResult.status(), code: receivedBody.code, files: receivedBody.job?.files.map(file => file.status) }))
    expect(receivedResult.ok()).toBe(true)
    await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.files.map(file => file.status), { timeout: 30000 }).toEqual(['pending', 'pending'])
    expect(receives).toBe(2)
    console.info('MR lifecycle: wrong name and size made no writes; original unsent file received once')
    recordMediaPhase(page, 'correct unsent reception complete')

    const staleResponse = await other.request.post(`${jobsUrl}/${id}/import`, { headers: { 'x-travelatlas-local-editor': '1' }, data: {
      libraryId: stale.job.libraryId, revision: stale.job.revision, selectedFileIds: stale.selectedFileIds, planDigest: stale.plan.digest, operationId: randomUUID(),
    } })
    expect(staleResponse.status()).toBe(409)
    expect((await staleResponse.json()).code).toBe('E_MEDIA_JOB_CONFLICT')
    expect((await readFixture('media')).items.some(item => item.id === `media-${createHash('sha256').update(second.buffer).digest('hex').slice(0, 16)}`)).toBe(false)
    await checkTasks(other)
    await expect(exactCard(other, id).getByTestId('media-import-preview')).toHaveCount(0)
    console.info('MR lifecycle: server rejected stale cross-tab plan and client discarded it')
    recordMediaPhase(page, 'stale import refusal / preview discard complete')

    // A neutral external delivery in another real fixture city demonstrates whole-Inbox scope.
    const places = (await readFixture('places')).places
    const foreignCity = places.find(place => place.id === fixtureIds.torshavn)
    const foreignCountry = places.find(place => place.id === foreignCity.partOf)
    const countryDirectory = path.join(syntheticRoot(), 'MediaInbox', foreignCountry.names.en)
    const cityDirectory = path.join(countryDirectory, foreignCity.names.en)
    const foreign = await image('other-city-delivery.png', { r: 130, g: 206, b: 94 })
    await mkdir(path.join(cityDirectory, 'photos'), { recursive: true })
    await writeFile(path.join(countryDirectory, 'place.json'), JSON.stringify({ placeId: foreignCountry.id }))
    await writeFile(path.join(cityDirectory, 'place.json'), JSON.stringify({ placeId: foreignCity.id }))
    await writeFile(path.join(cityDirectory, 'photos', foreign.name), foreign.buffer, { flag: 'wx' })
    // Simulate an owner removing one known ORIGINAL in this disposable library only.
    // Both live pages already loaded the old catalog, so removal labels must survive its absent source.
    const inbox = path.resolve(syntheticRoot(), 'MediaInbox')
    const removedPath = path.resolve(inbox, ...baseline.sourcePath.split('/'))
    if (!removedPath.startsWith(`${inbox}${path.sep}`)) throw new Error('Unsafe synthetic source target')
    expect(await readFile(removedPath)).toEqual(baseline.removed.buffer)
    await unlink(removedPath)
    expect((await readFixture('media')).items.some(item => item.id === baseline.removedId)).toBe(true)
    const beforeImport = await sourceSnapshot()
    const plan = await review(other, id)
    expect(plan.selectedFileIds).toHaveLength(2)
    expect(plan.plan.summary.sources.some(source => source.placeId === fixtureIds.torshavn)).toBe(true)
    const preview = exactCard(other, id).getByTestId('media-import-preview')
    await expect(preview).toContainText(foreign.name)
    expect(plan.plan.summary.removedIds).toContain(baseline.removedId)
    const removedImpact = preview.getByTestId('media-scope-removed').locator(`[data-media-id="${baseline.removedId}"]`)
    await expect(removedImpact).toContainText(baseline.removed.name)
    await expect(removedImpact).toContainText('Reykjavik')
    expect(plan.plan.summary.editorEffects.restoredMediaIds).toContain(baseline.hiddenId)
    await expect(preview.getByTestId('media-scope-restored').locator(`[data-media-id="${baseline.hiddenId}"]`)).toBeVisible()
    const secondId = `media-${createHash('sha256').update(second.buffer).digest('hex').slice(0, 16)}`
    await expect(preview.getByTestId('media-scope-added').locator(`[data-media-id="${secondId}"]`)).toBeVisible()
    const proposedOrder = plan.plan.summary.editorEffects.orders.photos[fixtureIds.reykjavik]
    expect(proposedOrder).toContain(baseline.hiddenId)
    expect(proposedOrder).toContain(secondId)
    const order = preview.getByTestId('media-scope-orders').locator(`[data-city-id="${fixtureIds.reykjavik}"][data-order-kind="photos"]`)
    expect(await order.locator('ol li').evaluateAll(items => items.map(item => item.dataset.mediaId))).toEqual(proposedOrder)
    const desktopPath = await artifactPath(testInfo, 'batch3-recovery-desktop.png')
    recordMediaPhase(page, 'whole scope screenshot started')
    await other.screenshot({ path: desktopPath, fullPage: true })
    recordMediaPhase(page, 'whole scope screenshot finished')
    await testInfo.attach('Recovery desktop with complete scope details', { path: desktopPath, contentType: 'image/png' })
    recordMediaPhase(page, 'whole Inbox preview / receipt / original scope complete')
    await expect(exactCard(other, id).getByRole('button', { name: 'Import confirmed files', exact: true })).toBeDisabled()
    expect(imports).toBe(0)
    let importDropped = false
    await other.route('**/editor/media/jobs/*/import', async route => {
      if (!importDropped) {
        importDropped = true
        const result = await route.fetch()
        expect(result.ok()).toBe(true)
        await route.abort('failed')
      } else await route.continue()
    })
    await exactCard(other, id).getByRole('checkbox', { name: confirmScope, exact: true }).check()
    await exactCard(other, id).getByRole('button', { name: 'Import confirmed files', exact: true }).click()
    await expect.poll(async () => (await checkTasks(other)).jobs.find(job => job.jobId === id)?.status).toBe('completed')
    console.info('MR lifecycle: lost import response recovered sealed completion without retry')
    recordMediaPhase(page, 'lost import response / sealed completion discovered')
    expect(imports).toBe(1)
    expect(receives).toBe(2)
    expect(await sourceSnapshot()).toEqual(beforeImport)
    const catalog = await readFixture('media')
    expect(catalog.items.some(item => item.id === baseline.removedId)).toBe(false)
    const savedState = await readFixture('editorState')
    expect(savedState.hiddenMediaIds).not.toContain(baseline.hiddenId)
    expect(savedState.mediaOrderByCity[fixtureIds.reykjavik]).toEqual(proposedOrder)
    for (const file of [first, second, foreign]) {
      const mediaId = `media-${createHash('sha256').update(file.buffer).digest('hex').slice(0, 16)}`
      expect(catalog.items.filter(item => item.id === mediaId)).toHaveLength(1)
    }
    const completion = (await checkTasks(other)).jobs.find(job => job.jobId === id).completion
    const receiptPath = path.join(syntheticRoot(), 'operations', 'media-import', 'v1', 'jobs', `${id}.json`)
    const sealedBytes = await readFile(receiptPath)
    // Reload the tab the user has explicitly returned to, before checking its live scene.
    await other.bringToFront()
    const beforeReload = await canvasState(other)
    await capture(other, 'fresh', 'before completion reload', beforeReload)
    phase = 'completion reload / old document disposal'
    recordMediaPhase(page, 'completion reload started')
    console.info('MR lifecycle: foreground completed tab starts read-only reload')
    await other.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
    phase = 'completion reload / live document'
    recordMediaPhase(page, 'completion reload DOM content loaded')
    // The next required live-scene assertions provide the health samples; do
    // not issue a redundant diagnostic evaluate into this newly loaded document.
    console.info('MR lifecycle: completed tab reloaded; checking retained receipt and live scene')
    await openTasks(other)
    expect((await checkTasks(other)).jobs.find(job => job.jobId === id).completion).toEqual(completion)
    expect(await readFile(receiptPath)).toEqual(sealedBytes)
    const liveScene = await verifyLiveScene(other, false, (reason, health) => capture(other, 'fresh', reason, health))
    recordMediaPhase(page, 'secondary context live scene / real camera verified')
    await checkTasks(page)
    await expect(exactCard(page, id).locator('header strong')).toHaveText('Completed')
    phase = 'original page returns from Collection to Map'
    console.info('MR lifecycle: new context live scene healthy; checking original page return to Map')
    const originalLiveScene = await verifyLiveScene(page, true, (reason, health) => capture(page, 'original', reason, health))
    recordMediaPhase(page, 'original context live scene / real camera verified')
    console.info('MR graphics diagnostic', JSON.stringify({ beforeReload, graphics, liveScene, originalLiveScene }))
    const sourceHashes = Object.fromEntries(await Promise.all(['src/components/MediaRecoveryCenter.tsx', 'src/components/CesiumAtlasGlobe.tsx', 'tests/browser/media-recovery.spec.mjs', 'tests/browser/helpers.mjs'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
    const diagnosticPath = await artifactPath(testInfo, 'batch3-render-diagnostic.json')
    await writeFile(diagnosticPath, JSON.stringify({ execution: process.env.STARMAP_BROWSER_MEDIA_DIAGNOSTIC === '1' ? 'independent lifecycle diagnostic' : process.env.STARMAP_BROWSER_MEDIA_SUITE === '1' ? 'five-case media recovery suite' : 'full suite lifecycle case', graphicsMode: 'Chromium SwiftShader; physical GPU unverified', sourceHashes, beforeReload, graphics, liveScene, originalLiveScene }, null, 2))
    await testInfo.attach('Actual scene and camera health after recovery', { path: diagnosticPath, contentType: 'application/json' })
    expect(imports).toBe(1)
    expect(receives).toBe(2)
    recordMediaPhase(page, 'final Close UI action started')
    await exactCard(other, id).getByRole('button', { name: 'Close completed task', exact: true }).click()
    recordMediaPhase(page, 'final Close UI action finished / Check tasks poll started')
    await expect.poll(async () => (await checkTasks(other)).jobs.find(job => job.jobId === id)?.status).toBe('closed')
    recordMediaPhase(page, 'final Check tasks closed fact verified')
    expect(await sourceSnapshot()).toEqual(beforeImport)
    expect(errors).toEqual([])
    console.info('MR lifecycle: completion history and originals unchanged after reload and close')
  } finally {
    await capture(other, 'fresh', 'before context disposal')
    phase = 'context disposal'
    await closeMediaTestContext(otherContext, page, testInfo)
  }
})

test('mobile recovery keeps scope consent as a user action and fits a narrow translated panel', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 390, height: 844 })
  await openMap(page)
  await page.getByRole('button', { name: 'Show panel', exact: true }).click()
  await page.getByRole('button', { name: 'Countries', exact: true }).click()
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const file = await image('mobile-recovery.png', { r: 177, g: 42, b: 150 })
  const created = page.waitForResponse(response => response.url().endsWith(jobsUrl) && response.request().method() === 'POST')
  await page.locator('.atlas-info-panel input[type=file]').setInputFiles(file)
  const id = (await (await created).json()).job.jobId
  await expect(exactCard(page, id).getByRole('button', { name: 'Review import scope', exact: true })).toBeEnabled()
  await review(page, id)
  await expect(exactCard(page, id).getByRole('checkbox', { name: confirmScope, exact: true })).not.toBeChecked()
  await page.evaluate(() => { document.querySelector('select[aria-label="Interface language"]').value = 'zh-Hans'; document.querySelector('select[aria-label="Interface language"]').dispatchEvent(new Event('change', { bubbles: true })) })
  await expect(center(page)).toContainText('媒体待办')
  const mobilePath = await artifactPath(testInfo, 'batch3-recovery-mobile.png')
  await page.screenshot({ path: mobilePath, fullPage: true })
  await testInfo.attach('Recovery mobile in Chinese at 390 pixels', { path: mobilePath, contentType: 'image/png' })
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await center(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.evaluate(() => { document.querySelector('select[aria-label="界面语言"]').value = 'en'; document.querySelector('select[aria-label="界面语言"]').dispatchEvent(new Event('change', { bubbles: true })) })
  await exactCard(page, id).getByRole('checkbox', { name: confirmScope, exact: true }).check()
  await exactCard(page, id).getByRole('button', { name: 'Import confirmed files', exact: true }).click()
  await expect(exactCard(page, id).locator('header strong')).toHaveText('Completed', { timeout: 30000 })
  await exactCard(page, id).getByRole('button', { name: 'Close completed task', exact: true }).click()
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.status).toBe('closed')
})

test('drone reception fixes the chosen type and required date without inventing missing coordinates', async ({ page }) => {
  test.setTimeout(120000)
  await openMap(page)
  await selectReykjavik(page)
  const drone = page.locator('.drone-media-card')
  await drone.getByRole('button', { name: 'Edit Drone Media', exact: true }).click()
  await drone.getByRole('button', { name: 'Add Drone Media', exact: true }).click()
  await drone.getByRole('combobox', { name: 'Drone media type', exact: true }).selectOption('aerialPhoto')
  const file = await image('neutral-drone.png', { r: 95, g: 174, b: 168 })
  await drone.getByLabel('Drone images', { exact: true }).setInputFiles(file)
  await expect(drone.getByText('Ready', { exact: true })).toBeVisible()
  await drone.locator('input[type=date]').fill('2026-03-12')
  await expect(drone.locator('input[type=number]')).toHaveCount(4)
  for (const field of await drone.locator('input[type=number]').all()) await expect(field).toHaveValue('')
  let imports = 0
  page.on('request', request => { if (isImport(request)) imports++ })
  const created = page.waitForResponse(response => response.url().endsWith(jobsUrl) && response.request().method() === 'POST')
  await drone.getByRole('button', { name: 'Receive files', exact: true }).click()
  const body = await (await created).json()
  const id = body.job.jobId
  await expect(exactCard(page, id).getByRole('button', { name: 'Review import scope', exact: true })).toBeEnabled()
  expect(imports).toBe(0)
  const intent = JSON.parse(await readFile(path.join(syntheticRoot(), 'operations', 'media-import', 'v1', 'jobs', `${id}.json`), 'utf8'))
  expect(intent.kind).toBe('aerialPhoto')
  expect(intent.files[0].metadata.date).toBe('2026-03-12')
  expect(intent.files[0].metadata.lat).toBeUndefined()
  expect(intent.files[0].metadata.lng).toBeUndefined()
  await review(page, id)
  await exactCard(page, id).getByRole('checkbox', { name: confirmScope, exact: true }).check()
  await exactCard(page, id).getByRole('button', { name: 'Import confirmed files', exact: true }).click()
  await expect(exactCard(page, id).locator('header strong')).toHaveText('Completed', { timeout: 30000 })
  const mediaId = `media-${createHash('sha256').update(file.buffer).digest('hex').slice(0, 16)}`
  const item = (await readFixture('media')).items.find(item => item.id === mediaId)
  expect(item.kind).toBe('aerialPhoto')
  expect(item.date).toBe('2026-03-12')
  expect(item.position).toBeUndefined()
  expect(imports).toBe(1)
  await exactCard(page, id).getByRole('button', { name: 'Close completed task', exact: true }).click()
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.status).toBe('closed')
  await page.reload()
  await expect(page.locator('.atlas-info-panel h2')).toHaveText('Reykjavik')
  await expect(page.getByRole('button', { name: 'Select Reykjavik drone media 01', exact: true })).toBeVisible()
})

test('forced sample never discovers private tasks or renders recovery controls', async ({ page }) => {
  const requests = []
  page.on('request', request => { if (request.url().includes('/__travelatlas/editor/')) requests.push(request.url()) })
  await page.goto('/?data=sample')
  await selectReykjavik(page)
  await expect(page.getByTestId('media-recovery-entry')).toHaveCount(0)
  await expect(page.getByTestId('media-recovery-center')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open media tasks', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit city photos', exact: true })).toHaveCount(0)
  expect(requests).toEqual([])
})

test('a real failed reception keeps an uncertain task across reload and never retries its bytes', async ({ page }) => {
  test.setTimeout(120000)
  let receives = 0
  let imports = 0
  page.on('request', request => { if (isReceive(request)) receives++; if (isImport(request)) imports++ })
  const before = await sourceSnapshot()
  const id = await receivePhotos(page, { name: 'invalid-neutral.png', mimeType: 'image/png', buffer: Buffer.from('Synthetic invalid image bytes; no original photograph') })
  await expect.poll(async () => (await checkTasks(page)).jobs.find(job => job.jobId === id)?.status).toBe('needs_review')
  const recordPath = path.join(syntheticRoot(), 'operations', 'media-import', 'v1', 'jobs', `${id}.json`)
  const preserved = await readFile(recordPath)
  expect(JSON.parse(preserved).files[0].phase).toBe('needs_review')
  await expect(exactCard(page, id).getByText('Needs review', { exact: true })).toBeVisible()
  await expect(exactCard(page, id).getByRole('button', { name: 'Receive selected files', exact: true })).toHaveCount(0)
  await expect(exactCard(page, id).getByRole('button', { name: 'Review import scope', exact: true })).toHaveCount(0)
  expect(receives).toBe(1)
  expect(imports).toBe(0)
  await page.reload()
  await openTasks(page)
  expect((await checkTasks(page)).jobs.find(job => job.jobId === id)?.status).toBe('needs_review')
  expect(await readFile(recordPath)).toEqual(preserved)
  expect(await sourceSnapshot()).toEqual(before)
  expect(receives).toBe(1)
  expect(imports).toBe(0)
})
