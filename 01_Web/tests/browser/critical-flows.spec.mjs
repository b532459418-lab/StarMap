import { test, expect, openMap, selectReykjavik, openCollection, readFixture, renderedRevision, saveAndWaitForRevision, waitForRenderedRevision } from './helpers.mjs'
import {
  PRIVATE_MODULE_PATH, createBrowserFixture, enterDamagedStoreMode, fixtureFileNames, fixtureIds, importInboxMedia, readFixtureFiles, setStoreAside,
  storeRevisionOf, waitForServedRevision,
} from '../../scripts/browser-fixture.mjs'
import { storeFileOf } from '../../scripts/private-data-source.mjs'
import { getPrivatePaths } from '../../scripts/private-profile.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

// 3C-4d: the fixture is a new library from the start. Cases that seed sample media reset the shared fixture after
// closing their page (resetFixture: everything but the media items, which stay; review §7-1).
let restoreFixture
test.afterEach(async ({ page }) => {
  if (!restoreFixture) return
  const restore = restoreFixture
  restoreFixture = undefined
  await page.close()
  await restore()
})
/**
 * Two Reykjavik photos (the one named cover-… is the city's cover photo by the import rule) and a Torshavn aerial photo:
 * real Inbox files imported into the store through the media service (media items are store-native since 3C-4c).
 * Resolves the media items as the App reads them. Importing the same files again adds nothing.
 */
async function seedSampleMedia() {
  const root = process.env.STARMAP_BROWSER_TEST_ROOT
  const inbox = path.join(root, 'MediaInbox')
  const jpeg = (r) => sharp({ create: { width: 64, height: 32, channels: 3, background: { r, g: 120, b: 180 } } }).jpeg({ quality: 90 })
  const folders = [['Iceland', fixtureIds.iceland], ['Iceland/Reykjavik', fixtureIds.reykjavik], ['Faroe Islands', fixtureIds.faroe], ['Faroe Islands/Torshavn', fixtureIds.torshavn]]
  for (const [folder, placeId] of folders) {
    await mkdir(path.join(inbox, ...folder.split('/')), { recursive: true })
    await writeFile(path.join(inbox, ...folder.split('/'), 'place.json'), JSON.stringify({ placeId }))
  }
  await mkdir(path.join(inbox, 'Iceland', 'Reykjavik', 'photos'), { recursive: true })
  await mkdir(path.join(inbox, 'Faroe Islands', 'Torshavn', 'drone'), { recursive: true })
  await jpeg(60).toFile(path.join(inbox, 'Iceland', 'Reykjavik', 'photos', 'cover-harbour.jpg'))
  await jpeg(90).toFile(path.join(inbox, 'Iceland', 'Reykjavik', 'photos', 'photo-2.jpg'))
  await jpeg(120).toFile(path.join(inbox, 'Faroe Islands', 'Torshavn', 'drone', 'drone-1.jpg'))
  await writeFile(path.join(inbox, 'Faroe Islands', 'Torshavn', 'media.json'), JSON.stringify({
    'drone/drone-1.jpg': { kind: 'aerialPhoto', date: '2025-06-06', resolution: '64 × 32', captureType: 'Aerial Photo', lat: 62.01, lng: -6.77 },
  }))
  await importInboxMedia(root)
  restoreFixture = () => createBrowserFixture(root)
  return (await readFixtureFiles(root)).media.items
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
  await saveAndWaitForRevision(page, async () => {
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
  await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Hide: Reykjavik', exact: true }).click())
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
  // 3C-5 D: no reload; the dev server pushes the new revision. The photo editor stayed open during the import (its list
  // changed meanwhile, so it shows the conflict notice): leaving it shows the imported photo.
  await center.getByRole('button', { name: 'Close completed task', exact: true }).click()
  await center.getByRole('button', { name: 'Close panel', exact: true }).click()
  await expect(center).toHaveCount(0)
  await page.getByRole('button', { name: 'Exit editing city photos', exact: true }).click()
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
  await saveAndWaitForRevision(page, async () => {
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
  const requestIds = []
  page.on('request', (request) => {
    if (!request.url().includes('/__travelatlas/editor/') || request.method() === 'GET') return
    writes.push(new URL(request.url()).pathname)
    requestIds.push(request.headers()['x-starmap-request-id'])
  })
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
  // The new library (3C-4a) retries a save it cannot confirm with the same request id, then blocks the page; since
  // 3C-5 D once at once and once more after the dev server answers again (it does here), so three tries in all.
  expect(writes).toEqual(['/__travelatlas/editor/wanttogo/convert', '/__travelatlas/editor/wanttogo/convert', '/__travelatlas/editor/wanttogo/convert'])
  expect(requestIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(requestIds[1]).toBe(requestIds[0])
  expect(requestIds[2]).toBe(requestIds[0])
})

test('keyboard: a drone card opens its viewer from View, the viewer keeps and returns focus, and the globe scale slider keeps focus while stepping', async ({ page }) => {
  const media = await seedSampleMedia()
  const drone = media.find((item) => item.placeId === fixtureIds.torshavn && item.originalFileName === 'drone-1.jpg')
  const droneDirectory = `${path.posix.dirname(drone.src)}/`
  const droneLoads = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith(droneDirectory)) droneLoads.push(new URL(request.url()).search) })
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
  // this group import a photo into Reykjavik, so both inputs of the cover rule are checked here, not assumed: the seeded
  // cover-… photo is the city's cover photo (the import's rule), and the reset fixture saves no cover.
  const media = await seedSampleMedia()
  const coverPhoto = media.find((item) => item.placeId === fixtureIds.reykjavik && item.isCover)
  expect(coverPhoto?.originalFileName).toBe('cover-harbour.jpg')
  expect((await readFixture('editorState')).coverMediaByCity[fixtureIds.reykjavik]).toBeUndefined()
  await openMap(page)
  await selectReykjavik(page)
  const info = page.locator('.atlas-info-panel')
  await info.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const cover = info.locator(`[data-flip-id="${coverPhoto.id}"]`)
  await expect(cover.getByRole('button', { name: 'Set as city cover', exact: true })).toHaveAttribute('data-active', 'true')
  await cover.getByRole('button', { name: 'Hide photo', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(cover).toHaveCount(0)
  await saveAndWaitForRevision(page, async () => {
    const saved = page.waitForResponse((response) => response.url().endsWith('/editor/view') && response.request().method() === 'POST')
    await info.getByRole('button', { name: 'Save city photos', exact: true }).click()
    expect((await saved).ok()).toBe(true)
  })
  const state = await readFixture('editorState')
  expect(state.hiddenMediaIds).toContain(coverPhoto.id)
  expect(state.coverMediaByCity[fixtureIds.reykjavik]).not.toBe(coverPhoto.id)
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

// 3C-3, 3C-4a: the editor writes of the new library (the only write path since 3C-4d), with the request protocol. These
// cases first reset the shared fixture to its own content (scripts/browser-fixture.mjs resetFixture: a commit) and run
// in order on the same store: a note, a new Want to Go item, a conversion with a journey choice and a city order. Media
// in the new library (3C-4c) are in the media group (media-recovery.spec.mjs).
test.describe('the new library: editor writes', () => {
  const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
  /** The revision the dev server's virtual module carries ('undefined' without a store). */
  const servedRevision = async (page) => /privateStoreRevision = (\w+)/.exec(await (await page.request.get(PRIVATE_MODULE_PATH)).text())?.[1]
  /** The store revision, read in this process through a read-only connection. */
  const storeRevision = () => storeRevisionOf(root())
  /** The store's V2 view, read in this process through a read-only connection (what a new dev server would serve). */
  const storedFiles = () => readFixtureFiles(root())
  const v2Bytes = async () => Promise.all(Object.values(fixtureFileNames).map((name) => readFile(path.join(root(), 'data', 'v2', name), 'utf8')))
  test.beforeAll(async () => { await createBrowserFixture(root()) })

  test('new-library mode: a Want to Go note edited in Collection is still there after a reload', async ({ page }) => {
    const v2Before = await v2Bytes()
    const revision = await storeRevision()
    await expect.poll(() => servedRevision(page)).toBe(String(revision))
    await openMap(page)
    await openCollection(page)
    const sent = []
    page.on('request', (request) => { if (request.url().endsWith('/editor/wanttogo/update')) sent.push(request.headers()) })
    await page.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
    await page.locator('.collection-card textarea').fill('Synthetic new-library note')
    await saveAndWaitForRevision(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo/update'))
      await page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click()
      expect((await saved).status()).toBe(200)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]['x-starmap-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sent[0]['x-starmap-base-revision']).toBe(String(revision))
    expect(await storeRevision()).toBe(revision + 1)
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
    await saveAndWaitForRevision(page, async () => {
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
    await saveAndWaitForRevision(page, async () => {
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
    page.on('request', (request) => { if (request.url().endsWith('/editor/view') && request.method() === 'POST') sent.push(request.headers()) })
    await saveAndWaitForRevision(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/editor/view') && response.request().method() === 'POST')
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
})

// 3C-4b: a damaged new library (design 3B §5). The store is damaged before the dev server ever sees it
// (scripts/browser-fixture.mjs enterDamagedStoreMode): its open check fails, and the App shows the data read-only with a
// persistent notice; a write is refused with E_STORE_READ_ONLY. It runs last: the fixture's store is first moved aside
// (setStoreAside) and the module loaded without a store, which closes the store the cases above used, so the damaged one
// is opened afresh; afterwards the damaged store is removed and the fixture's store put back. Windows refuses to move the
// store the dev server holds open, so there the case skips itself (CI runs it with the group on Linux).
test.describe('the new library: a damaged store', () => {
  const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
  const served = async (page, name) => new RegExp(`${name} = ([A-Za-z0-9_]+)`).exec(await (await page.request.get(PRIVATE_MODULE_PATH)).text())?.[1]
  const storeBytes = () => readFile(storeFileOf(getPrivatePaths({ STARMAP_PRIVATE_ROOT: root() })))
  let leave, restore
  test.afterAll(async () => {
    if (leave) {
      await leave()
      // The module loaded without a store closes the damaged one before the fixture's store comes back.
      await waitForServedRevision('undefined')
    }
    if (restore) {
      await restore()
      await waitForServedRevision(await storeRevisionOf(root()))
    }
  })

  test('a damaged new library is shown read-only with a notice, and a note save is refused with E_STORE_READ_ONLY', async ({ page }) => {
    restore = await setStoreAside(root())
    test.skip(!restore, 'The dev server holds the fixture\'s store open and Windows cannot move it; CI runs this case on Linux.')
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

// 3C-5 D: saves without reloads. A save keeps what the page was doing; two tabs of one library follow each other; an
// edit of the same record in another tab is a conflict the user resolves; another writer (a command-line import) shows
// up without a reload. Each case starts from the fixture's own content.
test.describe('incremental refresh (3C-5 D)', () => {
  const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
  test.beforeEach(async () => { await createBrowserFixture(root()) })
  const cameraPose = (page) => page.evaluate(() => ({ pose: window.__travelAtlasDebugCamera?.getCameraPose(), command: window.__travelAtlasDebugCamera?.getCameraCommandState() }))
  /** The camera's pose once its last command has completed and two samples agree. */
  async function settledPose(page) {
    let previous
    let pose
    await expect.poll(async () => {
      const { pose: now, command } = await cameraPose(page)
      const settled = command?.status === 'completed' && previous !== undefined && JSON.stringify(now) === JSON.stringify(previous)
      previous = now
      if (settled) pose = now
      return Boolean(settled)
    }, { timeout: 20000, intervals: [200, 300, 400] }).toBe(true)
    return pose
  }
  const card = (page, name) => page.locator('.collection-card').filter({ has: page.getByRole('heading', { name, exact: true }) })

  test('a save keeps the camera, the time filters, the selection and a half-filled form', async ({ page }) => {
    await openMap(page)
    await selectReykjavik(page)
    // A time filter of this session (a reload would bring it back marked as restored).
    await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
    const travel = page.locator('#atlas-time-query-panel .layer-time-filter[data-layer="travel"]')
    if (!await travel.getByLabel('Year shortcut', { exact: true }).isVisible()) await travel.locator('summary').click()
    await travel.getByLabel('Year shortcut', { exact: true }).fill('2025')
    await travel.getByRole('button', { name: 'Use this year', exact: true }).click()
    await page.locator('#atlas-time-query-panel').getByRole('button', { name: 'Close', exact: true }).click()
    const toolbar = page.locator('.atlas-time-query-toolbar')
    await expect(toolbar).toContainText('2025-01-01')
    // A half-filled form: the country editor's add-country form with a date.
    await page.getByRole('button', { name: 'Edit visited countries', exact: true }).click()
    await page.getByRole('button', { name: 'Add country', exact: true }).click()
    const date = page.locator('.atlas-local-editor-form input[type=date]').first()
    await date.fill('2026-02-03')
    const pose = await settledPose(page)
    // The save: Reykjavik on the Want to Go list.
    await saveAndWaitForRevision(page, async () => {
      const saved = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo') && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click()
      expect((await saved).status()).toBe(201)
    })
    await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
    await expect(page.locator('.atlas-info-panel h2')).toHaveText('Reykjavik')
    await expect(toolbar).toContainText('2025-01-01')
    await expect(toolbar.locator('.atlas-time-query-restored')).toHaveCount(0)
    await expect(date).toHaveValue('2026-02-03')
    const after = await cameraPose(page)
    for (const key of ['lat', 'lng', 'height', 'heading', 'pitch']) expect(Math.abs(after.pose[key] - pose[key]), key).toBeLessThan(1e-6 * Math.max(1, Math.abs(pose[key])))
  })

  test('pages that are not shown keep their scroll position and their own state across a save, and show the new data when shown again', async ({ page }) => {
    // Short enough that the journey page scrolls.
    await page.setViewportSize({ width: 1280, height: 520 })
    await openMap(page)
    const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    await nav('Journey')
    const journeyScroll = page.locator('.atlas-journey-stage .atlas-journey-scroll')
    await expect(page.locator('.journey-timeline-card').first()).toBeVisible()
    await journeyScroll.evaluate((element) => element.scrollTo({ top: 120, behavior: 'instant' }))
    const journeyTop = await journeyScroll.evaluate((element) => element.scrollTop)
    expect(journeyTop).toBeGreaterThan(0)
    // Collection with a search of its own that Reykjavik will match once it is on the list.
    await openCollection(page)
    const search = page.locator('.collection-search input[type=search]')
    await search.fill('Reyk')
    await expect(card(page, 'Reykjavik')).toHaveCount(0)
    // The save, on the map, while both pages are not shown.
    await nav('Map')
    await selectReykjavik(page)
    await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click())
    await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
    // Shown again: their own state is there, and the data of the save.
    await openCollection(page)
    await expect(search).toHaveValue('Reyk')
    await expect(card(page, 'Reykjavik')).toHaveCount(1)
    await nav('Journey')
    await expect(page.locator('.journey-timeline-card').first()).toBeVisible()
    expect(await journeyScroll.evaluate((element) => element.scrollTop)).toBe(journeyTop)
  })

  test('two tabs edit the same note: the later save meets the conflict, keeps its changes by keyboard, and both tabs follow', async ({ page }) => {
    const other = await page.context().newPage()
    try {
      for (const tab of [page, other]) {
        await openMap(tab)
        await openCollection(tab)
        await tab.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
      }
      await card(page, 'Nuuk').locator('textarea').fill('Synthetic note from the first tab')
      await card(other, 'Nuuk').locator('textarea').fill('Synthetic note from the second tab')
      const otherBefore = await renderedRevision(other)
      await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click())
      // The second tab follows the push: its draft stays, the conflict is shown and holds the save.
      await waitForRenderedRevision(other, { before: otherBefore })
      const alert = card(other, 'Nuuk').getByRole('alert')
      await expect(alert).toContainText('This record was changed elsewhere')
      await expect(alert).toContainText('Note: ')
      await expect(alert).toContainText('Synthetic note from the first tab')
      await expect(card(other, 'Nuuk').locator('textarea')).toHaveValue('Synthetic note from the second tab')
      await expect(other.getByRole('button', { name: 'Save note for Nuuk', exact: true })).toBeDisabled()
      // Keyboard: the choice is a native button.
      await alert.getByRole('button', { name: 'Keep my changes', exact: true }).focus()
      await other.keyboard.press('Enter')
      await expect(alert).toHaveCount(0)
      await saveAndWaitForRevision(other, () => other.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click())
      // Both tabs show the second tab's note, without a reload.
      await expect(card(other, 'Nuuk').locator('.collection-card-note')).toHaveText('“Synthetic note from the second tab”')
      await expect(card(page, 'Nuuk').locator('.collection-card-note')).toHaveText('“Synthetic note from the second tab”')
      expect((await readFixture('wantToGo')).items.find((item) => item.placeId === fixtureIds.nuuk).note).toBe('Synthetic note from the second tab')
    } finally { await other.close() }
  })

  test('two tabs edit the same note: the later tab can use the new content instead', async ({ page }) => {
    const other = await page.context().newPage()
    try {
      for (const tab of [page, other]) {
        await openMap(tab)
        await openCollection(tab)
        await tab.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
      }
      await card(other, 'Nuuk').locator('textarea').fill('Synthetic draft that gives way')
      await card(page, 'Nuuk').locator('textarea').fill('Synthetic note that stays')
      await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click())
      const alert = card(other, 'Nuuk').getByRole('alert')
      await expect(alert).toBeVisible()
      await alert.getByRole('button', { name: 'Use the new content', exact: true }).click()
      await expect(alert).toHaveCount(0)
      await expect(card(other, 'Nuuk').locator('textarea')).toHaveValue('Synthetic note that stays')
      await expect(other.getByRole('button', { name: 'Save note for Nuuk', exact: true })).toBeEnabled()
    } finally { await other.close() }
  })

  test('two tabs edit different records: both save (the later one retried on the new revision) and each tab shows both', async ({ page }) => {
    const other = await page.context().newPage()
    try {
      for (const tab of [page, other]) {
        await openMap(tab)
        await openCollection(tab)
      }
      await page.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
      await other.getByRole('button', { name: 'Edit note for Akureyri', exact: true }).click()
      await card(page, 'Nuuk').locator('textarea').fill('Synthetic Nuuk note from one tab')
      await card(other, 'Akureyri').locator('textarea').fill('Synthetic Akureyri note from another tab')
      const sent = []
      other.on('response', (response) => { if (response.url().endsWith('/editor/wanttogo/update')) sent.push(response.status()) })
      await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click())
      await saveAndWaitForRevision(other, () => other.getByRole('button', { name: 'Save note for Akureyri', exact: true }).click())
      expect(sent.at(-1)).toBe(200)
      expect(sent.length === 1 || (sent.length === 2 && sent[0] === 409), JSON.stringify(sent)).toBe(true)
      for (const tab of [page, other]) {
        await expect(card(tab, 'Nuuk').locator('.collection-card-note')).toHaveText('“Synthetic Nuuk note from one tab”')
        await expect(card(tab, 'Akureyri').locator('.collection-card-note')).toHaveText('“Synthetic Akureyri note from another tab”')
      }
    } finally { await other.close() }
  })

  test('a command-line media import shows up on the open page without a reload', async ({ page }) => {
    await openMap(page)
    await selectReykjavik(page)
    const photos = page.locator('.atlas-info-panel').getByRole('button', { name: /^Open photo \d+ of Reykjavik$/ })
    const before = await photos.count()
    const revision = await renderedRevision(page)
    const mark = await page.evaluate(() => (window.__starmapNoReload = Math.random()))
    // A new photo in the Inbox, imported by another process (the media service on its own connection).
    const inbox = path.join(root(), 'MediaInbox', 'Iceland', 'Reykjavik')
    await mkdir(path.join(inbox, 'photos'), { recursive: true })
    await writeFile(path.join(root(), 'MediaInbox', 'Iceland', 'place.json'), JSON.stringify({ placeId: fixtureIds.iceland }))
    await writeFile(path.join(inbox, 'place.json'), JSON.stringify({ placeId: fixtureIds.reykjavik }))
    await sharp({ create: { width: 48, height: 40, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 30, b: 200 } } })
      .jpeg({ quality: 88 }).toFile(path.join(inbox, 'photos', `live-${Date.now()}.jpg`))
    await importInboxMedia(root())
    await waitForRenderedRevision(page, { before: revision })
    await expect(photos).toHaveCount(before + 1)
    expect(await page.evaluate(() => window.__starmapNoReload)).toBe(mark)
  })
})

test.describe('the map pauses during a save (3C-5 D, A′)', () => {
  const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
  test.beforeEach(async () => { await createBrowserFixture(root()) })
  const loop = (page) => page.evaluate(() => window.__travelAtlasDebugRenderLoop?.state())
  /** Paused now: the loop is off and no frame is drawn. */
  async function expectPaused(page) {
    await expect.poll(async () => (await loop(page))?.paused, { timeout: 5000 }).toBe(true)
    const before = await loop(page)
    await page.waitForTimeout(250)
    const after = await loop(page)
    expect(after.frames, `no frame while paused: ${JSON.stringify([before, after])}`).toBe(before.frames)
  }
  /** Resumed (by `endedBy` when given): the loop is on, and the frames go on after the resume. */
  async function expectRendering(page, endedBy) {
    await expect.poll(async () => (await loop(page))?.paused, { timeout: 5000 }).toBe(false)
    const state = await loop(page)
    expect(state.useDefaultRenderLoop).toBe(true)
    if (endedBy) expect(state.episodes.at(-1)?.endedBy).toBe(endedBy)
    await expect.poll(async () => (await loop(page)).frames - state.framesAtResume, { timeout: 5000 }).toBeGreaterThan(5)
    return state
  }
  /** The want-to-go write of the info card, answered after `ms` (or as `fulfil` says). */
  const holdWrite = (page, { ms = 0, fulfil } = {}) => page.route('**/__travelatlas/editor/wanttogo', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms))
    return fulfil ? route.fulfill(fulfil) : route.continue()
  })
  const markReykjavik = (page) => page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click()
  /** After a reload: the page restores the selected city, or it is selected again. */
  async function reykjavikAgain(page) {
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    await page.waitForTimeout(1000)
    if ((await page.locator('.atlas-info-panel h2').textContent()) !== 'Reykjavik') await selectReykjavik(page)
    await expect(page.getByRole('button', { name: 'Mark as Want to Go', exact: true })).toBeEnabled()
  }

  test('a save pauses the map from the click until its changes are applied; then the map renders them', async ({ page }) => {
    await openMap(page)
    await selectReykjavik(page)
    await expectRendering(page)
    await holdWrite(page, { ms: 600 })
    await markReykjavik(page)
    await expectPaused(page)
    await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
    const state = await expectRendering(page, 'applied')
    expect(state.episodes.at(-1).pausedMs).toBeGreaterThan(500)
    expect(state.episodes.at(-1).pausedMs).toBeLessThan(1500)
  })

  test('a refused save, an unknown outcome, or applying that throws: the map renders again at once', async ({ page }) => {
    await openMap(page)
    await selectReykjavik(page)
    // Refused by the server.
    await holdWrite(page, { fulfil: { status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'E_INVALID_INPUT', error: 'refused' }) } })
    await markReykjavik(page)
    await expectRendering(page, 'failed')
    await page.unroute('**/__travelatlas/editor/wanttogo')
    // (A failed add asks for a reload before the next one.)
    await page.reload()
    await reykjavikAgain(page)
    // Applying the answer throws: rows that do not fit, and the changes that would replace them cannot be read.
    const revision = Number(await renderedRevision(page))
    await page.route('**/__travelatlas/editor/read-model/changes**', (route) => route.fulfill({ status: 500, body: 'unavailable' }))
    await holdWrite(page, { fulfil: { status: 201, contentType: 'application/json', body: JSON.stringify({
      // (A replayed answer: the parser takes it without an item; the rows are what fails.)
      ok: true, duplicate: true, revision: revision + 1, delta: { from: revision, to: revision + 1, upserts: [{ table: 'entries', row: { id: 7 } }], deletes: [] },
    }) } })
    await markReykjavik(page)
    await expectRendering(page, 'released')
    await page.unroute('**/__travelatlas/editor/wanttogo')
    await page.unroute('**/__travelatlas/editor/read-model/changes**')
    await page.reload()
    await reykjavikAgain(page)
    // The outcome stays unknown (an unreadable answer every time): resumed at the first failed try.
    await holdWrite(page, { fulfil: { status: 502, contentType: 'text/html', body: '<p>Bad gateway</p>' } })
    await markReykjavik(page)
    await expectRendering(page, 'failed')
    await expect(page.getByText(/Nothing more can be saved until you reload|may have saved data/).first()).toBeVisible()
  })

  test('another page, a hidden page, or the watchdog end a pause while the save is still in flight', async ({ page }) => {
    await openMap(page)
    await selectReykjavik(page)
    await holdWrite(page, { ms: 2500 })
    // Another page.
    await markReykjavik(page)
    await expectPaused(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
    await expectRendering(page, 'page')
    await expect(page.locator('.collection-card').filter({ has: page.getByRole('heading', { name: 'Reykjavik', exact: true }) })).toHaveCount(1, { timeout: 10000 })
    await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
    // The page hidden (another tab in front): a save of the city photos layout stays possible; here a note in Collection.
    await page.unroute('**/__travelatlas/editor/wanttogo')
    await page.route('**/__travelatlas/editor/wanttogo/update', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      await route.continue()
    })
    await openCollection(page)
    await page.getByRole('button', { name: 'Edit note for Akureyri', exact: true }).click()
    await page.locator('.collection-card textarea').fill('Synthetic note while the page hides')
    await page.getByRole('button', { name: 'Save note for Akureyri', exact: true }).click()
    await expectPaused(page)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })
    await expectRendering(page, 'hidden')
    await expect(page.locator('.collection-card textarea')).toHaveCount(0, { timeout: 10000 })
    // The watchdog: a save whose answer takes longer than the limit.
    await page.getByRole('button', { name: 'Hide: Nuuk', exact: true }).click()
    await expectPaused(page)
    const state = await expectRendering(page, 'limit')
    expect(state.episodes.at(-1).pausedMs).toBeGreaterThanOrEqual(1500)
    expect(state.episodes.at(-1).pausedMs).toBeLessThan(1700)
    await expect(page.getByRole('button', { name: 'Restore: Nuuk', exact: true })).toBeVisible({ timeout: 10000 })
  })

  test('saves one after another, and a viewer replaced during a pause: the map renders again with the last one', async ({ page }) => {
    await openMap(page)
    await openCollection(page)
    let held = 0
    await page.route('**/__travelatlas/editor/wanttogo/update', async (route) => {
      // The first answer comes after the second save started (the two are in flight together); a restore takes 1 s.
      const restoring = (route.request().postData() ?? '').includes('"hidden":false')
      await new Promise((resolve) => setTimeout(resolve, restoring || held++ === 0 ? 1000 : 100))
      await route.continue()
    })
    // Two saves in flight together: one pause, ended when the last one is applied.
    const episodes = (await loop(page)).episodes.length
    // Both clicked in one task (a click through the test driver can wait until the first save is done).
    await page.evaluate(() => {
      for (const label of ['Hide: Akureyri', 'Hide: Nuuk']) document.querySelector(`button[aria-label="${label}"]`).click()
    })
    await expectPaused(page)
    await expect(page.getByRole('button', { name: 'Restore: Akureyri', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore: Nuuk', exact: true })).toBeVisible()
    // One pause for both (the later write may meet E_STALE and be sent again: its first try then ends its part).
    const after = await expectRendering(page)
    expect(after.episodes.length).toBe(episodes + 1)
    // The viewer is replaced (destroyed and made again) during a pause: the new one renders once the save is applied.
    const viewer = after.viewer
    await page.getByRole('button', { name: 'Restore: Akureyri', exact: true }).click()
    await expectPaused(page)
    await page.evaluate(() => window.__travelAtlasDebugRenderLoop.replaceViewer())
    await expect.poll(async () => (await loop(page))?.viewer, { timeout: 10000 }).not.toBe(viewer)
    await expect(page.getByRole('button', { name: 'Hide: Akureyri', exact: true })).toBeVisible()
    // Ended by the applying, or by the watchdog; making the new viewer is one long task of the main thread, and the
    // watchdog's timer can only fire after it (so the pause may run past the limit by that task).
    const replaced = await expectRendering(page)
    expect(['applied', 'limit']).toContain(replaced.episodes.at(-1).endedBy)
    expect(replaced.episodes.at(-1).pausedMs).toBeLessThan(3000)
  })
})
