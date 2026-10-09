import { test, expect, openMap, openCollection, readFixture, recordReloadCheckpoint, retainReloadFailure,
  screenshotWithObservations, retainScreenshotObservations, settleScreenshotObservations } from './helpers.mjs'
import { createBrowserFixture, fixtureFileNames, fixtureIds } from '../../scripts/browser-fixture.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) {
  throw new Error('Time-filter checks require the isolated browser runner fixture.')
}
const storageKey = 'starmap.layerTimeFilters.v1'
const screenshots = () => process.env.STARMAP_BROWSER_ARTIFACT_DIR ?? test.info().outputPath('visual-evidence')
const panel = (page) => page.locator('#atlas-time-query-panel')
const layer = (page, id = 'travel') => panel(page).locator(`.layer-time-filter[data-layer="${id}"]`)

test.beforeEach(async () => { await createBrowserFixture(root) })
test.afterEach(async ({ page }, testInfo) => {
  await retainScreenshotObservations(page, testInfo)
  await retainReloadFailure(page, testInfo)
  await page.close()
  await settleScreenshotObservations(page, testInfo)
  await createBrowserFixture(root)
})

async function patchFixture(key, change) {
  const value = await readFixture(key)
  change(value)
  await writeFile(path.join(root, 'data', 'v2', fixtureFileNames[key]), JSON.stringify(value, null, 2) + '\n')
}
async function filters(page, id = 'travel') {
  if (!await panel(page).isVisible()) {
    await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
  }
  const editor = layer(page, id)
  if (!await editor.getByLabel('Year shortcut', { exact: true }).isVisible()) await editor.locator('summary').click()
  return editor
}
async function year(page, value, id = 'travel') {
  const editor = await filters(page, id)
  await editor.getByLabel('Year shortcut', { exact: true }).fill(String(value))
  await editor.getByRole('button', { name: 'Use this year', exact: true }).click()
}
async function range(page, from, to, id = 'travel') {
  const editor = await filters(page, id)
  await editor.getByLabel('From', { exact: true }).fill(from)
  await editor.getByLabel('To', { exact: true }).fill(to)
  await editor.getByRole('button', { name: 'Apply dates', exact: true }).click()
}
async function closeFilters(page) {
  if (await panel(page).isVisible()) await panel(page).getByRole('button', { name: 'Close', exact: true }).click()
}
async function journey(page) {
  await closeFilters(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
}
async function savedFilters(page) { return page.evaluate((key) => localStorage.getItem(key), storageKey) }
async function diskHashes() {
  return Object.fromEntries(await Promise.all(Object.entries(fixtureFileNames).map(async ([key, name]) =>
    [key, createHash('sha256').update(await readFile(path.join(root, 'data', 'v2', name))).digest('hex')],
  )))
}

test('year shortcuts match manual intervals and clearing restores the full chronology', async ({ page }) => {
  await openMap(page)
  await journey(page)
  const baseline = await page.locator('.journey-timeline-card').allTextContents()
  expect(baseline).toHaveLength(6)
  const journeyScroll = page.locator('.atlas-journey-stage .atlas-journey-scroll')
  await journeyScroll.evaluate(element => element.scrollTo({ top: 96, behavior: 'instant' }))
  expect(await journeyScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await journeyScroll.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }))
  await filters(page)
  await expect(layer(page).locator('summary')).toBeFocused()
  expect(await page.evaluate(() => window.scrollX)).toBe(0)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true })).toBeFocused()
  expect(await page.evaluate(() => window.scrollX)).toBe(0)
  await year(page, 2025)
  await closeFilters(page)
  const shortcut = await page.locator('.journey-timeline-card').allTextContents()
  await range(page, '2025-01-01', '2025-12-31')
  await closeFilters(page)
  await expect(page.locator('.journey-timeline-card')).toHaveCount(shortcut.length)
  expect(await page.locator('.journey-timeline-card').allTextContents()).toEqual(shortcut)
  await year(page, 2023)
  await closeFilters(page)
  await expect(page.locator('.journey-timeline-card')).toHaveCount(0)
  await expect(page.getByText('No records match the current time filters', { exact: true })).toBeVisible()
  await filters(page)
  await panel(page).getByRole('button', { name: 'Clear all', exact: true }).click()
  await closeFilters(page)
  await expect(page.locator('.journey-timeline-card')).toHaveCount(baseline.length)
  expect(await page.locator('.journey-timeline-card').allTextContents()).toEqual(baseline)
})

test('invalid drafts stay local across other-layer, language and page changes; reload restores valid conditions', async ({ page }) => {
  await openMap(page)
  await year(page, 2025)
  const before = await savedFilters(page)
  await range(page, '2025-02-29', '2025-12-31')
  await expect(layer(page).getByRole('alert')).toContainText('real start date')
  expect(await savedFilters(page)).toBe(before)
  await year(page, 2026, 'want_to_go')
  await expect(layer(page).getByLabel('From', { exact: true })).toHaveValue('2025-02-29')
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(layer(page).getByLabel('开始日期', { exact: true })).toHaveValue('2025-02-29')
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en')
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(layer(page).getByLabel('From', { exact: true })).toHaveValue('2025-02-29')
  await openCollection(page)
  await expect(panel(page)).not.toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(layer(page).getByLabel('From', { exact: true })).toHaveValue('2025-02-29')
  const remembered = JSON.parse(await savedFilters(page))
  expect(remembered.filters.travel.from).toBe('2025-01-01')
  expect(remembered.filters.want_to_go.from).toBe('2026-01-01')
  await page.reload()
  await expect(page.getByText('Previous time filters restored', { exact: true })).toBeVisible()
  await filters(page)
  await expect(layer(page).getByLabel('From', { exact: true })).toHaveValue('2025-01-01')
  await expect(layer(page).getByRole('alert')).toHaveCount(0)
})

test('a cross-year visit belongs to both years in all time and only the queried year after filtering', async ({ page }) => {
  await patchFixture('travel', (file) => {
    file.records = [{ ...file.records[0], start_date: '2024-12-30', end_date: '2025-01-03', year: 2024 }]
  })
  await openMap(page)
  await journey(page)
  await page.getByRole('button', { name: 'Year Cards', exact: true }).click()
  await expect(page.locator('.journey-year-group h3')).toHaveCount(2)
  expect((await page.locator('.journey-year-group h3').allTextContents()).sort()).toEqual(['2024', '2025'])
  await year(page, 2025)
  await closeFilters(page)
  await expect(page.locator('.journey-year-group h3')).toHaveText(['2025'])
  await expect(page.locator('.atlas-time-query-evidence')).toContainText('Definite · Records: 1')
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await expect(page.locator('.journey-timeline-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const shell = await page.evaluate(() => {
    const main = document.querySelector('main')
    const experience = document.querySelector('.atlas-experience')
    return { mainScroll: main.scrollLeft, experienceScroll: experience.scrollLeft, x: experience.getBoundingClientRect().x }
  })
  expect(shell).toEqual({ mainScroll: 0, experienceScroll: 0, x: 0 })
  await mkdir(screenshots(), { recursive: true })
  await screenshotWithObservations(page, test.info(), { path: path.join(screenshots(), 'ui-desktop-journey.png') })
})

test('uncertain evidence is separated, year-only bounds exclude other years, and hidden records stay out', async ({ page }) => {
  await patchFixture('travel', (file) => {
    const byId = new Map(file.records.map((record) => [record.id, record]))
    file.records = [
      byId.get('sample_reykjavik'),
      { ...byId.get('sample_vik'), start_date: '2025', end_date: '', year: 2025 },
      { ...byId.get('sample_akureyri'), start_date: '', end_date: '', year: undefined },
      { ...byId.get('sample_torshavn'), start_date: '2025-02-29', end_date: '', year: 2025 },
      { ...byId.get('sample_gjogv'), start_date: '', end_date: '', year: undefined },
    ]
  })
  await patchFixture('editorState', (file) => {
    file.hiddenCityIds = ['019b76da-a808-7000-8000-000000000008']
  })
  await openMap(page)
  await journey(page)
  await range(page, '2025-06-01', '2025-06-30')
  await closeFilters(page)
  await expect(page.locator('.journey-timeline-card')).toHaveCount(1)
  const editor = await filters(page)
  await editor.getByLabel('Include uncertain dates', { exact: true }).check()
  await closeFilters(page)
  await expect(page.locator('.journey-timeline-card')).toHaveCount(4)
  await expect(page.locator('.atlas-time-query-evidence').first()).toContainText('Definite · Records: 1 · Uncertain · Records: 3')
  await expect(page.locator('.journey-timeline-card').filter({ hasText: 'Gjogv' })).toHaveCount(0)
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await expect(page.locator('.cesium-map-status')).toContainText('Uncertain-date routes: 2 (dashed)')
  await journey(page)
  await year(page, 2026)
  await closeFilters(page)
  // Missing dates remain uncertain, but the reliable 2025 bounds cannot leak into 2026.
  await expect(page.locator('.journey-timeline-card')).toHaveCount(1)
  await expect(page.locator('.journey-timeline-card')).toContainText('Akureyri')
})

test('Collection retains colliding sources and explicit viewing preserves the excluded source', async ({ page }) => {
  await patchFixture('travel', (file) => {
    const planned = file.records.find((record) => record.status === 'planned')
    planned.id = 'shared-source-id'
    planned.start_date = '2027-12-30'
    planned.end_date = '2028-01-03'
    planned.notes = 'Synthetic planned source'
  })
  await patchFixture('wantToGo', (file) => {
    file.items.push({ id: 'shared-source-id', placeId: '019b76da-a80a-7000-8000-00000000000a',
      addedAt: '2020-06-01', hidden: false, note: 'Synthetic saved source' })
  })
  await openMap(page)
  await year(page, 2028, 'want_to_go')
  await closeFilters(page)
  await openCollection(page)
  const cards = page.locator('.collection-card')
  await expect(cards).toHaveCount(5)
  const saved = cards.filter({ hasText: 'Synthetic saved source' })
  const planned = cards.filter({ hasText: 'Synthetic planned source' })
  await expect(saved).toHaveCount(1)
  await expect(planned).toHaveCount(1)
  await expect(saved).toContainText('Added 2020-06-01')
  await expect(planned).toContainText('Planned visit: 2027-12-30 – 2028-01-03')
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(planned).toContainText('计划到访：2027-12-30 – 2028-01-03')
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en')
  const savedView = saved.getByRole('button', { name: 'View on map: Bergen', exact: true })
  recordReloadCheckpoint(page, 'saved source before viewport preparation')
  await savedView.scrollIntoViewIfNeeded()
  await expect(savedView).toBeInViewport()
  recordReloadCheckpoint(page, 'saved source ready for real click')
  await savedView.click()
  recordReloadCheckpoint(page, 'saved source click completed')
  await expect(page.locator('.atlas-wtg-card')).toContainText('Synthetic saved source')
  await expect(page.locator('.atlas-wtg-card [data-time-filter-outside]')).toBeVisible()
  expect(JSON.parse(await savedFilters(page)).filters.want_to_go.from).toBe('2028-01-01')
  await openCollection(page)
  const plannedView = planned.getByRole('button', { name: 'View on map: Bergen', exact: true })
  recordReloadCheckpoint(page, 'planned source before viewport preparation')
  await plannedView.scrollIntoViewIfNeeded()
  await expect(plannedView).toBeInViewport()
  recordReloadCheckpoint(page, 'planned source ready for real click')
  await plannedView.click()
  recordReloadCheckpoint(page, 'planned source click completed')
  await expect(page.locator('.atlas-wtg-card')).toContainText('Synthetic planned source')
  await expect(page.locator('.atlas-wtg-card')).toContainText('2027-12-30')
  await expect(page.locator('.atlas-wtg-card')).toContainText('2028-01-03')
  await expect(page.locator('.atlas-wtg-card [data-time-filter-outside]')).toHaveCount(0)
})

test('country ordering retains every management target and its draft when time results become empty', async ({ page }) => {
  await openMap(page)
  await page.getByRole('button', { name: 'Edit visited countries', exact: true }).click()
  const rows = page.locator('[data-country-sort-id]')
  const originalIds = await rows.evaluateAll((elements) => elements.map((element) => element.dataset.countrySortId))
  expect(originalIds).toHaveLength(2)
  await page.getByRole('button', { name: 'Drag to reorder Iceland', exact: true }).press('ArrowUp')
  const draftIds = await rows.evaluateAll((elements) => elements.map((element) => element.dataset.countrySortId))
  expect(draftIds).not.toEqual(originalIds)
  await year(page, 2023)
  await closeFilters(page)
  expect(await rows.evaluateAll((elements) => elements.map((element) => element.dataset.countrySortId))).toEqual(draftIds)
  const saved = page.waitForResponse((response) => response.url().endsWith('/editor/state') && response.request().method() === 'PUT')
  await page.getByRole('button', { name: 'Save country changes', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  await expect.poll(async () => (await readFixture('editorState')).countryOrder).toEqual(draftIds)
  expect([...draftIds].sort()).toEqual([...originalIds].sort())
})

test('city management keeps all IDs and an add-city draft after its country leaves the time results', async ({ page }) => {
  await openMap(page)
  await page.getByRole('button', { name: 'Iceland', exact: true }).click()
  await page.getByRole('button', { name: 'Edit cities', exact: true }).click()
  const cards = page.locator('.atlas-info-panel .memory-city-card')
  const originalIds = await cards.evaluateAll((elements) => elements.map((element) => element.dataset.flipId))
  expect(originalIds).toHaveLength(3)
  await page.getByRole('button', { name: 'Add cities', exact: true }).click()
  await page.getByRole('button', { name: 'Cannot find it? Enter coordinates', exact: true }).click()
  const info = page.locator('.atlas-info-panel')
  await info.getByLabel('City name', { exact: true }).fill('Synthetic unsaved city')
  await info.getByLabel('Visit date', { exact: true }).fill('2025-09-09')
  await year(page, 2023)
  await closeFilters(page)
  await expect(info.locator('[data-time-filter-outside]')).toBeVisible()
  await expect(info.getByLabel('City name', { exact: true })).toHaveValue('Synthetic unsaved city')
  await expect(info.getByLabel('Visit date', { exact: true })).toHaveValue('2025-09-09')
  expect(await cards.evaluateAll((elements) => elements.map((element) => element.dataset.flipId))).toEqual(originalIds)
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(info.getByLabel('城市名称', { exact: true })).toHaveValue('Synthetic unsaved city')
  expect((await readFixture('travel')).records.some((record) => record.placeId === fixtureIds.reykjavik)).toBe(true)
})

test.describe('mobile time controls', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('390px controls work in both languages without writes or changed library files', async ({ page }) => {
    const before = await diskHashes()
    const writes = []
    page.on('request', (request) => {
      if (request.url().includes('/__travelatlas/editor/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url())
    })
    await openMap(page)
    await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).tap()
    const travel = layer(page)
    await travel.getByLabel('Year shortcut', { exact: true }).fill('2025')
    await travel.getByRole('button', { name: 'Use this year', exact: true }).tap()
    await expect(travel.getByLabel('From', { exact: true })).toHaveValue('2025-01-01')
    await mkdir(screenshots(), { recursive: true })
    await page.screenshot({ path: path.join(screenshots(), 'ui-mobile-time-en.png') })
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
    await travel.getByLabel('开始日期', { exact: true }).fill('2025-02-29')
    await travel.getByRole('button', { name: '应用日期', exact: true }).tap()
    await expect(travel.getByRole('alert')).toContainText('真实的开始日期')
    await page.screenshot({ path: path.join(screenshots(), 'ui-mobile-time-zh.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await panel(page).getByRole('button', { name: '全部清除', exact: true }).tap()
    await expect(travel.getByLabel('开始日期', { exact: true })).toHaveValue('')
    await expect(travel.getByRole('alert')).toHaveCount(0)
    expect(writes).toEqual([])
    expect(await diskHashes()).toEqual(before)
  })
})
