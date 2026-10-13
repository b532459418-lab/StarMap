import { test, expect, openMap, selectReykjavik, openCollection, readFixture, saveAndWaitForReload } from './helpers.mjs'
import { fixtureFileNames, fixtureIds } from '../../scripts/browser-fixture.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

// Cases that seed sample media restore the shared fixture after closing their page, so later cases and files read
// exactly the files they would have read without them.
let restoreFixture
test.afterEach(async ({ page }) => {
  if (!restoreFixture) return
  const restore = restoreFixture
  restoreFixture = undefined
  await page.close()
  await restore()
})
// The tracked unit-test fixture holds two Reykjavik photos and a Torshavn aerial photo; the runner's fixture drops them.
async function seedSampleMedia(page, changeEditorState = () => {}) {
  const sample = JSON.parse(await readFile(new URL('../../src/data/v2write/fixtures/migrated-files.json', import.meta.url), 'utf8'))
  const originals = []
  for (const [key, change] of [['media', (file) => { file.items.push(...sample.media.items) }], ['editorState', changeEditorState]]) {
    const file = path.join(process.env.STARMAP_BROWSER_TEST_ROOT, 'data', 'v2', fixtureFileNames[key])
    const text = await readFile(file, 'utf8')
    originals.push([file, text])
    const value = JSON.parse(text)
    change(value)
    await writeFile(file, JSON.stringify(value, null, 2) + '\n')
  }
  restoreFixture = () => Promise.all(originals.map(([file, text]) => writeFile(file, text)))
  const image = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 60, g: 120, b: 180 } } }).png().toBuffer()
  await page.route('**/media/user/sample/*', (route) => route.fulfill({ contentType: 'image/png', body: image }))
}
const focusInDialog = (page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]')))

test('Journey mapped visit count stays unchanged when map footprints are hidden', async ({ page }) => {
  await openMap(page)
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  await nav.getByRole('button', { name: 'Journey', exact: true }).click()
  const mapped = page.locator('.journey-stat-card').filter({ has: page.locator('.journey-stat-label', { hasText: /^Mapped$/ }) }).locator('.journey-stat-value')
  const before = await mapped.textContent()
  expect(Number(before)).toBeGreaterThan(0)
  await nav.getByRole('button', { name: 'Map', exact: true }).click()
  await page.getByRole('button', { name: /Map layers, .* layers shown/ }).click()
  await page.getByRole('menuitemcheckbox', { name: /^Travel Shown$/ }).click()
  await nav.getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(mapped).toHaveText(before)
})

test('language switching keeps Collection note drafts and conversion dates', async ({ page }) => {
  await openMap(page)
  await openCollection(page)
  await page.getByRole('button', { name: 'Edit note for Akureyri', exact: true }).click()
  const note = page.locator('.collection-card textarea')
  await note.fill('Browser regression draft · 再去一次')
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(note).toHaveValue('Browser regression draft · 再去一次')
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en')
  await expect(note).toHaveValue('Browser regression draft · 再去一次')
  await page.getByRole('button', { name: 'Mark as visited: Bergen', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=date]').first().fill('2026-01-12')
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(dialog.locator('input[type=date]').first()).toHaveValue('2026-01-12')
  await expect(note).toHaveValue('Browser regression draft · 再去一次')
})

test('country/city selection and shortcut preserve place identity, refuse duplicate and retain hidden state', async ({ page }) => {
  await openMap(page)
  await selectReykjavik(page)
  const beforePlaces = await readFixture('places')
  const beforeTravel = await readFixture('travel')
  let writes = 0
  page.on('request', (request) => { if (request.url().endsWith('/editor/wanttogo') && request.method() === 'POST') writes++ })
  await saveAndWaitForReload(page, async () => {
    const saved = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).evaluate((button) => { button.click(); button.click() })
    expect((await saved).status()).toBe(201)
  })
  await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
  expect(writes).toBe(1)
  expect((await readFixture('wantToGo')).items.filter((item) => item.placeId === fixtureIds.reykjavik)).toHaveLength(1)
  expect(await readFixture('places')).toEqual(beforePlaces)
  expect(await readFixture('travel')).toEqual(beforeTravel)
  await openCollection(page)
  await saveAndWaitForReload(page, () => page.getByRole('button', { name: 'Hide: Reykjavik', exact: true }).click())
  await expect(page.getByRole('button', { name: 'Restore: Reykjavik', exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
  await expect(page.getByText('This entry is hidden. Restore it in Collection.', { exact: true })).toBeVisible()
})

test('media recovery imports a received file once after explicit scope confirmation', async ({ page }) => {
  await openMap(page)
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 80, g: 140, b: 190 } } }).png().toBuffer()
  let uploads = 0
  let imports = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    if (/\/editor\/media\/jobs\/[^/]+\/files\//.test(request.url())) uploads++
    if (/\/editor\/media\/jobs\/[^/]+\/import$/.test(request.url())) imports++
  })
  await page.locator('.atlas-info-panel input[type=file]').setInputFiles({ name: 'browser-neutral.png', mimeType: 'image/png', buffer: image })
  const center = page.getByTestId('media-recovery-center')
  await expect(center).toBeVisible()
  await expect(center.getByRole('button', { name: 'Review import scope', exact: true })).toBeEnabled()
  expect(uploads).toBe(1)
  expect(imports).toBe(0)
  await center.getByRole('button', { name: 'Review import scope', exact: true }).click()
  await expect(center.getByTestId('media-import-preview')).toBeVisible()
  await expect(center.getByRole('button', { name: 'Import confirmed files', exact: true })).toBeDisabled()
  await center.getByRole('checkbox', { name: 'I confirm this whole Inbox scope, including other cities and any removals.', exact: true }).check()
  await center.getByRole('button', { name: 'Import confirmed files', exact: true }).click()
  await expect(center.getByTestId('media-job-card').locator('header strong')).toHaveText('Completed', { timeout: 30000 })
  await expect(center.getByRole('button', { name: 'Reload to view imported media', exact: true })).toBeVisible()
  await center.getByRole('button', { name: 'Close completed task', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open photo 1 of Reykjavik', exact: true })).toBeVisible({ timeout: 30000 })
  expect(imports).toBe(1)
  expect(uploads).toBe(1)
  expect((await readFixture('media')).items.filter((item) => item.placeId === fixtureIds.reykjavik)).toHaveLength(1)
})

test('Collection conversion writes a footprint and returns to the same city', async ({ page }) => {
  await openMap(page)
  await openCollection(page)
  await page.getByRole('button', { name: 'Mark as visited: Nuuk', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=date]').first().fill('2026-01-12')
  await dialog.locator('input[type=date]').nth(1).fill('2026-01-13')
  await dialog.locator('input[type=checkbox]').check()
  const save = page.waitForResponse((response) => response.url().endsWith('/wanttogo/convert'))
  await dialog.locator('button[type=submit]').click()
  expect((await save).ok()).toBe(true)
  await expect(page.locator('.atlas-info-panel h2')).toHaveText('Nuuk')
  expect((await readFixture('travel')).records.filter((record) => record.placeId === fixtureIds.nuuk && record.status !== 'planned')).toHaveLength(1)
  expect((await readFixture('wantToGo')).items.filter((item) => item.placeId === fixtureIds.nuuk)).toHaveLength(1)
})

test('mobile panels switch without losing an open city-photo draft or overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openMap(page)
  await page.getByRole('button', { name: 'Show panel', exact: true }).click()
  await page.getByRole('button', { name: 'Countries', exact: true }).click()
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  await page.getByRole('button', { name: 'Countries', exact: true }).click()
  await expect(page.locator('.atlas-info-panel')).not.toBeVisible()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save city photos', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(page.getByRole('button', { name: '保存城市照片', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('forced sample view renders a real city without write controls', async ({ page }) => {
  await page.goto('/?data=sample')
  await selectReykjavik(page)
  await expect(page.getByRole('button', { name: 'Mark as Want to Go', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit city photos', exact: true })).toHaveCount(0)
  await openCollection(page)
  await expect(page.getByRole('button', { name: 'Add a place you want to go', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit note for Akureyri', exact: true })).toHaveCount(0)
})

test('an unconfirmed conversion keeps every write on the page blocked until a reload; the dialog keeps and returns focus', async ({ page }) => {
  const writes = []
  page.on('request', (request) => { if (request.url().includes('/__travelatlas/editor/') && request.method() !== 'GET') writes.push(new URL(request.url()).pathname) })
  await openMap(page)
  await openCollection(page)
  const opener = page.getByRole('button', { name: 'Mark as visited: Bergen', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog')
  const close = dialog.getByRole('button', { name: 'Close mark as visited dialog', exact: true })
  // Tab and Shift+Tab wrap inside the dialog; closing gives focus back to the button that opened it.
  await expect(dialog.getByLabel('Visit date', { exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByLabel('End date (optional)', { exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await dialog.getByLabel('Visit date', { exact: true }).fill('2026-02-03')
  // An unreadable response leaves the write result unknown; nothing reaches the data files.
  await page.route('**/editor/wanttogo/convert', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<p>Bad gateway</p>' }))
  await dialog.getByRole('button', { name: 'Mark as visited', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await opener.click()
  await expect(dialog.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible()
  await expect(dialog.getByText('The operation may have saved data. Reload to check before deciding whether to retry.', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Visit date', { exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Mark as visited', exact: true })).toHaveCount(0)
  expect(await focusInDialog(page)).toBe(true)
  await close.click()
  // Another write entry on the page is refused before any request.
  await page.getByRole('button', { name: 'Edit note for Akureyri', exact: true }).click()
  await page.locator('.collection-card textarea').fill('Blocked until reload')
  await page.getByRole('button', { name: 'Save note for Akureyri', exact: true }).click()
  await expect(page.getByText(/Nothing more can be saved until you reload/)).toBeVisible()
  expect(writes).toEqual(['/__travelatlas/editor/wanttogo/convert'])
})

test('keyboard: a drone card opens its viewer from View, the viewer keeps and returns focus, and the globe scale slider keeps focus while stepping', async ({ page }) => {
  await seedSampleMedia(page)
  const droneLoads = []
  page.on('request', (request) => { if (request.url().includes('/media/user/sample/drone-1.jpg')) droneLoads.push(new URL(request.url()).search) })
  await openMap(page)
  await page.getByRole('button', { name: 'Faroe Islands', exact: true }).click()
  await page.getByRole('button', { name: 'Torshavn Drone media available', exact: true }).click()
  const view = page.getByRole('button', { name: 'View Torshavn drone media 01', exact: true })
  await view.focus()
  await page.keyboard.press('Enter')
  const viewer = page.locator('.drone-panorama-modal')
  await expect(viewer.locator('img.drone-aerial-preview')).toBeVisible()
  // The first load uses the plain URL, so the HTTP cache can answer it; only a retry would add starmapLoad.
  expect(droneLoads).toContain('')
  expect(droneLoads.filter((search) => search.includes('starmapLoad'))).toEqual([])
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await focusInDialog(page)).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(view).toBeFocused()
  const scale = page.getByRole('slider', { name: 'Globe scale', exact: true })
  await scale.focus()
  const start = Number(await scale.inputValue())
  for (let step = 1; step <= 3; step++) {
    await page.keyboard.press('ArrowLeft')
    await expect(scale).toBeFocused()
    await expect.poll(async () => Number(await scale.inputValue())).toBeCloseTo(start - 0.05 * step, 5)
  }
})
