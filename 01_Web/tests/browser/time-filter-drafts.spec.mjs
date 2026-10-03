import { test, expect, openMap, selectReykjavik, openCollection, readFixture } from './helpers.mjs'
import { createBrowserFixture, fixtureFileNames, fixtureIds } from '../../scripts/browser-fixture.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'

const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) {
  throw new Error('Draft checks require the isolated browser runner fixture.')
}
const panel = (page) => page.locator('#atlas-time-query-panel')

test.beforeEach(async () => { await createBrowserFixture(root) })
test.afterEach(async ({ page }) => {
  await page.close()
  await createBrowserFixture(root)
})

async function patchFixture(key, change) {
  const value = await readFixture(key)
  change(value)
  await writeFile(path.join(root, 'data', 'v2', fixtureFileNames[key]), JSON.stringify(value, null, 2) + '\n')
}
async function hashes() {
  return Object.fromEntries(await Promise.all(Object.entries(fixtureFileNames).map(async ([key, name]) =>
    [key, createHash('sha256').update(await readFile(path.join(root, 'data', 'v2', name))).digest('hex')],
  )))
}
function captureWrites(page) {
  const writes = []
  page.on('request', (request) => {
    if (request.url().includes('/__travelatlas/editor/') && !['GET', 'HEAD'].includes(request.method())) {
      writes.push({ url: request.url(), method: request.method() })
    }
  })
  return writes
}
async function applyYear(page, value, id = 'travel') {
  await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
  const layer = panel(page).locator(`.layer-time-filter[data-layer="${id}"]`)
  if (!await layer.getByLabel('Year shortcut', { exact: true }).isVisible()) await layer.locator('summary').click()
  await layer.getByLabel('Year shortcut', { exact: true }).fill(String(value))
  await layer.getByRole('button', { name: 'Use this year', exact: true }).click()
  await panel(page).getByRole('button', { name: 'Close', exact: true }).click()
}

test('an unsaved photo layout survives empty time results and saves to the original selected city', async ({ page }) => {
  const mediaIds = ['synthetic-reykjavik-photo-one', 'synthetic-reykjavik-photo-two']
  await patchFixture('media', (file) => {
    file.items = mediaIds.map((id, index) => ({
      id, kind: 'photo', scope: 'city', status: 'ready', isCover: false,
      placeId: fixtureIds.reykjavik, src: `/media/user/synthetic-drafts/${index}.png`,
      originalFileName: `synthetic-${index}.png`,
    }))
  })
  const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 70, g: 135, b: 190 } } }).png().toBuffer()
  await page.route('**/media/user/synthetic-drafts/*.png', (route) => route.fulfill({ contentType: 'image/png', body: image }))
  const before = await hashes()
  const writes = captureWrites(page)
  await openMap(page)
  await selectReykjavik(page)
  await page.getByRole('button', { name: 'Edit city photos', exact: true }).click()
  const info = page.locator('.atlas-info-panel')
  const secondPhoto = info.locator(`[data-flip-id="${mediaIds[1]}"]`)
  await secondPhoto.getByRole('button', { name: 'Set as city cover', exact: true }).click()
  await info.locator(`[data-flip-id="${mediaIds[0]}"]`).getByRole('button', { name: 'Hide photo', exact: true }).click()
  await expect(info.locator('.city-photo-card')).toHaveCount(1)
  await expect(secondPhoto.getByRole('button', { name: 'Set as city cover', exact: true })).toHaveAttribute('data-active', 'true')
  await applyYear(page, 2023)
  await expect(info.locator('[data-time-filter-outside]')).toBeVisible()
  await expect(info.locator('h2')).toHaveText('Reykjavik')
  await openCollection(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await expect(info.getByRole('button', { name: 'Save city photos', exact: true })).toBeVisible()
  await expect(info.locator('.city-photo-card')).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  await expect(info.locator('.city-photo-card')).toHaveAttribute('data-flip-id', mediaIds[1])
  await expect(info.getByRole('button', { name: '设为城市封面', exact: true })).toHaveAttribute('data-active', 'true')
  expect(writes).toEqual([])
  expect(await hashes()).toEqual(before)
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en')
  const saved = page.waitForResponse((response) => response.url().endsWith('/editor/state') && response.request().method() === 'PUT')
  await info.getByRole('button', { name: 'Save city photos', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  await expect.poll(async () => (await readFixture('editorState')).mediaOrderByCity[fixtureIds.reykjavik]).toEqual([mediaIds[1]])
  const state = await readFixture('editorState')
  expect(state.coverMediaByCity[fixtureIds.reykjavik]).toBe(mediaIds[1])
  expect(state.hiddenMediaIds).toContain(mediaIds[0])
  expect(Object.keys(state.mediaOrderByCity)).toEqual([fixtureIds.reykjavik])
  expect(writes).toHaveLength(1)
  expect(writes[0].method).toBe('PUT')
  const after = await hashes()
  for (const key of ['travel', 'places', 'wantToGo', 'media']) expect(after[key]).toBe(before[key])
})

test('Collection note drafts survive time changes; a colliding planned conversion keeps its own dates and identity', async ({ page }) => {
  const sharedId = 'synthetic-draft-shared-id'
  await patchFixture('travel', (file) => {
    const planned = file.records.find((record) => record.status === 'planned')
    planned.id = sharedId
    planned.notes = 'Synthetic planned conversion target'
  })
  await patchFixture('wantToGo', (file) => {
    file.items.push({ id: sharedId, placeId: '019b76da-a80a-7000-8000-00000000000a',
      addedAt: '2020-06-01', hidden: false, note: 'Synthetic saved note target' })
  })
  const before = await hashes()
  const writes = captureWrites(page)
  await openMap(page)
  await openCollection(page)
  const savedCard = page.locator('.collection-card').filter({ hasText: 'Synthetic saved note target' })
  await savedCard.getByRole('button', { name: 'Edit note for Bergen', exact: true }).click()
  const note = savedCard.locator('textarea')
  await note.fill('Synthetic unsaved note · 保留原来源')
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await applyYear(page, 2023)
  await applyYear(page, 2030, 'want_to_go')
  await openCollection(page)
  // Editing replaces the original note text, so identify this still-mounted card by its textarea.
  const draft = page.locator('.collection-card textarea')
  await expect(draft).toHaveValue('Synthetic unsaved note · 保留原来源')
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(page.getByText('No records match the current time filters', { exact: true })).toBeVisible()
  await openCollection(page)
  await expect(draft).toHaveValue('Synthetic unsaved note · 保留原来源')
  expect(writes).toEqual([])
  expect(await hashes()).toEqual(before)
  const plannedCard = page.locator('.collection-card').filter({ hasText: 'Synthetic planned conversion target' })
  await plannedCard.getByRole('button', { name: 'Mark as visited: Bergen', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('This planned visit will be marked as visited using the dates you enter.')
  await dialog.getByLabel('Visit date', { exact: true }).fill('2029-12-30')
  await dialog.getByLabel('End date (optional)', { exact: true }).fill('2030-01-03')
  await expect(dialog.locator('input[type=checkbox]')).toHaveCount(0)
  // This modal intentionally covers page navigation and the time controls. Do not
  // bypass its backdrop to invent a time-change-with-dialog-open scenario.
  let submitted
  await page.route('**/editor/wanttogo/convert', async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({ status: 400, json: { ok: false, code: 'E_PLANNED_NOT_FOUND', error: 'Synthetic non-writing conversion response' } })
  })
  const response = page.waitForResponse((result) => result.url().endsWith('/editor/wanttogo/convert'))
  await dialog.getByRole('button', { name: 'Mark as visited', exact: true }).click()
  expect((await response).status()).toBe(400)
  expect(submitted).toEqual({ source: 'planned', recordId: sharedId, startDate: '2029-12-30', endDate: '2030-01-03' })
  await expect(dialog.getByLabel('Visit date', { exact: true })).toHaveValue('2029-12-30')
  await expect(dialog.getByLabel('End date (optional)', { exact: true })).toHaveValue('2030-01-03')
  await dialog.getByRole('button', { name: 'Close mark as visited dialog', exact: true }).click()
  await expect(draft).toHaveValue('Synthetic unsaved note · 保留原来源')
  expect(writes).toHaveLength(1)
  expect(await hashes()).toEqual(before)
})
