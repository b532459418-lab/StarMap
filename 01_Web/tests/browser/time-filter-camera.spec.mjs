import { test, expect, openMap, selectReykjavik, openCollection, readFixture, recordReloadCheckpoint, retainReloadFailure } from './helpers.mjs'
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
test.afterEach(async ({ page }, testInfo) => {
  await retainReloadFailure(page, testInfo)
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

const poseTolerances = { height: 0.1, heading: 0.000001, lat: 0.000001, lng: 0.000001, pitch: 0.000001, roll: 0.000001 }
const samePose = (left, right) => left && right && Object.entries(poseTolerances)
  .every(([key, tolerance]) => Number.isFinite(left[key]) && Number.isFinite(right[key]) && Math.abs(left[key] - right[key]) <= tolerance)

const cameraSnapshot = (page) => page.evaluate(() => ({
  pose: window.__travelAtlasDebugCamera?.getCameraPose(),
  command: window.__travelAtlasDebugCamera?.getCameraCommandState(),
  observedAt: Date.now(),
}))

async function settledCameraPose(page, commands, baselineCommand, samples) {
  let previous
  let stableSamples = 0
  // Completion and stability share the original 15-second budget. Repeated
  // identical poses during a paused software-rendered flight are not completion.
  await expect.poll(async () => {
    if (baselineCommand.commandNumber === undefined) baselineCommand.commandNumber = commands.findLast(
      command => command.source === 'city' && command.selectedCityId === fixtureIds.reykjavik)?.commandNumber
    const snapshot = await cameraSnapshot(page)
    samples.push({ phase: 'settling', expectedCommandNumber: baselineCommand.commandNumber, ...snapshot })
    const completed = baselineCommand.commandNumber !== undefined &&
      snapshot.command?.commandNumber === baselineCommand.commandNumber &&
      snapshot.command.source === 'city' && snapshot.command.selectedCityId === fixtureIds.reykjavik &&
      snapshot.command.status === 'completed'
    stableSamples = completed && samePose(snapshot.pose, previous) ? stableSamples + 1 : 0
    previous = completed ? snapshot.pose : undefined
    return stableSamples
  }, { timeout: 15000, intervals: [150, 250, 350] }).toBeGreaterThanOrEqual(3)
  return previous
}

async function expectCameraUnchanged(page, baseline, commandNumber, samples, phase) {
  // Observe several frames after the UI change, not just a pose before a flight starts.
  for (let index = 0; index < 3; index++) {
    await page.waitForTimeout(250)
    const snapshot = await cameraSnapshot(page)
    samples.push({ phase, ...snapshot })
    expect(samePose(snapshot.pose, baseline), 'Time browsing preserves the settled camera pose').toBe(true)
    expect(snapshot.command?.commandNumber, 'Time browsing keeps the completed command').toBe(commandNumber)
    expect(snapshot.command?.status).toBe('completed')
  }
}

test('excluding and clearing the selected city keeps its identity, camera pose and application camera command count', async ({ page }, testInfo) => {
  const commands = []
  const selectionStates = []
  const samples = []
  let phase = 'open-map'
  let baselinePose
  let baselineCommandCount
  const baselineCommand = { commandNumber: undefined }
  // Existing dev logs expose application-issued camera commands. This is not a
  // count of every Cesium internal setView/lookAt call and does not expose viewer.
  page.on('console', (message) => {
    const text = message.text()
    for (const [prefix, target] of [['[camera-command] ', commands], ['[cesium-globe-scale-prop] ', selectionStates]]) {
      if (!text.startsWith(prefix)) continue
      const details = JSON.parse(text.slice(prefix.length))
      target.push({ observedAt: Date.now(), commandNumber: details.commandNumber, source: details.source,
        selectedCityId: details.selectedCityId, selectedCountryId: details.selectedCountryId })
    }
  })
  try {
    await openMap(page)
    phase = 'select-city'
    await selectReykjavik(page)
    phase = 'settling'
    baselinePose = await settledCameraPose(page, commands, baselineCommand, samples)
    baselineCommandCount = commands.length
    expect(selectionStates.at(-1).selectedCityId).toBe(fixtureIds.reykjavik)

    phase = 'exclude-city'
    await year(page, 2023)
    await closeFilters(page)
    const info = page.locator('.atlas-info-panel')
    await expect(info.locator('h2')).toHaveText('Reykjavik')
    await expect(info.locator('[data-time-filter-outside]')).toBeVisible()
    await expectCameraUnchanged(page, baselinePose, baselineCommand.commandNumber, samples, phase)
    expect(commands).toHaveLength(baselineCommandCount)
    expect(selectionStates.at(-1).selectedCityId).toBe(fixtureIds.reykjavik)

    phase = 'clear-filter'
    await filters(page)
    await panel(page).getByRole('button', { name: 'Clear all', exact: true }).click()
    await closeFilters(page)
    await expect(info.locator('[data-time-filter-outside]')).toHaveCount(0)
    await expect(info.locator('h2')).toHaveText('Reykjavik')
    await expectCameraUnchanged(page, baselinePose, baselineCommand.commandNumber, samples, phase)
    expect(commands).toHaveLength(baselineCommandCount)
    expect(selectionStates.at(-1).selectedCityId).toBe(fixtureIds.reykjavik)
    phase = 'completed'
  } finally {
    // Preserve evidence on assertion/timeout failure too. Diagnostic collection
    // must not hide the original failure if the page has already closed/crashed.
    const evidence = { phase, selectedCityId: fixtureIds.reykjavik, baselinePose, baselineCommandNumber: baselineCommand.commandNumber,
      baselineApplicationCommandCount: baselineCommandCount, finalApplicationCommandCount: commands.length,
      commands, selectionStates, samples, poseTolerances,
      limitation: 'Only application-issued commands; completion callbacks observed only for city/country/place/overview flights. Raw pose comparisons and tolerances are unchanged.' }
    let readTimer
    try {
      evidence.finalSnapshot = await Promise.race([
        cameraSnapshot(page),
        new Promise((_, reject) => {
          readTimer = setTimeout(() => reject(new Error('Final camera read exceeded two seconds')), 2000)
          readTimer.unref()
        }),
      ])
      evidence.finalPose = evidence.finalSnapshot.pose
      if (baselinePose && evidence.finalPose) evidence.rawPoseDelta = Object.fromEntries(
        Object.keys(poseTolerances).map(key => [key, evidence.finalPose[key] - baselinePose[key]]))
    } catch (error) { evidence.diagnosticReadError = String(error) }
    finally { clearTimeout(readTimer) }
    // CI retains stdout even when no trace-artifact uploader is configured.
    console.info('[camera-browse-evidence]', JSON.stringify(evidence))
    try {
      await testInfo.attach('camera-browse-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' })
    } catch (error) { console.warn('[camera-browse-evidence-attachment-error]', String(error)) }
  }
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
  recordReloadCheckpoint(page, 'before restoring Tromsø')
  const restored = page.waitForResponse(response => response.url().endsWith('/editor/wanttogo/update') && response.request().method() === 'POST')
  await hiddenCard.getByRole('button', { name: 'Restore: Tromsø', exact: true }).click()
  expect((await restored).ok()).toBe(true)
  recordReloadCheckpoint(page, 'restore response accepted')
  await expect.poll(async () => (await readFixture('wantToGo')).items.find(item => item.id === 'wtg_2026-08-12_tromso')?.hidden).toBe(false)
  await expect(cards).toHaveCount(4)
  recordReloadCheckpoint(page, 'four Collection cards restored after reload')
  await expect(cards.filter({ has: page.getByRole('button', { name: 'Hide: Tromsø', exact: true }) })).toHaveAttribute('data-hidden', 'false')
  const afterWantToGo = await readFixture('wantToGo')
  expect(afterWantToGo.items.map(item => item.id).sort()).toEqual(beforeWantToGo.items.map(item => item.id).sort())
  expect(afterWantToGo.items).toEqual(beforeWantToGo.items.map(item => item.id === 'wtg_2026-08-12_tromso' ? { ...item, hidden: false } : item))
  expect(await readFixture('travel')).toEqual(beforeTravel)
  expect(await readFixture('places')).toEqual(beforePlaces)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(savedConditions)
})
