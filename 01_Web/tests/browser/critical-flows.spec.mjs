import { test, expect, openMap, selectReykjavik, openCollection, readFixture, saveAndWaitForReload } from './helpers.mjs'
import { enterDamagedStoreMode, enterStoreMode, fixtureFileNames, fixtureIds } from '../../scripts/browser-fixture.mjs'
import { storeFileOf } from '../../scripts/private-data-source.mjs'
import { getPrivatePaths } from '../../scripts/private-profile.mjs'
import { openStore } from '../../scripts/store-host.mjs'
import { projectToV2Files } from '../../scripts/store-projection.mjs'
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
async function seedSampleMedia(page, adjust = {}) {
  const sample = JSON.parse(await readFile(new URL('../../src/data/v2write/fixtures/migrated-files.json', import.meta.url), 'utf8'))
  const originals = []
  const changes = [['media', (file) => { file.items.push(...sample.media.items); adjust.media?.(file) }], ['editorState', (state) => adjust.editorState?.(state)]]
  for (const [key, change] of changes) {
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
  // A confirmed conversion reloads the whole page; the heading below is checked after that reload (batch 4B).
  await saveAndWaitForReload(page, async () => {
    const save = page.waitForResponse((response) => response.url().endsWith('/wanttogo/convert'))
    await dialog.locator('button[type=submit]').click()
    expect((await save).ok()).toBe(true)
  })
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

test('keyboard hiding the current cover photo clears the draft cover, and hiding a city by keyboard asks first', async ({ page }) => {
  // No saved cover for Reykjavik and one photo marked as cover, so that photo is the current cover. Earlier tests in
  // this group import a photo into Reykjavik, so both inputs of the cover rule are pinned here, not assumed.
  await seedSampleMedia(page, {
    media: (file) => { for (const item of file.items) if (item.placeId === fixtureIds.reykjavik) item.isCover = item.id === 'photo-reykjavik-1' },
    editorState: (state) => { delete state.coverMediaByCity[fixtureIds.reykjavik] },
  })
  await openMap(page)
  await selectReykjavik(page)
  const info = page.locator('.atlas-info-panel')
  await info.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const cover = info.locator('[data-flip-id="photo-reykjavik-1"]')
  await expect(cover.getByRole('button', { name: 'Set as city cover', exact: true })).toHaveAttribute('data-active', 'true')
  await cover.getByRole('button', { name: 'Hide photo', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(cover).toHaveCount(0)
  await saveAndWaitForReload(page, async () => {
    const saved = page.waitForResponse((response) => response.url().endsWith('/editor/state') && response.request().method() === 'PUT')
    await info.getByRole('button', { name: 'Save city photos', exact: true }).click()
    expect((await saved).ok()).toBe(true)
  })
  const state = await readFixture('editorState')
  expect(state.hiddenMediaIds).toContain('photo-reykjavik-1')
  expect(state.coverMediaByCity[fixtureIds.reykjavik]).not.toBe('photo-reykjavik-1')
  // Choosing the selected city again returns to Iceland's city list.
  await page.getByRole('button', { name: 'Reykjavik', exact: true }).click()
  await info.getByRole('button', { name: 'Edit cities', exact: true }).click()
  let question
  page.once('dialog', (dialog) => { question = dialog.message(); void dialog.dismiss() })
  await info.getByRole('button', { name: 'Hide Reykjavik', exact: true }).focus()
  await page.keyboard.press(' ')
  await expect.poll(() => question).toBe('Hide “Reykjavik” from this view? Your travel records will be kept.')
  await expect(info.getByRole('button', { name: 'Hide Reykjavik', exact: true })).toBeVisible()
})

// 3C-3, 3C-4a: the experimental new-library mode. These cases switch the shared fixture into the mode (its V2 files reset
// to the fixture's own content and migrated into data/store/world.sqlite) and put everything back afterwards
// (scripts/browser-fixture.mjs enterStoreMode). They run last in this file, in order, on the same store: a note, a new
// Want to Go item, a conversion with a journey choice, a city order, and a media upload that the mode refuses (3C-4c).
test.describe('new-library mode (experimental)', () => {
  const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
  const moduleUrl = '/@id/__x00__virtual:starmap-private-data'
  /** The revision the dev server's virtual module carries ('undefined' in V2 mode). */
  const servedRevision = async (page) => /privateStoreRevision = (\w+)/.exec(await (await page.request.get(moduleUrl)).text())?.[1]
  /** The store revision, read in this process through a read-only connection. */
  async function storeRevision() {
    const handle = openStore(storeFileOf(getPrivatePaths({ STARMAP_PRIVATE_ROOT: root() })), { readOnly: true })
    try { return handle.meta().revision } finally { await handle.close() }
  }
  /** The store's V2 view, read in this process through a read-only connection (what a new dev server would serve). */
  async function storedFiles() {
    const handle = openStore(storeFileOf(getPrivatePaths({ STARMAP_PRIVATE_ROOT: root() })), { readOnly: true })
    try { return projectToV2Files(handle.readRowsUnchecked()).files } finally { await handle.close() }
  }
  const v2Bytes = async () => Promise.all(Object.values(fixtureFileNames).map((name) => readFile(path.join(root(), 'data', 'v2', name), 'utf8')))
  let leave
  test.beforeAll(async () => { leave = await enterStoreMode(root()) })
  test.afterAll(async () => { await leave?.() })

  test('new-library mode: a Want to Go note edited in Collection is still there after a reload', async ({ page }) => {
    const v2Before = await v2Bytes()
    // The dev server notices the new store file and invalidates its module; wait until it serves the store.
    await expect.poll(() => servedRevision(page)).toBe('1')
    await openMap(page)
    await openCollection(page)
    const sent = []
    page.on('request', (request) => { if (request.url().endsWith('/editor/wanttogo/update')) sent.push(request.headers()) })
    await page.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
    await page.locator('.collection-card textarea').fill('Synthetic new-library note')
    await saveAndWaitForReload(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo/update'))
      await page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click()
      expect((await saved).status()).toBe(200)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]['x-starmap-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sent[0]['x-starmap-base-revision']).toBe('1')
    expect(await storeRevision()).toBe(2)
    const note = page.locator('.collection-card').filter({ hasText: 'Nuuk' }).locator('.collection-card-note')
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await page.reload({ waitUntil: 'domcontentloaded' })
      await openCollection(page)
      await expect(note).toHaveText('“Synthetic new-library note”')
    }
    // The V2 files are not the data source any more: not a byte of them changed.
    expect(await v2Bytes()).toEqual(v2Before)
  })

  test('new-library mode: a Want to Go item added on the map is still there after a reload', async ({ page }) => {
    const v2Before = await v2Bytes()
    const revision = await storeRevision()
    await expect.poll(() => servedRevision(page)).toBe(String(revision))
    await openMap(page)
    await selectReykjavik(page)
    const sent = []
    page.on('request', (request) => { if (request.url().endsWith('/editor/wanttogo') && request.method() === 'POST') sent.push(request.headers()) })
    await saveAndWaitForReload(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo') && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click()
      expect((await saved).status()).toBe(201)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]['x-starmap-base-revision']).toBe(String(revision))
    expect(await storeRevision()).toBe(revision + 1)
    expect((await storedFiles()).wantToGo.items.filter((item) => item.placeId === fixtureIds.reykjavik)).toHaveLength(1)
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await page.reload({ waitUntil: 'domcontentloaded' })
      await openCollection(page)
      await expect(page.getByRole('button', { name: 'Edit note for Reykjavik', exact: true })).toBeVisible()
    }
    expect(await v2Bytes()).toEqual(v2Before)
  })

  test('new-library mode: marking a Want to Go item as visited, with a journey choice, is still there after a reload', async ({ page }) => {
    const v2Before = await v2Bytes()
    const revision = await storeRevision()
    await expect.poll(() => servedRevision(page)).toBe(String(revision))
    await openMap(page)
    await openCollection(page)
    await page.getByRole('button', { name: 'Mark as visited: Nuuk', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Visit date', { exact: true }).fill('2025-06-20')
    await dialog.getByLabel('Trip title (optional)', { exact: true }).fill('2025 North Atlantic Demo')
    // The title is the one of an existing trip: the store asks for a choice and writes nothing.
    const asked = page.waitForResponse((response) => response.url().endsWith('/wanttogo/convert'))
    await dialog.getByRole('button', { name: 'Mark as visited', exact: true }).click()
    const choice = await asked
    expect(choice.status()).toBe(409)
    expect((await choice.json()).code).toBe('E_JOURNEY_CHOICE_REQUIRED')
    expect(await storeRevision()).toBe(revision)
    await dialog.getByRole('radio', { name: /^Add to existing trip: 2025 North Atlantic Demo/ }).check()
    await saveAndWaitForReload(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/wanttogo/convert'))
      await dialog.getByRole('button', { name: 'Mark as visited', exact: true }).click()
      expect((await saved).status()).toBe(200)
    })
    expect(await storeRevision()).toBe(revision + 1)
    const stored = await storedFiles()
    const visits = stored.travel.records.filter((record) => record.placeId === fixtureIds.nuuk && record.status !== 'planned')
    expect(visits).toHaveLength(1)
    expect(visits[0].journeyId).toBe('2025-north-atlantic-demo')
    expect(stored.wantToGo.items.filter((item) => item.placeId === fixtureIds.nuuk)).toHaveLength(0)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openCollection(page)
    await expect(page.getByRole('button', { name: 'Mark as visited: Nuuk', exact: true })).toHaveCount(0)
    expect(await v2Bytes()).toEqual(v2Before)
  })

  test('new-library mode: a city order saved in the info panel is still there after a reload', async ({ page }) => {
    const v2Before = await v2Bytes()
    const revision = await storeRevision()
    await expect.poll(() => servedRevision(page)).toBe(String(revision))
    await openMap(page)
    await selectReykjavik(page)
    const info = page.locator('.atlas-info-panel')
    // Choosing the selected city again returns to Iceland's city list.
    await page.getByRole('button', { name: 'Reykjavik', exact: true }).click()
    await info.getByRole('button', { name: 'Edit cities', exact: true }).click()
    const cards = info.locator('.memory-city-card')
    const order = () => cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-flip-id')))
    const before = await order()
    expect(before.length).toBeGreaterThan(1)
    await cards.last().dragTo(cards.first())
    const expected = [before.at(-1), ...before.slice(0, -1)]
    await expect.poll(order).toEqual(expected)
    const sent = []
    page.on('request', (request) => { if (request.url().endsWith('/editor/state') && request.method() === 'PUT') sent.push(request.headers()) })
    await saveAndWaitForReload(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/editor/state') && response.request().method() === 'PUT')
      await info.getByRole('button', { name: 'Save cities', exact: true }).click()
      expect((await saved).status()).toBe(200)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]['x-starmap-base-revision']).toBe(String(revision))
    expect(await storeRevision()).toBe(revision + 1)
    expect((await storedFiles()).editorState.cityOrderByCountry[fixtureIds.iceland]).toEqual(expected)
    // The page keeps its view across reloads (sessionStorage): Iceland's city list again, in the saved order.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    await expect.poll(order).toEqual(expected)
    expect(await v2Bytes()).toEqual(v2Before)
  })

  test('new-library mode: a media upload is refused with E_STORE_MODE_LIMITED and changes nothing', async ({ page }) => {
    const v2Before = await v2Bytes()
    const revision = await storeRevision()
    await expect.poll(() => servedRevision(page)).toBe(String(revision))
    await openMap(page)
    await selectReykjavik(page)
    await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
    const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 80, g: 140, b: 190 } } }).png().toBuffer()
    const refused = page.waitForResponse((response) => response.url().endsWith('/editor/media/jobs') && response.request().method() === 'POST')
    await page.locator('.atlas-info-panel input[type=file]').setInputFiles({ name: 'browser-neutral.png', mimeType: 'image/png', buffer: image })
    const response = await refused
    expect(response.status()).toBe(409)
    expect((await response.json()).code).toBe('E_STORE_MODE_LIMITED')
    // A confirmed refusal: nothing was written to the store or the V2 files.
    expect(await storeRevision()).toBe(revision)
    expect(await v2Bytes()).toEqual(v2Before)
  })
})

// 3C-4b: a damaged new library (design 3B §5). The store is damaged before the dev server ever sees it
// (scripts/browser-fixture.mjs enterDamagedStoreMode): its open check fails, and the App shows the data read-only with a
// persistent notice; a write is refused with E_STORE_READ_ONLY. It runs after the cases above: the module is first
// loaded in V2 mode, which closes the store they used, so the damaged one is opened afresh. On Windows the dev server
// keeps the store of the cases above open and it cannot be removed: run this case on its own there.
test.describe('new-library mode: a damaged store', () => {
  const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
  const moduleUrl = '/@id/__x00__virtual:starmap-private-data'
  const served = async (page, name) => new RegExp(`${name} = ([A-Za-z0-9_]+)`).exec(await (await page.request.get(moduleUrl)).text())?.[1]
  const storeBytes = () => readFile(storeFileOf(getPrivatePaths({ STARMAP_PRIVATE_ROOT: root() })))
  let leave
  test.afterAll(async () => { await leave?.() })

  test('a damaged new library is shown read-only with a notice, and a note save is refused with E_STORE_READ_ONLY', async ({ page }) => {
    await expect.poll(() => served(page, 'privateStoreRevision')).toBe('undefined')
    leave = await enterDamagedStoreMode(root())
    await expect.poll(() => served(page, 'privateStoreReadOnly')).toBe('true')
    expect(await served(page, 'privateStoreRevision')).toBe('1')
    const before = await storeBytes()
    await openMap(page)
    const notice = 'The new library may be damaged and is read-only. Restore it from a backup: npm run store:restore'
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
    await openCollection(page)
    // The data is there as usual.
    await page.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
    await page.locator('.collection-card textarea').fill('Synthetic note for a damaged store')
    const refused = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo/update'))
    await page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click()
    const response = await refused
    expect(response.status()).toBe(409)
    expect((await response.json()).code).toBe('E_STORE_READ_ONLY')
    await expect(page.locator('.collection-card-notice')).toContainText('The new library may be damaged and is read-only for now. Nothing was saved.')
    // The notice stays after a reload (the page reopens on Collection: go back to the map), and not a byte of the store changed.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
    expect(Buffer.compare(await storeBytes(), before)).toBe(0)
  })
})
