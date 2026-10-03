import { test, expect, openMap, selectReykjavik, openCollection, readFixture } from './helpers.mjs'
import { createBrowserFixture, fixtureFileNames, fixtureIds } from '../../scripts/browser-fixture.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) {
  throw new Error('Time boundary checks require the isolated synthetic browser fixture.')
}
const storageKey = 'starmap.layerTimeFilters.v1'
const panel = page => page.locator('#atlas-time-query-panel')
test.beforeEach(async () => { await createBrowserFixture(root) })
test.afterEach(async ({ page }) => { await page.close(); await createBrowserFixture(root) })

async function patchFixture(key, change) {
  const value = await readFixture(key)
  change(value)
  await writeFile(path.join(root, 'data', 'v2', fixtureFileNames[key]), JSON.stringify(value, null, 2) + '\n')
}
async function year(page, value) {
  if (!await panel(page).isVisible()) await page.locator('.atlas-time-query-toolbar button').click()
  const editor = panel(page).locator('[data-layer="travel"]')
  if (!await editor.getByLabel('Year shortcut', { exact: true }).isVisible()) await editor.locator('summary').click()
  await editor.getByLabel('Year shortcut', { exact: true }).fill(String(value))
  await editor.getByRole('button', { name: 'Use this year', exact: true }).click()
  await panel(page).getByRole('button', { name: 'Close', exact: true }).click()
}
async function hashes() {
  return Object.fromEntries(await Promise.all(Object.entries(fixtureFileNames).map(async ([key, name]) =>
    [key, createHash('sha256').update(await readFile(path.join(root, 'data', 'v2', name))).digest('hex')],
  )))
}

test('manual country dates show their own evidence without inventing cities or visit records', async ({ page }) => {
  await patchFixture('editorState', file => {
    file.addedCountries = [
      { placeId: '019b76da-a80b-7000-8000-00000000000b', visitedDate: '2024-02-29' },
      { placeId: '019b76da-a803-7000-8000-000000000003' },
      { placeId: fixtureIds.iceland, visitedDate: '2025-02-29' },
    ]
  })
  const before = await hashes()
  const writes = []
  page.on('request', request => {
    if (request.url().includes('/__travelatlas/editor/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url())
  })
  await openMap(page)
  await year(page, 2024)
  const countries = page.locator('.atlas-country-list')
  await expect(countries.getByRole('button', { name: 'Greenland', exact: true })).toBeVisible()
  await expect(countries.getByRole('button', { name: 'Norway', exact: true })).toHaveCount(0)
  await expect(countries.getByRole('button', { name: 'Iceland', exact: true })).toHaveCount(0)
  await countries.getByRole('button', { name: 'Greenland', exact: true }).click()
  const info = page.locator('.atlas-info-panel')
  await expect(info.locator('h2')).toHaveText('Greenland')
  await expect(info).toContainText('Country visit date: 2024-02-29')
  await expect(info).toContainText('Matching visits: 0')
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
  const stats = page.locator('.atlas-journey-stage .journey-stats-grid .journey-stat-value')
  await expect(stats).toHaveText(['1', '0', '0', '0'])
  await expect(page.locator('.journey-timeline-card')).toHaveCount(0)
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.atlas-time-query-toolbar button').click()
  await panel(page).locator('[data-layer="travel"]').getByLabel('Include uncertain dates', { exact: true }).check()
  await panel(page).getByRole('button', { name: 'Close', exact: true }).click()
  await countries.getByRole('button', { name: 'Iceland', exact: true }).click()
  await expect(info).toContainText('Country visit date: Date unknown / needs review')
  await expect(info).toContainText('Matching visits: 0')
  await expect(countries.getByRole('button', { name: 'Norway', exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
  expect(await hashes()).toEqual(before)
})

test('conversion preserves the selected result outside the active travel range after reload', async ({ page }) => {
  await openMap(page)
  await year(page, 2025)
  const filters = await page.evaluate(key => localStorage.getItem(key), storageKey)
  await openCollection(page)
  await page.getByRole('button', { name: 'Mark as visited: Nuuk', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=date]').first().fill('2026-01-12')
  await dialog.locator('input[type=date]').nth(1).fill('2026-01-13')
  await dialog.locator('input[type=checkbox]').check()
  const saved = page.waitForResponse(response => response.url().endsWith('/wanttogo/convert'))
  await dialog.locator('button[type=submit]').click()
  expect((await saved).ok()).toBe(true)
  const info = page.locator('.atlas-info-panel')
  await expect(info.locator('h2')).toHaveText('Nuuk')
  await expect(info.locator('[data-time-filter-outside]')).toBeVisible()
  await expect(info).toContainText('Matching visits: 0')
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(filters)
  const created = (await readFixture('travel')).records.filter(record => record.placeId === fixtureIds.nuuk && record.status !== 'planned')
  expect(created).toHaveLength(1)
  expect(created[0].start_date).toBe('2026-01-12')
  expect(created[0].end_date).toBe('2026-01-13')
  const view = await page.evaluate(() => JSON.parse(sessionStorage.getItem('starmap:view-state:v1')))
  expect(view.selectedCityId).toBe(fixtureIds.nuuk)
  expect(view.selectedDayId).toBe(created[0].id)
  await info.getByRole('button', { name: 'Clear this layer’s time filter to view', exact: true }).click()
  await expect(info.locator('h2')).toHaveText('Nuuk')
  await expect(info.locator('[data-time-filter-outside]')).toHaveCount(0)
  await expect(info).toContainText('2026-01-12')
  await expect(info).toContainText('2026-01-13')
  expect((await readFixture('travel')).records.filter(record => record.placeId === fixtureIds.nuuk && record.status !== 'planned')).toHaveLength(1)
})

test('an existing footprint excluded by time still prevents duplicate conversion without changing files', async ({ page }) => {
  await openMap(page)
  await year(page, 2023)
  await openCollection(page)
  await expect(page.getByRole('button', { name: 'Mark as visited: Akureyri', exact: true })).toBeDisabled()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const before = await hashes()
  const response = await page.request.post('/__travelatlas/editor/wanttogo/convert', {
    headers: { Origin: 'http://127.0.0.1:5173', 'x-travelatlas-local-editor': '1' },
    data: { source: 'want-to-go', id: 'wtg_2026-08-12_akureyri', startDate: '2023-01-12' },
  })
  expect(response.ok()).toBe(false)
  expect((await response.json()).code).toBe('E_CONVERT_CITY_IN_FOOTPRINT')
  expect(await hashes()).toEqual(before)
})

test('non-string historical dates remain safe in all-time details and full city management', async ({ page }) => {
  await patchFixture('travel', file => {
    const visit = file.records.find(record => record.id === 'sample_reykjavik')
    visit.start_date = { broken: true }
    visit.end_date = ''
    visit.year = undefined
    const planned = file.records.find(record => record.status === 'planned')
    planned.start_date = { broken: true }
    planned.end_date = ''
    planned.year = undefined
  })
  const before = await hashes()
  const errors = []
  const writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (request.url().includes('/__travelatlas/editor/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url())
  })
  await openMap(page)
  await selectReykjavik(page)
  const info = page.locator('.atlas-info-panel')
  await expect(info.locator('h2')).toHaveText('Reykjavik')
  await expect(info).toContainText('Invalid date / needs review')
  await expect(info).not.toContainText('[object Object]')
  // Selecting the already selected country resets overview; toggle the city to return to its country.
  await page.getByRole('button', { name: 'Reykjavik', exact: true }).click()
  await expect(info.locator('h2')).toHaveText('Iceland')
  await info.getByRole('button', { name: 'Edit cities', exact: true }).click()
  await expect(info.getByRole('button', { name: 'Save cities', exact: true })).toBeVisible()
  await expect(info.locator('.memory-city-card').filter({ hasText: 'Reykjavik' })).toContainText('Invalid date / needs review')
  await expect(info).not.toContainText('[object Object]')
  await openCollection(page)
  const plannedCard = page.locator('.collection-card').filter({ hasText: 'Planned visit: Date unknown / needs review' })
  await expect(plannedCard).toHaveCount(1)
  await expect(plannedCard).toContainText('Invalid date / needs review')
  await expect(plannedCard).not.toContainText('[object Object]')
  await plannedCard.getByRole('button', { name: 'View on map: Bergen', exact: true }).click()
  await expect(page.locator('.atlas-wtg-card')).toContainText('Invalid date / needs review')
  await expect(page.locator('.atlas-wtg-card')).not.toContainText('[object Object]')
  expect(errors).toEqual([])
  expect(writes).toEqual([])
  expect(await hashes()).toEqual(before)
})

test('corrupt and disabled time storage leave browsing usable with visible warnings', async ({ page }) => {
  await page.addInitScript(key => {
    const once = 'starmap-test-corrupt-time-storage-initialized'
    if (!sessionStorage.getItem(once)) {
      sessionStorage.setItem(once, 'true')
      localStorage.setItem(key, '{broken')
    }
  }, storageKey)
  const before = await hashes()
  await openMap(page)
  await page.locator('.atlas-time-query-toolbar button').click()
  await expect(panel(page).getByRole('status')).toContainText('could not be restored or saved')
  await panel(page).getByRole('button', { name: 'Close', exact: true }).click()
  await year(page, 2025)
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key), storageKey)).filters.travel.from).toBe('2025-01-01')
  await page.addInitScript(key => {
    const originalGet = Storage.prototype.getItem
    const originalSet = Storage.prototype.setItem
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Synthetic disabled query preferences', 'SecurityError')
      return originalGet.call(this, name)
    }
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Synthetic disabled query preferences', 'SecurityError')
      return originalSet.call(this, name, value)
    }
  }, storageKey)
  await page.reload()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
  await year(page, 2023)
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(page.locator('.journey-timeline-card')).toHaveCount(0)
  await page.locator('.atlas-time-query-toolbar button').click()
  await expect(panel(page).getByRole('status')).toContainText('could not be restored or saved')
  expect(await hashes()).toEqual(before)
})
