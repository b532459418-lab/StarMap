import {
  test, expect, expectPageError, pageErrors, openMap, selectReykjavik, openCollection, readFixture, renderedRevision, saveAndWaitForRevision,
  waitForRenderedRevision, armSchedulerTrace, diagnosticDeadline, finishSchedulerTrace, expectPauseStarted, armAtSaveClick, pauseStartedAtClick,
} from './helpers.mjs'
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
  // 3C-5 D: no reload; the dev server pushes the new revision. 性能续 P5: the photo editor stayed open during the import
  // with no local edits, so it follows the new data: its list has the imported photo, no conflict notice, save enabled.
  await center.getByRole('button', { name: 'Close completed task', exact: true }).click()
  await center.getByRole('button', { name: 'Close panel', exact: true }).click()
  await expect(center).toHaveCount(0)
  const info = page.locator('.atlas-info-panel')
  await expect(info.getByRole('button', { name: 'Hide photo', exact: true })).toHaveCount(1, { timeout: 30000 })
  await expect(info.getByRole('alert')).toHaveCount(0)
  await expect(info.getByRole('button', { name: 'Save city photos', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Exit editing city photos', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open photo 1 of Reykjavik', exact: true })).toBeVisible({ timeout: 30000 })
  expect(imports).toBe(1)
  expect(uploads).toBe(1)
  expect((await readFixture('media')).items.filter((item) => item.placeId === fixtureIds.reykjavik)).toHaveLength(1)
})

/** 性能续 P5: upload one synthetic photo through the open photo editor and import it from the media recovery center. */
async function importPhotoThroughEditor(page, name) {
  const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 90, g: 150, b: 60 } } }).png().toBuffer()
  await page.locator('.atlas-info-panel input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: image })
  const center = page.getByTestId('media-recovery-center')
  await center.getByRole('button', { name: 'Review import scope', exact: true }).click()
  await center.getByRole('checkbox', { name: 'I confirm this whole Inbox scope, including other cities and any removals.', exact: true }).check()
  await center.getByRole('button', { name: 'Import confirmed files', exact: true }).click()
  await expect(center.getByTestId('media-job-card').locator('header strong')).toHaveText('Completed', { timeout: 30000 })
  await center.getByRole('button', { name: 'Close completed task', exact: true }).click()
  await center.getByRole('button', { name: 'Close panel', exact: true }).click()
  await expect(center).toHaveCount(0)
}

test('性能续 P5: a photo editor with a local edit still shows the conflict when its own upload is imported', async ({ page }) => {
  await seedSampleMedia()
  await openMap(page)
  await selectReykjavik(page)
  const info = page.locator('.atlas-info-panel')
  await info.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  // A local edit: one photo hidden in the draft (not saved).
  const hide = info.getByRole('button', { name: 'Hide photo', exact: true })
  const photos = await hide.count()
  expect(photos).toBeGreaterThan(1)
  await hide.first().click()
  await expect(hide).toHaveCount(photos - 1)
  await importPhotoThroughEditor(page, 'browser-conflict.png')
  // The import appended the photo to the city's order: the data changed while the draft has an edit.
  const alert = info.getByRole('alert')
  await expect(alert).toContainText('This record was changed elsewhere', { timeout: 30000 })
  await expect(info.getByRole('button', { name: 'Save city photos', exact: true })).toBeDisabled()
  // The draft is kept until the user chooses (its hidden photo is still out of the list).
  await expect(hide).toHaveCount(photos - 1)
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

// 收藏页首开: Collection's code arrives through state (src/App.tsx CollectionPage), never through `lazy`.
test.describe("Collection's code", () => {
  const collectionModule = (url) => new URL(url).pathname === '/src/components/CollectionPage.tsx'
  const readModel = (url) => new URL(url).pathname === '/__travelatlas/editor/read-model'

  test('a reload on Collection mounts the restored page together with the data (its code is loaded with them)', async ({ page }) => {
    await openMap(page)
    await openCollection(page)
    // The first commit with the App (the data are there): does the Collection stage already hold the page and its cards?
    await page.addInitScript(() => {
      new MutationObserver((records, observer) => {
        const stage = document.querySelector('.atlas-collection-stage')
        if (!stage) return
        observer.disconnect()
        window.__collectionAtFirstCommit = { page: stage.firstElementChild !== null, cards: stage.getElementsByClassName('collection-card').length }
      }).observe(document, { childList: true, subtree: true })
    })
    // The data wait until the page has Collection's code (an import of the same module resolves once it has run), so
    // that the order of the two requests does not decide the case.
    let releaseData
    const dataReleased = new Promise((resolve) => { releaseData = resolve })
    await page.route(readModel, async (route) => { await dataReleased; await route.continue() })
    await page.reload({ waitUntil: 'commit' })
    await page.waitForFunction(() => import('/src/components/CollectionPage.tsx').then(() => new Promise((resolve) => setTimeout(() => resolve(true), 100))), undefined, { timeout: 30_000 })
    releaseData()
    await expect(page.locator('.collection-card').first()).toBeVisible()
    const first = await page.evaluate(() => window.__collectionAtFirstCommit)
    expect(first?.page, 'the restored Collection is in the first commit with the data, not an empty stage first').toBe(true)
    expect(first.cards).toBeGreaterThan(0)
  })

  test('opened before its code arrives: the stage stays empty, then the page mounts and can be used', async ({ page }) => {
    let releaseCode
    const codeReleased = new Promise((resolve) => { releaseCode = resolve })
    let requested = false
    await page.route(collectionModule, async (route) => { requested = true; await codeReleased; await route.continue() })
    await openMap(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
    await expect(page.locator('.atlas-experience')).toHaveAttribute('data-page', 'collection')
    await expect.poll(() => requested).toBe(true)
    await page.waitForTimeout(300)
    expect(await page.locator('.atlas-collection-stage').evaluate((stage) => stage.childElementCount)).toBe(0)
    releaseCode()
    await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit note for Nuuk', exact: true })).toBeEnabled()
  })

  // Robustness batch (design §6.2, case 2; this case used to lock in the uncaught error that removed the whole page).
  test('a failed load shows the page\'s notice, the map stays, Back to map works; the browser does not load it again, a page reload does', async ({ page }) => {
    test.setTimeout(120_000)
    expectPageError(page, 'starmap:caught-error [page:collection] Failed to fetch dynamically imported module')
    let requests = 0
    let fail = true
    await page.route(collectionModule, (route) => { requests++; return fail ? route.abort() : route.continue() })
    await openMap(page)
    // The prefetch after the map's first frame fails quietly.
    await expect.poll(() => requests).toBe(1)
    await page.waitForTimeout(300)
    expect(pageErrors(page), 'the prefetch fails quietly').toEqual([])
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await nav.getByRole('button', { name: 'Collection', exact: true }).click()
    const notice = page.locator('[data-error-boundary="page:collection"]')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('role', 'alert')
    await expect(notice).toHaveAttribute('data-error-kind', 'code')
    await expect(notice).toContainText('The code for the Collection page could not be loaded.')
    await expect(notice.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
    expect(requests, 'a failed dynamic import is not requested again in this page (design §1.6)').toBe(1)
    // Only this part shows a notice; the rest of the page stays.
    await expect(page.locator('[data-error-boundary]')).toHaveCount(1)
    await notice.getByRole('button', { name: 'Back to map', exact: true }).click()
    await expect(page.locator('.atlas-experience')).toHaveAttribute('data-page', 'map')
    await selectReykjavik(page)
    // A page reload loads it (the view state restores Collection).
    fail = false
    await nav.getByRole('button', { name: 'Collection', exact: true }).click()
    await expect(notice).toBeVisible()
    await Promise.all([page.waitForEvent('load'), notice.getByRole('button', { name: 'Reload page', exact: true }).click()])
    await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
    await expect(page.locator('[data-error-boundary]')).toHaveCount(0)
  })
})

// Robustness batch (design §2–§3, §6.2): a part that fails shows its own notice and the rest of the page stays; every
// error a boundary catches is reported to the page fixture, which fails the case unless the case expects the error.
test.describe('Error boundaries', () => {
  // Each case starts from the fixture's own content: the rows open dialogs on items an earlier case may have changed
  // (the Collection conversion leaves Nuuk visited, so its Mark as visited button is disabled).
  test.beforeEach(async () => { await createBrowserFixture(process.env.STARMAP_BROWSER_TEST_ROOT) })
  const at = (file) => (url) => new URL(url).pathname === `/src/components/${file}`
  const boundary = (page, name) => page.locator(`[data-error-boundary="${name}"]`)
  /** A module of the dev server replaced by one whose exports throw while rendering (no product hook needed). */
  const throwingModule = (names, message) => names.map((name) => name === 'default'
    ? `export default function Thrown() { throw new Error(${JSON.stringify(message)}) }`
    : `export function ${name}() { throw new Error(${JSON.stringify(message)}) }`).join('\n') + '\n'
  // no-store: the browser must not keep the replacement for the next load of the page (the next row).
  const serve = (body) => (route) => route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'cache-control': 'no-store' }, body })
  const nav = (page, name) => page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name, exact: true }).click()

  test('a dialog whose code does not load shows a notice in its place; Close and the page work; a page reload loads it', async ({ page }) => {
    test.setTimeout(120_000)
    expectPageError(page, 'starmap:caught-error [dialog:want-to-go-add] Failed to fetch dynamically imported module')
    let fail = true
    await page.route(at('WantToGoAddDialog.tsx'), (route) => fail ? route.abort() : route.continue())
    await openMap(page)
    await openCollection(page)
    const add = page.getByRole('button', { name: 'Add a place to visit', exact: true })
    await add.click()
    const notice = boundary(page, 'dialog:want-to-go-add')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('role', 'alert')
    await expect(notice).toContainText('The code for the “Add a place to visit” dialog could not be loaded.')
    await expect(notice.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
    // In a dialog's place: modal, the focus inside; Close gives it back.
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]')))).toBe(true)
    await notice.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect(add).toBeFocused()
    // The rest of the page stays: Collection, the map.
    await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
    await nav(page, 'Map')
    await selectReykjavik(page)
    // A page reload loads the code.
    await nav(page, 'Collection')
    await add.click()
    await expect(notice).toBeVisible()
    fail = false
    await Promise.all([page.waitForEvent('load'), notice.getByRole('button', { name: 'Reload page', exact: true }).click()])
    await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
    await add.click()
    const dialog = page.locator('.atlas-wtg-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').first().fill('Norway')
    await expect(dialog.getByRole('combobox').first()).toHaveValue('Norway')
    await expect(page.locator('[data-error-boundary]')).toHaveCount(0)
  })

  test('a page that throws while rendering shows its notice, the case receives the report it fails on, and Try again mounts it again', async ({ page }) => {
    test.setTimeout(120_000)
    const message = 'injected render error in CollectionPage'
    await page.route(at('CollectionPage.tsx'), serve(`export function CollectionPage() {\n  if (!window.__starmapCollectionMayRender) throw new Error(${JSON.stringify(message)})\n  return 'Stub collection page'\n}\n`))
    await openMap(page)
    await nav(page, 'Collection')
    const notice = boundary(page, 'page:collection')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('data-error-kind', 'render')
    await expect(notice).toContainText('Something went wrong in the Collection page, so it could not be shown.')
    // The message is folded away under the technical details; never the stack.
    await notice.locator('summary').click()
    await expect(notice.locator('details p')).toHaveText(message)
    // The report (design §3): one uncaught page error naming the boundary, which would fail an undeclared case.
    await expect.poll(() => pageErrors(page).filter((error) => error === `starmap:caught-error [page:collection] ${message}`).length).toBeGreaterThan(0)
    expectPageError(page, `starmap:caught-error [page:collection] ${message}`)
    // The rest stays.
    await expect(page.locator('[data-error-boundary]')).toHaveCount(1)
    await nav(page, 'Map')
    await selectReykjavik(page)
    await nav(page, 'Collection')
    await page.evaluate(() => { window.__starmapCollectionMayRender = true })
    await notice.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect(page.locator('.atlas-collection-stage')).toContainText('Stub collection page')
  })

  // Each boundary catches what fails inside it, and only that (design §2.2; the mutation check for every boundary).
  // [name, module, its exports, how to show the part, the part that must stay]
  const rows = [
    ['root', 'AtlasHeader.tsx', ['AtlasHeader'], async () => {}, null],
    ['map:globe', 'CesiumAtlasGlobe.tsx', ['CesiumAtlasGlobe'], async () => {}, 'nav'],
    ['map:countries', 'CountrySelector.tsx', ['CountrySelector'], async () => {}, 'nav'],
    ['map:details', 'InfoCard.tsx', ['InfoCard'], async () => {}, 'nav'],
    ['page:journey', 'Timeline.tsx', ['Timeline'], async (page) => nav(page, 'Journey'), 'nav'],
    ['page:collection', 'CollectionPage.tsx', ['CollectionPage'], async (page) => nav(page, 'Collection'), 'nav'],
    ['page:about', 'UpdateChecker.tsx', ['ReleaseUpdatePage'], async (page) => page.getByRole('button', { name: 'Version updates', exact: true }).click(), 'nav'],
    ['about:release-notes', 'ReleaseMarkdown.tsx', ['default'], async (page) => page.getByRole('button', { name: 'Version updates', exact: true }).click(), 'updates'],
    ['dialog:want-to-go-add', 'WantToGoAddDialog.tsx', ['WantToGoAddDialog'], async (page) => { await nav(page, 'Collection'); await page.getByRole('button', { name: 'Add a place to visit', exact: true }).click() }, 'nav'],
    ['dialog:convert', 'ConvertToTravelDialog.tsx', ['ConvertToTravelDialog'], async (page) => { await nav(page, 'Collection'); await page.getByRole('button', { name: 'Mark as visited: Nuuk', exact: true }).click() }, 'nav'],
    ['editor:media-recovery', 'MediaRecoveryCenter.tsx', ['MediaRecoveryCenter'], async () => {}, 'nav'],
    ['editor:media-reread', 'MediaRereadDialog.tsx', ['MediaRereadDialog'], async () => {}, 'nav'],
    ['editor:media-reimport', 'MediaReimportDialog.tsx', ['MediaReimportDialog'], async () => {}, 'nav'],
  ]
  test('each boundary catches what fails inside it, and only that', async ({ page }) => {
    test.setTimeout(300_000)
    // One route for the whole case (no unroute between rows, which races requests in flight); a row sets `current`.
    let current
    await page.route('**/src/components/**', (route) => current && new URL(route.request().url()).pathname === `/src/components/${current.file}`
      ? serve(current.body)(route) : route.fallback())
    // Soft assertions: every row is checked even when one fails (the mutation checks remove boundaries in bulk).
    for (const [name, file, exports, show, stays] of rows) {
      await test.step(name, async () => {
        const message = `injected render error for ${name}`
        const report = `starmap:caught-error [${name}] ${message}`
        expectPageError(page, report)
        current = { file, body: throwingModule(exports, message) }
        try {
          await page.goto('/')
          if (stays) await expect.soft(page.getByRole('navigation', { name: 'Primary navigation' }), `${name}: the navigation stays`).toBeVisible()
          await show(page).catch((error) => expect.soft(String(error), `${name}: the part can be shown`).toBe(''))
          await expect.soft(boundary(page, name), `${name}: its notice`).toBeVisible()
          await expect.soft(page.locator('[data-error-boundary]'), `${name}: only this boundary shows a notice`).toHaveCount(1)
          if (stays === 'updates') await expect.soft(page.locator('.atlas-update-stage').getByText('Release center', { exact: true }), `${name}: the page stays`).toBeVisible()
          await expect.soft.poll(() => pageErrors(page).includes(report), { message: `${name}: reported with its name`, timeout: 5000 }).toBe(true)
        } finally {
          current = undefined
          await page.evaluate(() => sessionStorage.clear()).catch(() => undefined)
        }
      })
    }
  })

  test('the dialogs of the media cards catch what fails inside them (panorama, city photos)', async ({ page }) => {
    test.setTimeout(120_000)
    await seedSampleMedia()
    let current
    await page.route('**/src/components/**', (route) => current && new URL(route.request().url()).pathname === `/src/components/${current.file}`
      ? serve(current.body)(route) : route.fallback())
    for (const [name, file, exports, show] of [
      ['dialog:panorama', 'DronePanoramaModal.tsx', ['DronePanoramaModal'], async () => {
        await page.getByRole('button', { name: 'Faroe Islands', exact: true }).click()
        await page.getByRole('button', { name: 'Torshavn Drone media available', exact: true }).click()
        await page.getByRole('button', { name: 'View Torshavn drone media 01', exact: true }).click()
      }],
      ['dialog:city-photos', 'CityPhotoGalleryModal.tsx', ['CityPhotoGalleryModal'], async () => {
        await selectReykjavik(page)
        await page.getByRole('button', { name: 'Open photo 1 of Reykjavik', exact: true }).click()
      }],
    ]) {
      await test.step(name, async () => {
        const message = `injected render error for ${name}`
        expectPageError(page, `starmap:caught-error [${name}] ${message}`)
        current = { file, body: throwingModule(exports, message) }
        await page.goto('/')
        await expect(page.locator('.cesium-widget canvas')).toBeVisible()
        await show()
        const notice = boundary(page, name)
        await expect(notice).toBeVisible()
        await expect(notice.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
        await notice.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.locator('[data-error-boundary]')).toHaveCount(0)
        await expect(page.locator('.atlas-info-panel h2')).toBeVisible()
        current = undefined
        await page.evaluate(() => sessionStorage.clear())
      })
    }
  })
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
      await Promise.all([page, other].map(async (tab) => {
        await openMap(tab)
        await openCollection(tab)
        await tab.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
      }))
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

  test('性能续 P5: a note editor without local edits follows a note saved in another tab, with no notice', async ({ page }) => {
    const other = await page.context().newPage()
    try {
      await Promise.all([page, other].map(async (tab) => {
        await openMap(tab)
        await openCollection(tab)
        await tab.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
      }))
      // The second tab only opened its editor; the first one saves a note.
      const otherBefore = await renderedRevision(other)
      await card(page, 'Nuuk').locator('textarea').fill('Synthetic note the other tab follows')
      await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click())
      await waitForRenderedRevision(other, { before: otherBefore })
      await expect(card(other, 'Nuuk').locator('textarea')).toHaveValue('Synthetic note the other tab follows')
      await expect(card(other, 'Nuuk').getByRole('alert')).toHaveCount(0)
      await expect(other.getByRole('button', { name: 'Save note for Nuuk', exact: true })).toBeEnabled()
    } finally { await other.close() }
  })

  test('two tabs edit the same note: the later tab can use the new content instead', async ({ page }) => {
    const other = await page.context().newPage()
    try {
      await Promise.all([page, other].map(async (tab) => {
        await openMap(tab)
        await openCollection(tab)
        await tab.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
      }))
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
      await Promise.all([page, other].map(async (tab) => {
        await openMap(tab)
        await openCollection(tab)
      }))
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
  /** The invariant of these cases: Cesium never stopped with an error (its scene.renderError), and no WebGL context was lost. */
  const expectNoRenderError = (state, when) => {
    const { renderErrorCount, lastRenderError, contextLostCount } = state?.diagnostics ?? {}
    expect({ renderErrorCount, contextLostCount }, `Cesium render errors ${renderErrorCount} and lost WebGL contexts ${contextLostCount} ${when} (viewer ${state?.viewer}): ${lastRenderError}`)
      .toEqual({ renderErrorCount: 0, contextLostCount: 0 })
  }
  /**
   * 性能续 P7: the pause of the next click on `selector` is bounded by the watchdog without a duration budget. In the
   * page, right after the app's own click handler (as showPageAtPause), a timer of the watchdog's limit is set once the
   * pause has started; the watchdog's timer was set earlier with the same delay, so it runs first however late the main
   * thread lets timers run (long tasks, a GPU wait, a starved CPU). When the probe fires, that pause must be over.
   */
  const PAUSE_LIMIT_MS = 1500 // ../../src/data/renderPause.ts RENDER_PAUSE_LIMIT_MS
  const armPauseProbe = (page, selector) => page.evaluate(({ selector, limitMs }) => {
    delete window.__starmapPauseProbe
    const clicked = (event) => {
      if (!event.target.closest?.(selector)) return
      document.removeEventListener('click', clicked)
      // The debug object of this moment: it reads the pause state of the page even after its viewer is replaced.
      const debug = window.__travelAtlasDebugRenderLoop
      const arm = () => {
        const state = debug.state()
        if (!state.paused) {
          if (performance.now() - event.timeStamp < limitMs) return void setTimeout(arm, 0)
          window.__starmapPauseProbe = { armed: false, fired: true }
          return
        }
        const last = state.episodes.at(-1)
        const armedAt = performance.now()
        window.__starmapPauseProbe = { armed: true, fired: false }
        setTimeout(() => {
          const now = debug.state()
          window.__starmapPauseProbe = { armed: true, fired: true, paused: now.paused, ended: now.episodes.at(-1) !== undefined && now.episodes.at(-1) !== last,
            firedAfterMs: Math.round(performance.now() - armedAt), episode: now.episodes.at(-1) }
        }, limitMs)
      }
      arm()
    }
    document.addEventListener('click', clicked)
  }, { selector, limitMs: PAUSE_LIMIT_MS })
  /** The probe of armPauseProbe fired: the pause it saw start had ended (by the watchdog at the latest). */
  async function expectEndedByTheLimit(page) {
    await expect.poll(() => page.evaluate(() => window.__starmapPauseProbe?.fired === true), { timeout: 30000 }).toBe(true)
    const probe = await page.evaluate(() => window.__starmapPauseProbe)
    test.info().annotations.push({ type: 'pause probe', description: JSON.stringify(probe) })
    expect(probe, `the pause was over when a ${PAUSE_LIMIT_MS} ms timer set at its start fired: ${JSON.stringify(probe)}`)
      .toMatchObject({ armed: true, paused: false, ended: true })
    return probe
  }
  /**
   * The save's editor write, as the page sends it (a Want to Go item added, or one updated). Test stability F2 (design
   * §14): the A′ cases no longer read the pause from outside while it lasts; what they do during it, and the start it is
   * checked against, come from the page (`clickSaveInPage`, `armAtSaveClick`).
   */
  const writeSent = (page) => page.waitForRequest((sent) => sent.method() === 'POST'
    && ['/__travelatlas/editor/wanttogo', '/__travelatlas/editor/wanttogo/update'].includes(new URL(sent.url()).pathname))
  /**
   * Resumed (by `endedBy` when given) and rendering: the loop is on, no render error and no lost context, and at least
   * two new frames within 5 s (a stopped loop draws none; software GL on CI can draw a frame only every second or so).
   */
  async function expectRendering(page, endedBy) {
    await expect.poll(async () => (await loop(page))?.paused, { timeout: 5000 }).toBe(false)
    const state = await loop(page)
    // A lost context or a render error first: they explain a loop that stays off.
    expectNoRenderError(state, `at the resume (${endedBy ?? 'any'})`)
    expect(state.useDefaultRenderLoop, 'the loop is on at the resume').toBe(true)
    if (endedBy) expect(state.episodes.at(-1)?.endedBy).toBe(endedBy)
    let lastObserved = state
    try {
      await expect.poll(async () => {
        lastObserved = await loop(page)
        return lastObserved.frames - state.framesAtResume
      }, { timeout: 5000, intervals: [100, 250] }).toBeGreaterThanOrEqual(2)
    } catch (error) {
      // No extra page RPC after the deadline; preserve the original failure even if attachment collection fails.
      await (async () => {
        const evidence = test.info().outputPath('render-recovery-diagnostics.json')
        await writeFile(evidence, JSON.stringify({ budgetMs: 5000, minimumFrames: 2, expectedCause: endedBy ?? null,
          baseline: state, lastObserved, collectedAfterFailure: true }) + '\n')
        await test.info().attach('Render recovery failure diagnostics', { path: evidence, contentType: 'application/json' })
      })().catch(() => {})
      throw error
    }
    expect(lastObserved.useDefaultRenderLoop, 'the loop is still on').toBe(true)
    expectNoRenderError(lastObserved, `after the resume (${endedBy ?? 'any'})`)
    return state
  }
  // Diagnostic-only proposal: browser CPU sampling is armed before the real save action, never inside its frame gate.
  const renderCpuProfiles = new WeakMap()
  async function finishRenderCpuProfile(page, info) {
    const entry = renderCpuProfiles.get(page)
    if (!entry) return
    renderCpuProfiles.delete(page)
    try {
      if (entry.setupFailure) throw Object.assign(new Error('Render profiler unavailable'), { name: entry.setupFailure })
      const { profile } = await diagnosticDeadline(entry.session.send('Profiler.stop'))
      if (!info || info.status === info.expectedStatus) return
      for (const node of profile.nodes) {
        try {
          const url = new URL(node.callFrame.url)
          node.callFrame.url = url.origin === 'http://127.0.0.1:5173' ? url.pathname : '[other-origin]'
        } catch { node.callFrame.url = '' }
      }
      const bytes = JSON.stringify(profile)
      if (Buffer.byteLength(bytes) > 16000000) throw new Error('Render profile exceeds16MB')
      const destination = info.outputPath('render-recovery.cpuprofile')
      await writeFile(destination, bytes)
      const context = info.outputPath('render-recovery-profile-context.json')
      await writeFile(context, JSON.stringify({ format: 'starmap.render-cpu-profile-context', samplingIntervalUs: 2000,
        armedBefore: entry.armedBefore, armedAfter: entry.armedAfter, nativeStartUs: profile.startTime, nativeEndUs: profile.endTime,
        alignmentHasProtocolResponseUncertainty: true, diagnosticOnly: true }))
      await info.attach('Render recovery CPU profile', { path: destination, contentType: 'application/json' })
      await info.attach('Render recovery CPU profile context', { path: context, contentType: 'application/json' })
    } catch (error) {
      if (info && info.status !== info.expectedStatus) {
        const destination = info.outputPath('render-recovery-profile-unavailable.json')
        await writeFile(destination, JSON.stringify({ format: 'starmap.render-profile-unavailable',
          errorName: error.name, diagnosticDeadlineMs: 1500, deadlineDoesNotCancelRpc: true })).catch(() => {})
      }
    } finally {
      // The deadline discards a late response; it does not cancel the RPC. The existing fixture still owns browser closure.
      if (entry.session) await diagnosticDeadline(entry.session.detach()).catch(() => {})
    }
  }
  test.afterEach(async ({ page }, info) => {
    // These share Chromium instrumentation: finish the trace while the CPU sampler is still attached.
    await finishSchedulerTrace(page, info)
    await finishRenderCpuProfile(page, info)
    // Checked last, so a failure here never skips the evidence above. A closed page has no state to check.
    const final = await loop(page).catch(() => undefined)
    if (final?.diagnostics) expectNoRenderError(final, 'at the end of the case')
  })

  /**
   * The want-to-go write of the info card, answered `ms` after the save's click (or as `fulfil` says). Test stability
   * F2-1: the wait counts from the click as the page saw it (its event time on the wall clock), not from this handler:
   * Playwright calls a route handler only once the page has reported the request, which a main thread waiting on the GPU
   * delays (CI, software GL: 0.98 and 1.38 s after the save's click, 2026-11-03/05), and a fixed wait from here added
   * that delay to the save. (The request's own `timing().startTime` is 0 until its response.) Without a recorded click
   * the wait counts from the handler, as before.
   */
  const holdWrite = async (page, { ms = 0, fulfil } = {}) => {
    if (ms) await page.evaluate(() => {
      delete window.__starmapSaveClickedAt
      document.addEventListener('click', (event) => {
        if (event.target.closest?.('.atlas-city-wtg-button')) window.__starmapSaveClickedAt = performance.timeOrigin + event.timeStamp
      }, { capture: true })
    })
    return page.route('**/__travelatlas/editor/wanttogo', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      if (ms) {
        const clickedAt = await diagnosticDeadline(page.evaluate(() => window.__starmapSaveClickedAt)).catch(() => undefined)
        const handlerAfterClickMs = Number.isFinite(clickedAt) ? Math.round(Date.now() - clickedAt) : undefined
        const waitMs = handlerAfterClickMs === undefined ? ms : Math.max(0, ms - handlerAfterClickMs)
        try { test.info().annotations.push({ type: 'held write', description: JSON.stringify({ ms, handlerAfterClickMs, waitMs }) }) } catch { /* After the case. */ }
        console.info('A′ held write', JSON.stringify({ ms, handlerAfterClickMs, waitMs }))
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
      return fulfil ? route.fulfill(fulfil) : route.continue()
    })
  }
  /**
   * A save clicked in the page (test stability F2, design §11 and §14), for the A′ cases whose save must be answered and
   * applied (or refused) before the 1.5 s watchdog ends its pause: the first case, and a refused save, an unknown outcome
   * or applying that throws. On CI's software rendering the task of a real (Playwright) click waited on a compositor
   * commit after the app's click handler: of 80 real clicks in the runs of 2026-11-06 (42187578007, 42192357428), 6
   * failed, each with the click's own task taking 0.6-1.5 s and another long task after it, so that the watchdog ended the
   * pause before the change could be applied. The whole-group run 42222477775 (2026-11-06) failed the same way, in the
   * refused save's first click (then critical-flows.spec.mjs:1321; `failed` expected, `limit` received): the page sent the
   * write at 13:23:20.001, so the watchdog was due at 21.501; the click's task was busy 1.33 s, mostly native code after
   * the app's handler, then another task 0.45 s; Playwright saw the request at 21.614 and answered it at 21.634, after
   * the watchdog. Of 120 clicks made in the page, every save's pause ended by its applying. So the button is first
   * checked as the user finds it (visible, enabled), then clicked in the page, and in that same task, right after the
   * click, the save's pause must have started (read from the render loop's state in the same evaluate). The same read
   * records what the pause starts from (the frame count, the viewer, the pauses ended so far): `expectNoFrameWhilePaused`
   * checks the whole pause against it once the pause is over. The real click on this button stays covered: in the A′
   * cases by the save of another page (the page is switched from the page itself, `showPageAtPause`) and by
   * map-recovery.spec.mjs's lost context (`armAtSaveClick`); elsewhere by "a Want to Go item added on the map is still
   * there after a reload", "a save keeps the camera, ...", "pages that are not shown keep their scroll position, ..." and
   * map-recovery.spec.mjs's case without WebGL. The A′ cases' other buttons (a note's save, Hide, Restore) are clicked for
   * real, with `armAtSaveClick`.
   */
  async function clickSaveInPage(page) {
    const button = page.getByRole('button', { name: 'Mark as Want to Go', exact: true })
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/__travelatlas/editor/wanttogo')
    const started = await button.evaluate((element) => {
      const loop = window.__travelAtlasDebugRenderLoop
      const before = loop.state()
      element.click()
      const after = loop.state()
      return { pausedBefore: before.paused, pausedAfter: after.paused, countAfter: after.count, episodesEnded: after.episodes.length - before.episodes.length,
        framesAtStart: after.frames, viewer: after.viewer, episodesAtStart: after.episodes.length }
    })
    test.info().annotations.push({ type: 'save clicked in the page', description: JSON.stringify(started) })
    expectPauseStarted(started)
    await sent
    return started
  }
  /**
   * No frame was drawn while the save's pause lasted, from its start to its resume, on the same viewer. Proven from the
   * page's own records, so the case need not read the page before the pause ends (on CI a read 0.6 s after the click can
   * come too late, run 42199897309): the frame count recorded in the click's task (`clickSaveInPage`, `armAtSaveClick`)
   * equals the frame count the page recorded at the resume (`framesAtResume`), and this pause is the only one ended since
   * the click. This covers the whole pause, where the live check it replaced (a page read, 250 ms, another read) covered a
   * 250 ms window of it.
   */
  function expectNoFrameWhilePaused(state, started) {
    const evidence = `no frame while paused: ${JSON.stringify({ started, viewer: state.viewer, frames: state.frames, framesAtResume: state.framesAtResume, episodes: state.episodes.slice(started.episodesAtStart) })}`
    expect(state.viewer, evidence).toBe(started.viewer)
    expect(state.episodes.length - started.episodesAtStart, evidence).toBe(1)
    expect(state.framesAtResume, evidence).toBe(started.framesAtStart)
  }
  const markReykjavik = async (page, { observePause = false } = {}) => {
    await finishSchedulerTrace(page)
    await finishRenderCpuProfile(page)
    // D3: the evidence is armed first, so that its own start (Profiler.start took 0.48 s on CI) is over before the click.
    if (observePause) await armSchedulerTrace(page)
    let session
    try {
      session = await page.context().newCDPSession(page)
      const entry = { session }
      renderCpuProfiles.set(page, entry)
      await session.send('Profiler.enable')
      await session.send('Profiler.setSamplingInterval', { interval: 2000 })
      entry.armedBefore = { monotonicMs: performance.now(), wallMs: Date.now() }
      await session.send('Profiler.start')
      entry.armedAfter = { monotonicMs: performance.now(), wallMs: Date.now() }
    } catch (error) {
      renderCpuProfiles.set(page, { setupFailure: error.name })
      if (session) await diagnosticDeadline(session.detach()).catch(() => {})
    }
    const action = () => page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click()
    if (observePause) return clickSaveInPage(page)
    await action()
  }
  /**
   * The next click on the Want to Go button shows the page `name` as soon as the save's pause has started: in the page,
   * right after the app's own click handler (or on the first task that sees the pause, if it starts later), with no
   * input-driver wait, which on a busy runner can outlast the 1.5 s watchdog. Records whether the loop was paused at the
   * switch and how long after the save's click it came (an upper bound of the time since the pause started).
   */
  const showPageAtPause = (page, name) => page.evaluate((name) => {
    delete window.__starmapPageAtPause
    const saveClicked = (event) => {
      if (!event.target.closest?.('.atlas-city-wtg-button')) return
      document.removeEventListener('click', saveClicked)
      const show = () => {
        const { paused } = window.__travelAtlasDebugRenderLoop.state()
        if (!paused && performance.now() - event.timeStamp < 1500) return void setTimeout(show, 0)
        const at = performance.now()
        ;[...document.querySelectorAll('nav button')].find((button) => button.textContent.trim() === name).click()
        window.__starmapPageAtPause = { paused, msAfterSaveClick: Math.round((at - event.timeStamp) * 10) / 10 }
      }
      show()
    }
    document.addEventListener('click', saveClicked)
  }, name)
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
    await armPauseProbe(page, '.atlas-city-wtg-button')
    const started = await markReykjavik(page, { observePause: true })
    await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
    const state = await expectRendering(page, 'applied')
    expectNoFrameWhilePaused(state, started)
    expect(state.episodes.at(-1).pausedMs).toBeGreaterThan(500)
    // Within the limit (性能续 P7: by the probe, not a duration).
    await expectEndedByTheLimit(page)
  })

  test('a refused save, an unknown outcome, or applying that throws: the map renders again at once', async ({ page }) => {
    // Each save is clicked in the page (`clickSaveInPage`): its pause must end by its answer, before the watchdog (a real
    // click here failed in run 42222477775, design §14). Test stability follow-ups G5 (design §5, §10.2): each answer
    // comes 600 ms after the save's click, as in the first case, so that the pause lasts long enough for the globe to draw
    // frames were it not paused; with immediate answers the pauses lasted 0.1-0.3 s, and a pause that does not stop the
    // loop passed the check of the recorded frames. Before each save the map has drawn its frames after the selection,
    // as in the first case: right after a selection it still compiles the new view's shaders, and the frames after the
    // resume waited for them (run 42348286017: 1 of 40, no frame within 5 s).
    const save = async (fulfil, endedBy) => {
      await expectRendering(page)
      await holdWrite(page, { ms: 600, fulfil })
      const started = await markReykjavik(page, { observePause: true })
      const state = await expectRendering(page, endedBy)
      expectNoFrameWhilePaused(state, started)
      expect(state.episodes.at(-1).pausedMs).toBeGreaterThan(500)
    }
    await openMap(page)
    await selectReykjavik(page)
    // Refused by the server.
    await save({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'E_INVALID_INPUT', error: 'refused' }) }, 'failed')
    await page.unroute('**/__travelatlas/editor/wanttogo')
    // (A failed add asks for a reload before the next one.)
    await page.reload()
    await reykjavikAgain(page)
    // Applying the answer throws: rows that do not fit, and the changes that would replace them cannot be read.
    const revision = Number(await renderedRevision(page))
    await page.route('**/__travelatlas/editor/read-model/changes**', (route) => route.fulfill({ status: 500, body: 'unavailable' }))
    await save({ status: 201, contentType: 'application/json', body: JSON.stringify({
      // (A replayed answer: the parser takes it without an item; the rows are what fails.)
      ok: true, duplicate: true, revision: revision + 1, delta: { from: revision, to: revision + 1, upserts: [{ table: 'entries', row: { id: 7 } }], deletes: [] },
    }) }, 'released')
    await page.unroute('**/__travelatlas/editor/wanttogo')
    await page.unroute('**/__travelatlas/editor/read-model/changes**')
    await page.reload()
    await reykjavikAgain(page)
    // The outcome stays unknown (an unreadable answer every time): resumed at the first failed try.
    await save({ status: 502, contentType: 'text/html', body: '<p>Bad gateway</p>' }, 'failed')
    await expect(page.getByText(/Nothing more can be saved until you reload|may have saved data/).first()).toBeVisible()
  })

  test('another page, a hidden page, or the watchdog end a pause while the save is still in flight', async ({ page }) => {
    await openMap(page)
    await selectReykjavik(page)
    await holdWrite(page, { ms: 2500 })
    // Another page, shown in the page as soon as the pause has started (the real save, its write request).
    const requested = page.waitForRequest((sent) => sent.method() === 'POST' && new URL(sent.url()).pathname === '/__travelatlas/editor/wanttogo')
    await showPageAtPause(page, 'Collection')
    await markReykjavik(page)
    await requested
    await expect.poll(() => page.evaluate(() => window.__starmapPageAtPause), { timeout: 5000 }).toBeTruthy()
    const shown = await page.evaluate(() => window.__starmapPageAtPause)
    test.info().annotations.push({ type: 'page switch at the pause', description: JSON.stringify(shown) })
    expect.soft(shown.paused, `the loop was paused when the page switched: ${JSON.stringify(shown)}`).toBe(true)
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
    // Hidden from the page, in the save click's task once its pause has started (as the page switch above; design §14).
    await armAtSaveClick(page, 'button[aria-label="Save note for Akureyri"]', 'hide')
    let sent = writeSent(page)
    await page.getByRole('button', { name: 'Save note for Akureyri', exact: true }).click()
    await sent
    const hidden = await pauseStartedAtClick(page)
    expect(hidden.afterAct, `the hidden page ended the save's pause at once: ${JSON.stringify(hidden)}`)
      .toEqual({ paused: false, episodes: hidden.episodesAtStart + 1, endedBy: 'hidden' })
    await expectRendering(page, 'hidden')
    await expect(page.locator('.collection-card textarea')).toHaveCount(0, { timeout: 10000 })
    // The watchdog: a save whose answer takes longer than the limit. No frame while it lasts, from the page's records.
    await armPauseProbe(page, 'button[aria-label="Hide: Nuuk"]')
    await armAtSaveClick(page, 'button[aria-label="Hide: Nuuk"]')
    sent = writeSent(page)
    await page.getByRole('button', { name: 'Hide: Nuuk', exact: true }).click()
    await sent
    const started = await pauseStartedAtClick(page)
    const state = await expectRendering(page, 'limit')
    expectNoFrameWhilePaused(state, started)
    expect(state.episodes.at(-1).pausedMs).toBeGreaterThanOrEqual(1500)
    // Ended by the watchdog when its time came (性能续 P7: the probe instead of a 1.7 s budget).
    await expectEndedByTheLimit(page)
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
    // Two saves in flight together: one pause, ended when the last one is applied. Both clicked in one task (a click
    // through the test driver can wait until the first save is done); in that task the pause has started with both saves
    // in it, and what it starts from is recorded for the check of the frames at its end (as the first case).
    const started = await page.evaluate(() => {
      const loop = window.__travelAtlasDebugRenderLoop
      const before = loop.state()
      for (const label of ['Hide: Akureyri', 'Hide: Nuuk']) document.querySelector(`button[aria-label="${label}"]`).click()
      const after = loop.state()
      return { pausedBefore: before.paused, pausedAfter: after.paused, countAfter: after.count, episodesEnded: after.episodes.length - before.episodes.length,
        framesAtStart: after.frames, viewer: after.viewer, episodesAtStart: after.episodes.length }
    })
    test.info().annotations.push({ type: 'saves clicked in the page', description: JSON.stringify(started) })
    expectPauseStarted(started, 2)
    await expect(page.getByRole('button', { name: 'Restore: Akureyri', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore: Nuuk', exact: true })).toBeVisible()
    // One pause for both (the later write may meet E_STALE and be sent again: its first try then ends its part), with no
    // frame while it lasted.
    const after = await expectRendering(page)
    expectNoFrameWhilePaused(after, started)
    // The viewer is replaced (destroyed and made again) during a pause: the new one renders once the save is applied.
    const viewer = after.viewer
    // The main thread's long tasks from here on (making the new viewer is one; with software rendering, seconds).
    const clickedAt = await page.evaluate(() => {
      if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) throw new Error('No long task timing in this browser')
      window.__starmapLongTasks = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__starmapLongTasks.push([entry.startTime, entry.startTime + entry.duration])
      }).observe({ type: 'longtask' })
      return performance.now()
    })
    await armPauseProbe(page, 'button[aria-label="Restore: Akureyri"]')
    // Replaced from the page, in the restore click's task once its pause has started (design §14).
    await armAtSaveClick(page, 'button[aria-label="Restore: Akureyri"]', 'replaceViewer')
    const sent = writeSent(page)
    await page.getByRole('button', { name: 'Restore: Akureyri', exact: true }).click()
    await sent
    const restoring = await pauseStartedAtClick(page)
    expect(restoring.viewer, 'the restore started on the viewer that was replaced').toBe(viewer)
    await expect.poll(async () => (await loop(page))?.viewer, { timeout: 10000 }).not.toBe(viewer)
    await expect(page.getByRole('button', { name: 'Hide: Akureyri', exact: true })).toBeVisible()
    // Ended by the applying, or by the watchdog. 性能续 P7: the watchdog's timer runs only when the main thread lets it
    // (making the new viewer is a long task; a GPU wait or a starved CPU is not one), so no duration budget: when a
    // timer set at the pause's start for the same limit fired, the pause was over. The pause and the long tasks during
    // it stay as evidence.
    const replaced = await expectRendering(page)
    const { endedBy, pausedMs } = replaced.episodes.at(-1)
    expect(['applied', 'limit']).toContain(endedBy)
    const blockedMs = await page.evaluate(([from, to]) => window.__starmapLongTasks
      .reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, to) - Math.max(start, from)), 0), [clickedAt, clickedAt + pausedMs + 250])
    test.info().annotations.push({ type: 'pause and long tasks', description: JSON.stringify({ endedBy, pausedMs, blockedMs: Math.round(blockedMs) }) })
    await expectEndedByTheLimit(page)
  })
})
