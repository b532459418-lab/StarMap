import { test, expect, openMap, openCollection, selectReykjavik,
  screenshotWithObservations, retainScreenshotObservations, settleScreenshotObservations } from './helpers.mjs'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
if (process.env.STARMAP_BROWSER_REPOSITORY_PREVIEW !== '1' || path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Repository preview requires its isolated runner.')
const note = 'Synthetic repository preview'
const notice = 'Read-only synthetic repository preview. Editing is disabled.'
const nav = page => page.getByRole('navigation', { name: 'Primary navigation' })
async function screenshot(page, testInfo, name) {
  const target = process.env.STARMAP_BROWSER_ARTIFACT_DIR ?? testInfo.outputPath('visual-evidence')
  const resolved = path.resolve(target)
  const artifactRoot = path.resolve('..', '..', 'artifacts')
  const outputRoot = path.resolve(testInfo.outputDir)
  if (![artifactRoot, outputRoot].some(parent => resolved === parent || resolved.startsWith(parent + path.sep))) throw new Error('Preview evidence must stay inside owned artifacts or test output.')
  await mkdir(resolved, { recursive: true })
  let cursor = resolved
  while (cursor !== path.dirname(cursor)) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Preview evidence refuses linked paths.')
    cursor = path.dirname(cursor)
  }
  if (await realpath(resolved) !== resolved) throw new Error('Preview evidence path is not canonical.')
  await screenshotWithObservations(page, testInfo, { path: path.join(resolved, name + '.png') })
}
async function source(page) {
  return page.evaluate(async () => {
    const module = await import('/@id/__x00__virtual:starmap-repository-preview')
    return module.repositoryPreview
  })
}
function provenance(value) {
  expect(value).toMatchObject({ format: 'starmap.repository-readonly-preview', formatVersion: 1, readOnly: true, synthetic: true })
  for (const key of ['savedDigest', 'stateDigest', 'projectionEnvelopeDigest']) expect(value[key]).toMatch(/^[a-f0-9]{64}$/)
  expect(value.canonical.travel.records).toHaveLength(5)
  expect(value.canonical.wantToGo.items).toHaveLength(3)
  expect(value.canonical.wantToGo.items.filter(item => item.note === note)).toHaveLength(1)
  expect(value.canonical.travel.records.map(item => item.id)).toEqual(['sample_reykjavik', 'sample_vik', 'sample_akureyri', 'sample_torshavn', 'sample_gjogv'])
  expect(JSON.stringify(value)).not.toMatch(/starmap-merge-store-|sqlite|labRoot|storeRoot|authorize|sessionId/)
}
test.afterEach(async ({ page }, testInfo) => {
  await retainScreenshotObservations(page, testInfo)
  await page.close()
  await settleScreenshotObservations(page, testInfo)
})

test('Map reads the actual selected Store while preserving public place identity', async ({ page }, testInfo) => {
  await openMap(page)
  await expect(page.getByText(notice, { exact: true })).toBeVisible()
  const captured = await source(page)
  provenance(captured)
  expect(captured.canonical.places.some(place => place.id === '01a0ed02-3f48-70a0-9146-47667ddcbf4e')).toBe(true)
  await selectReykjavik(page)
  await expect(page.locator('.atlas-info-panel')).toContainText('2025')
  await screenshot(page, testInfo, 'repository-map')
})

test('Collection preserves all sources, notes and hidden state without editor controls', async ({ page }, testInfo) => {
  await openMap(page)
  await openCollection(page)
  await expect(page.locator('.collection-card')).toHaveCount(3)
  await expect(page.locator('.collection-card[data-hidden="true"]')).toHaveCount(0)
  await expect(page.locator('.collection-card-note').filter({ hasText: note })).toBeVisible()
  for (const name of ['Nuuk', 'Tromsø', 'Akureyri']) await expect(page.locator('.collection-card-title').filter({ hasText: name })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Edit note for|Hide:|Restore:|Mark as visited:)/ })).toHaveCount(0)
  await screenshot(page, testInfo, 'repository-collection')
  const view = page.getByRole('button', { name: 'View on map: Nuuk', exact: true })
  await view.scrollIntoViewIfNeeded()
  await expect(view).toBeInViewport()
  await view.click()
  await expect(page.locator('.atlas-wtg-card h2')).toHaveText('Nuuk')
  await expect(page.locator('.atlas-wtg-card')).toContainText(note)
})

test('Journey chronology and original routes use the same readonly Canonical', async ({ page }, testInfo) => {
  await openMap(page)
  const original = await source(page)
  await nav(page).getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(page.locator('.journey-timeline-card')).toHaveCount(5)
  await expect(page.locator('.journey-timeline-card').filter({ hasText: 'Reykjavik' })).toContainText('2025-06-01')
  const derived = await page.evaluate(async () => {
    const data = await import('/src/data/appData.ts')
    return { routes: data.timeQueryContext.originalRoutes.length,
      helpersCallable: typeof data.appData.editorState.orderBySavedIds === 'function' && typeof data.appData.mediaCatalog.getMediaSource === 'function', now: data.worldGraphSessionNow }
  })
  expect(derived.routes).toBe(4)
  expect(derived.helpersCallable).toBe(true)
  expect(derived.now).toBe((await source(page)).now)
  await screenshot(page, testInfo, 'repository-journey')
  await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
  const panel = page.locator('#atlas-time-query-panel'), travel = panel.locator('.layer-time-filter[data-layer="travel"]')
  if (!await travel.getByLabel('Year shortcut', { exact: true }).isVisible()) await travel.locator('summary').click()
  await travel.getByLabel('Year shortcut', { exact: true }).fill('2024')
  await travel.getByRole('button', { name: 'Use this year', exact: true }).click()
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.journey-timeline-card')).toHaveCount(0)
  await expect(page.getByText('No records match the current time filters', { exact: true })).toBeVisible()
  await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click()
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.journey-timeline-card')).toHaveCount(5)
  expect((await source(page)).savedDigest).toBe(original.savedDigest)
})

test('write and private endpoints refuse requests; reload and sample query retain Store facts', async ({ page }) => {
  await openMap(page)
  const before = await source(page)
  for (const endpoint of ['/__travelatlas/editor/wanttogo', '/__travelatlas/editor/media/jobs', '/__travelatlas/editor/state']) {
    const response = await page.request.post(endpoint, { data: { note: 'Rejected synthetic write' } })
    expect(response.status()).toBeGreaterThanOrEqual(400)
  }
  await expect(page.getByRole('button', { name: /^(Mark as Want to Go|Edit city photos|Add Want to Go|Edit note for)/ })).toHaveCount(0)
  await page.goto('/?data=sample')
  await expect(page.getByText(notice, { exact: true })).toBeVisible()
  const queried = await source(page)
  provenance(queried)
  expect(queried.savedDigest).toBe(before.savedDigest)
  await page.reload()
  const reloaded = await source(page)
  expect(reloaded.savedDigest).toBe(before.savedDigest)
  expect(Date.parse(reloaded.now)).toBeGreaterThan(Date.parse(queried.now))
  await openCollection(page)
  await expect(page.locator('.collection-card-note').filter({ hasText: note })).toBeVisible()
})

test('Chinese and English readonly notices remain on every existing page', async ({ page }) => {
  await openMap(page)
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  for (const name of ['收藏', '旅程', '地图']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    await expect(page.getByText('合成库只读预览，编辑未启用。', { exact: true })).toBeVisible()
  }
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en')
  for (const name of ['Collection', 'Journey', 'Map']) {
    await nav(page).getByRole('button', { name, exact: true }).click()
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
  }
  provenance(await source(page))
})
