// 3C-4d (decision D-a A; review §7-4 and §8-2): a private root whose personal data is still V2 files needs migrating.
// The page shows the data read-only with a notice; every write, the media tasks included, is refused with
// E_STORE_MIGRATION_REQUIRED. `npm run store:migrate -- --apply` while the dev server runs creates the new library; the
// dev server sees the new file, reloads the page by itself and serves the store, and writes work: no restart.
// Only the `--migration` group runs this file (playwright.config.mjs matches *.migration.mjs for it), on a fixture the
// runner leaves unmigrated (scripts/browser-fixture.mjs mode 'v2').
import { test, expect, openMap, openCollection, readFixture, saveAndWaitForReload } from './helpers.mjs'
import { PRIVATE_MODULE_PATH, fixtureIds, storeRevisionOf } from '../../scripts/browser-fixture.mjs'
import { privateDataState } from '../../scripts/private-data-source.mjs'
import { getPrivatePaths } from '../../scripts/private-profile.mjs'
import { applyMigration } from '../../scripts/store-migrate.mjs'

const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
const notice = 'Your personal data has not been migrated to the new library yet. It is read-only and edits are not saved.'
const served = async (page, name) => new RegExp(`${name} = ([A-Za-z0-9_]+)`).exec(await (await page.request.get(PRIVATE_MODULE_PATH)).text())?.[1]
/** GET of the media task list as the page sends it. */
const taskList = (page) => page.evaluate(async () => {
  const response = await fetch('/__travelatlas/editor/media/jobs', { headers: { 'x-travelatlas-local-editor': '1' } })
  return { status: response.status, body: await response.json() }
})

test('a root that needs migrating is read-only with a notice; store:migrate --apply switches the open page to the new library without a restart', async ({ page }) => {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root() })
  expect(privateDataState(paths).state).toBe('migration-required')
  expect(await served(page, 'privateStoreMigrationRequired')).toBe('true')
  await openMap(page)
  await expect(page.getByText(notice, { exact: true })).toBeVisible()
  await expect(page.getByText(/npm run store:migrate -- --apply/)).toBeVisible()

  // The data is shown; a save is refused before anything is written, and so is the media task list.
  await openCollection(page)
  await page.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
  await page.locator('.collection-card textarea').fill('Synthetic note before migrating')
  const refused = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo/update'))
  await page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click()
  const response = await refused
  expect(response.status()).toBe(409)
  expect((await response.json()).code).toBe('E_STORE_MIGRATION_REQUIRED')
  await expect(page.locator('.collection-card-notice')).toContainText('has not been migrated to the new library yet')
  const tasks = await taskList(page)
  expect(tasks.status).toBe(409)
  expect(tasks.body.code).toBe('E_STORE_MIGRATION_REQUIRED')
  expect(privateDataState(paths).state).toBe('migration-required')
  const notes = (await readFixture('wantToGo')).items.filter((item) => item.placeId === fixtureIds.nuuk).map((item) => item.note)
  expect(notes).not.toContain('Synthetic note before migrating')

  // `npm run store:migrate -- --apply` in another terminal: the dev server reloads the open page by itself.
  const reloaded = page.waitForEvent('framenavigated', { timeout: 30000 })
  await applyMigration(paths)
  await reloaded
  await expect.poll(() => served(page, 'privateStoreRevision')).toBe('1')
  await expect(page.getByText(notice, { exact: true })).toHaveCount(0)
  expect((await taskList(page)).status).toBe(200)

  // Writes go to the store now.
  await page.goto('/')
  await openCollection(page)
  await page.getByRole('button', { name: 'Edit note for Nuuk', exact: true }).click()
  await page.locator('.collection-card textarea').fill('Synthetic note after migrating')
  await saveAndWaitForReload(page, async () => {
    const saved = page.waitForResponse((response) => response.url().endsWith('/editor/wanttogo/update'))
    await page.getByRole('button', { name: 'Save note for Nuuk', exact: true }).click()
    expect((await saved).status()).toBe(200)
  })
  expect(await storeRevisionOf(root())).toBe(2)
  expect((await readFixture('wantToGo')).items.find((item) => item.placeId === fixtureIds.nuuk).note).toBe('Synthetic note after migrating')
  await openCollection(page)
  await expect(page.locator('.collection-card').filter({ hasText: 'Nuuk' }).locator('.collection-card-note')).toHaveText('“Synthetic note after migrating”')
})
