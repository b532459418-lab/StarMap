import { test, expect, openMap, selectReykjavik, openCollection, readFixture } from './helpers.mjs'
import { createBrowserFixture, fixtureIds } from '../../scripts/browser-fixture.mjs'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) {
  throw new Error('Camera and layer checks require the isolated browser runner fixture.')
}
const storageKey = 'starmap.layerTimeFilters.v1'
const panel = (page) => page.locator('#atlas-time-query-panel')

test.beforeEach(async () => { await createBrowserFixture(root) })
test.afterEach(async ({ page }) => {
  await page.close()
  await createBrowserFixture(root)
})

async function filters(page, id = 'travel') {
  if (!await panel(page).isVisible()) {
    await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
  }
  const editor = panel(page).locator(`.layer-time-filter[data-layer="${id}"]`)
  if (!await editor.getByLabel('Year shortcut', { exact: true }).isVisible()) await editor.locator('summary').click()
  return editor
}

async function year(page, value, id = 'travel') {
  const editor = await filters(page, id)
  await editor.getByLabel('Year shortcut', { exact: true }).fill(String(value))
  await editor.getByRole('button', { name: 'Use this year', exact: true }).click()
}

async function closeFilters(page) {
  if (await panel(page).isVisible()) await panel(page).getByRole('button', { name: 'Close', exact: true }).click()
}

const cameraPose = (page) => page.evaluate(() => window.__travelAtlasDebugCamera?.getCameraPose())
const poseTolerances = { height: 0.1, heading: 0.000001, lat: 0.000001, lng: 0.000001, pitch: 0.000001, roll: 0.000001 }
const samePose = (left, right) => left && right && Object.entries(poseTolerances)
  .every(([key, tolerance]) => Number.isFinite(left[key]) && Number.isFinite(right[key]) && Math.abs(left[key] - right[key]) <= tolerance)

async function settledCameraPose(page) {
  let previous
  let stableSamples = 0
  await expect.poll(async () => {
    const current = await cameraPose(page)
    stableSamples = samePose(current, previous) ? stableSamples + 1 : 0
    previous = current
    return stableSamples
  }, { timeout: 15000, intervals: [150, 250, 350] }).toBeGreaterThanOrEqual(3)
  return previous
}

async function expectCameraUnchanged(page, baseline) {
  // Observe several frames after the UI change, not just a pose before a flight starts.
  for (let index = 0; index < 3; index++) {
    await page.waitForTimeout(250)
    expect(samePose(await cameraPose(page), baseline), 'Time browsing preserves the settled camera pose').toBe(true)
  }
}

test('excluding and clearing the selected city keeps its identity, camera pose and application camera command count', async ({ page }, testInfo) => {
  const commands = []
  const selectionStates = []
  // Existing dev logs expose application-issued camera commands. This is not a
  // count of every Cesium internal setView/lookAt call and does not expose viewer.
  page.on('console', (message) => {
    const text = message.text()
    for (const [prefix, target] of [['[camera-command] ', commands], ['[cesium-globe-scale-prop] ', selectionStates]]) {
      if (!text.startsWith(prefix)) continue
      const details = JSON.parse(text.slice(prefix.length))
      target.push({ commandNumber: details.commandNumber, source: details.source,
        selectedCityId: details.selectedCityId, selectedCountryId: details.selectedCountryId })
    }
  })
  await openMap(page)
  await selectReykjavik(page)
  await expect.poll(() => commands.some(command => command.source === 'city' && command.selectedCityId === fixtureIds.reykjavik)).toBe(true)
  const baselinePose = await settledCameraPose(page)
  const baselineCommandCount = commands.length
  expect(selectionStates.at(-1).selectedCityId).toBe(fixtureIds.reykjavik)

  await year(page, 2023)
  await closeFilters(page)
  const info = page.locator('.atlas-info-panel')
  await expect(info.locator('h2')).toHaveText('Reykjavik')
  await expect(info.locator('[data-time-filter-outside]')).toBeVisible()
  await expectCameraUnchanged(page, baselinePose)
  expect(commands).toHaveLength(baselineCommandCount)
  expect(selectionStates.at(-1).selectedCityId).toBe(fixtureIds.reykjavik)

  await filters(page)
  await panel(page).getByRole('button', { name: 'Clear all', exact: true }).click()
  await closeFilters(page)
  await expect(info.locator('[data-time-filter-outside]')).toHaveCount(0)
  await expect(info.locator('h2')).toHaveText('Reykjavik')
  await expectCameraUnchanged(page, baselinePose)
  expect(commands).toHaveLength(baselineCommandCount)
  expect(selectionStates.at(-1).selectedCityId).toBe(fixtureIds.reykjavik)
  await testInfo.attach('camera-browse-evidence', {
    body: JSON.stringify({ selectedCityId: fixtureIds.reykjavik, baselinePose, finalPose: await cameraPose(page),
      baselineApplicationCommandCount: baselineCommandCount, finalApplicationCommandCount: commands.length,
      limitation: 'Counts existing application selection-command logs, not all low-level Cesium calls.' }),
    contentType: 'application/json',
  })
})

test('both layer toggles retain their conditions and Collection restores a hidden item from the complete source set', async ({ page }) => {
  const beforeWantToGo = await readFixture('wantToGo')
  const beforeTravel = await readFixture('travel')
  const beforePlaces = await readFixture('places')
  await openMap(page)
  await year(page, 2025)
  await year(page, 2028, 'want_to_go')
  await closeFilters(page)
  const savedConditions = await page.evaluate(key => localStorage.getItem(key), storageKey)
  const mapStatus = await page.locator('.cesium-map-status').textContent()
  await page.getByRole('button', { name: /Map layers, .* layers shown/ }).click()
  const travel = page.getByRole('menuitemcheckbox', { name: /^Travel (Shown|Hidden)$/ })
  const wantToGo = page.getByRole('menuitemcheckbox', { name: /^Want to Go (Shown|Hidden)$/ })
  for (const toggle of [travel, wantToGo]) {
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  }
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(savedConditions)
  for (const toggle of [travel, wantToGo]) {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }
  await expect(page.locator('.cesium-map-status')).toHaveText(mapStatus)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(savedConditions)
  await page.getByRole('button', { name: /Map layers, .* layers shown/ }).click()
  await openCollection(page)
  await expect(page.getByText('All records, unaffected by map time filters.', { exact: true })).toBeVisible()
  const cards = page.locator('.collection-card')
  await expect(cards).toHaveCount(4)
  const hiddenCard = cards.filter({ has: page.getByRole('button', { name: 'Restore: Tromsø', exact: true }) })
  await expect(hiddenCard).toHaveCount(1)
  await expect(hiddenCard).toHaveAttribute('data-hidden', 'true')
  const restored = page.waitForResponse(response => response.url().endsWith('/editor/wanttogo/update') && response.request().method() === 'POST')
  await hiddenCard.getByRole('button', { name: 'Restore: Tromsø', exact: true }).click()
  expect((await restored).ok()).toBe(true)
  await expect.poll(async () => (await readFixture('wantToGo')).items.find(item => item.id === 'wtg_2026-08-12_tromso')?.hidden).toBe(false)
  await expect(cards).toHaveCount(4)
  await expect(cards.filter({ has: page.getByRole('button', { name: 'Hide: Tromsø', exact: true }) })).toHaveAttribute('data-hidden', 'false')
  const afterWantToGo = await readFixture('wantToGo')
  expect(afterWantToGo.items.map(item => item.id).sort()).toEqual(beforeWantToGo.items.map(item => item.id).sort())
  expect(afterWantToGo.items).toEqual(beforeWantToGo.items.map(item => item.id === 'wtg_2026-08-12_tromso' ? { ...item, hidden: false } : item))
  expect(await readFixture('travel')).toEqual(beforeTravel)
  expect(await readFixture('places')).toEqual(beforePlaces)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(savedConditions)
})
