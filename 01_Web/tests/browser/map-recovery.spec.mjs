// The globe after a failure (src/data/mapRecovery.ts; D follow-up, the author's decision of 2026-10-29). A lost WebGL
// context is triggered deterministically with WEBGL_lose_context, the way a GPU reset or a GPU process crash loses it.
// Part of the --critical-flows group (scripts/browser-test-options.mjs).
import { test, expect, expectPageError, openMap, openCollection, saveAndWaitForRevision, selectReykjavik } from './helpers.mjs'
import { createBrowserFixture } from '../../scripts/browser-fixture.mjs'

const root = () => process.env.STARMAP_BROWSER_TEST_ROOT
test.beforeEach(async () => { await createBrowserFixture(root()) })

const loop = (page) => page.evaluate(() => window.__travelAtlasDebugRenderLoop?.state())
/** Loses the globe's WebGL context; the extension is kept to give the context back. */
const loseContext = (page) => page.evaluate(() => {
  const canvas = document.querySelector('.cesium-widget canvas')
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  window.__starmapLoseContext = gl.getExtension('WEBGL_lose_context')
  window.__starmapLoseContext.loseContext()
})
const restoreContext = (page) => page.evaluate(() => window.__starmapLoseContext.restoreContext())
const notice = (page, text = 'The map stopped drawing') => page.getByRole('alert').filter({ hasText: text })
const reloadButton = (page, name = 'Reload map') => page.getByRole('button', { name, exact: true })

/** The viewer `viewer` failed: the notice, no Cesium panel, no render error, its loop off and no new frame. */
async function expectStopped(page, viewer) {
  await expect(notice(page)).toBeVisible()
  await expect(reloadButton(page)).toBeVisible()
  await expect.poll(async () => (await loop(page))?.diagnostics?.contextLostCount, { timeout: 5000 }).toBe(1)
  const before = await loop(page)
  await page.waitForTimeout(500)
  const after = await loop(page)
  expect(after.viewer).toBe(viewer)
  expect(after.useDefaultRenderLoop).toBe(false)
  expect(after.diagnostics.renderErrorCount, after.diagnostics.lastRenderError).toBe(0)
  expect(after.frames, 'no frame on the lost context').toBe(before.frames)
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0)
}
/** A viewer other than `previous` renders: its loop is on, it draws frames, no error, no lost context, no notice. */
async function expectRenders(page, previous) {
  await expect.poll(async () => {
    const state = await loop(page)
    return state && state.viewer !== previous && state.useDefaultRenderLoop && state.frames >= 2
  }, { timeout: 20000, intervals: [200, 400] }).toBe(true)
  const state = await loop(page)
  expect({ renderErrorCount: state.diagnostics.renderErrorCount, contextLostCount: state.diagnostics.contextLostCount })
    .toEqual({ renderErrorCount: 0, contextLostCount: 0 })
  await expect(notice(page)).toHaveCount(0)
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0)
  return state
}
/** The camera once two samples agree (and its last command has completed, unless the viewer is new: it has none). */
async function settledPose(page, { newViewer = false } = {}) {
  let previous
  let pose
  await expect.poll(async () => {
    const { now, command } = await page.evaluate(() => ({ now: window.__travelAtlasDebugCamera?.getCameraPose(), command: window.__travelAtlasDebugCamera?.getCameraCommandState() }))
    const settled = (newViewer || command?.status === 'completed') && previous !== undefined && JSON.stringify(now) === JSON.stringify(previous)
    previous = now
    if (settled) pose = now
    return Boolean(settled)
  }, { timeout: 20000, intervals: [200, 300, 400] }).toBe(true)
  return pose
}

test('a lost context shows a notice instead of Cesium\'s panel; Reload map rebuilds only the map, with the page, a draft and the camera kept', async ({ page }) => {
  await openMap(page)
  await selectReykjavik(page)
  // A time filter of this session and a half-filled form (as in the incremental refresh cases).
  await page.locator('.atlas-time-query-toolbar').getByRole('button', { name: 'Time filters', exact: true }).click()
  const travel = page.locator('#atlas-time-query-panel .layer-time-filter[data-layer="travel"]')
  if (!await travel.getByLabel('Year shortcut', { exact: true }).isVisible()) await travel.locator('summary').click()
  await travel.getByLabel('Year shortcut', { exact: true }).fill('2025')
  await travel.getByRole('button', { name: 'Use this year', exact: true }).click()
  await page.locator('#atlas-time-query-panel').getByRole('button', { name: 'Close', exact: true }).click()
  const toolbar = page.locator('.atlas-time-query-toolbar')
  await expect(toolbar).toContainText('2025-01-01')
  await page.getByRole('button', { name: 'Edit visited countries', exact: true }).click()
  await page.getByRole('button', { name: 'Add country', exact: true }).click()
  const date = page.locator('.atlas-local-editor-form input[type=date]').first()
  await date.fill('2026-02-03')
  const mark = await page.evaluate(() => (window.__starmapNoReload = Math.random()))
  const pose = await settledPose(page)
  const { viewer } = await loop(page)

  await loseContext(page)
  await expectStopped(page, viewer)
  await reloadButton(page).click()
  await expectRenders(page, viewer)
  // Only the map was rebuilt: the same page, the selection, the filter and the draft.
  expect(await page.evaluate(() => window.__starmapNoReload)).toBe(mark)
  await expect(page.locator('.atlas-info-panel h2')).toHaveText('Reykjavik')
  await expect(toolbar).toContainText('2025-01-01')
  await expect(date).toHaveValue('2026-02-03')
  // The camera where it was.
  const after = await settledPose(page, { newViewer: true })
  for (const key of ['lat', 'lng']) expect(Math.abs(after[key] - pose[key]), key).toBeLessThan(1e-6)
  expect(Math.abs(after.height - pose.height), 'height').toBeLessThan(0.5)
  for (const key of ['heading', 'pitch', 'roll']) expect(Math.abs(after[key] - pose[key]), key).toBeLessThan(0.01)
})

test('the context coming back rebuilds the map once; a second loss within two minutes keeps the notice until Reload map', async ({ page }) => {
  await openMap(page)
  const first = await expectRenders(page, undefined)
  await loseContext(page)
  await expectStopped(page, first.viewer)
  await restoreContext(page)
  const second = await expectRenders(page, first.viewer)
  // A second loss within the window: the context comes back, the map waits for the button.
  await loseContext(page)
  await expectStopped(page, second.viewer)
  await restoreContext(page)
  await page.waitForTimeout(1500)
  const waiting = await loop(page)
  expect(waiting.viewer).toBe(second.viewer)
  expect(waiting.useDefaultRenderLoop).toBe(false)
  await expect(notice(page)).toBeVisible()
  await reloadButton(page).click()
  await expectRenders(page, second.viewer)
})

test('the end of a save\'s pause does not turn the loop of a lost context back on', async ({ page }) => {
  await openMap(page)
  await selectReykjavik(page)
  const { viewer } = await expectRenders(page, undefined)
  // The want-to-go write answers after 1 s; the context is lost during the pause it starts (3C-5 D, A′).
  await page.route('**/__travelatlas/editor/wanttogo', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return route.continue()
  })
  const episodes = (await loop(page)).episodes.length
  await page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click()
  await expect.poll(async () => (await loop(page)).paused, { timeout: 5000, intervals: [25, 50] }).toBe(true)
  await loseContext(page)
  await expect.poll(async () => (await loop(page)).episodes.length, { timeout: 10000 }).toBe(episodes + 1)
  await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
  await expectStopped(page, viewer)
  await reloadButton(page).click()
  await expectRenders(page, viewer)
})

test('keyboard: the notice\'s button is reached with Tab and rebuilds the map; the focus stays on the map (Chinese)', async ({ page }) => {
  await openMap(page)
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-Hans')
  const { viewer } = await expectRenders(page, undefined)
  await loseContext(page)
  const button = reloadButton(page, '重新加载地图')
  await expect(notice(page, '地图停止了绘制')).toBeVisible()
  // From the start of the page.
  await page.evaluate(() => document.activeElement?.blur())
  let reached = false
  for (let presses = 0; presses < 80 && !reached; presses++) {
    await page.keyboard.press('Tab')
    reached = await button.evaluate((element) => element === document.activeElement)
  }
  expect(reached, 'Tab reaches the button').toBe(true)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await loop(page))?.viewer, { timeout: 20000 }).not.toBe(viewer)
  await expect(page.getByRole('region', { name: '地图', exact: true })).toBeFocused()
  await expect(button).toHaveCount(0)
})

// Robustness batch (design §4, §6.2 case 4): a browser without WebGL. Cesium could not construct a viewer, and its error
// is out of React's reach (design §1.4), so the map probes first. The init script makes the three WebGL context types
// unavailable until the case gives them back (`window.__starmapWebGLBack`), the way a browser with WebGL turned off does.
const withoutWebGL = () => {
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
    if (!window.__starmapWebGLBack && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) return null
    return original.call(this, type, ...rest)
  }
}
const noWebGLNotice = (page) => page.getByRole('alert').filter({ hasText: 'This browser can\'t show the 3D map right now' })

test('no WebGL: the map says why instead of a blank canvas; Collection opens, a save works and its pause ends at once; Try again probes again', async ({ page }) => {
  expectPageError(page, 'starmap:caught-error [map:no-webgl]')
  await page.addInitScript(withoutWebGL)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  const shell = page.getByRole('region', { name: 'Map', exact: true })
  await expect(shell).toHaveAttribute('data-map-webgl', 'unavailable')
  const notice = noWebGLNotice(page)
  await expect(notice).toBeVisible()
  // No viewer at all: no half-built Cesium DOM, no Cesium panel, no rebuild button.
  await expect(page.locator('.cesium-widget')).toHaveCount(0)
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0)
  await expect(notice.getByRole('button', { name: 'Reload map', exact: true })).toHaveCount(0)
  // The rest of the page: Collection, Journey, the map's panels and the editor.
  await openCollection(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(page.locator('.atlas-experience')).toHaveAttribute('data-page', 'journey')
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await expect(notice).toBeVisible()
  await selectReykjavik(page)
  const before = (await loop(page)).episodes.length
  await saveAndWaitForRevision(page, () => page.getByRole('button', { name: 'Mark as Want to Go', exact: true }).click())
  await expect(page.getByRole('button', { name: 'Already on your Want to Go list', exact: true })).toBeDisabled()
  // The save's map pause ended at once: there is no renderer to pause (not 'applied' after the whole save).
  const state = await loop(page)
  expect(state.paused).toBe(false)
  expect(state.episodes.slice(before)).toEqual([{ pausedMs: 0, endedBy: 'no-renderer' }])
  // Try again, still without WebGL: the notice stays.
  const tryAgain = notice.getByRole('button', { name: 'Try again', exact: true })
  await tryAgain.click()
  await expect(notice).toBeVisible()
  await expect(page.locator('.cesium-widget')).toHaveCount(0)
  // WebGL is back: Try again creates the map, which renders. The click is dispatched from a task of the page: creating
  // the viewer keeps the main thread busy for seconds with software rendering, longer than an input action may wait.
  await page.evaluate(() => { window.__starmapWebGLBack = true })
  await tryAgain.evaluate((button) => { setTimeout(() => button.click(), 0) })
  await expect(notice).toHaveCount(0, { timeout: 30000 })
  await expect(page.locator('.cesium-widget canvas')).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await loop(page))?.frames ?? 0, { timeout: 20000 }).toBeGreaterThan(1)
  await expect(shell).not.toHaveAttribute('data-map-webgl', 'unavailable')
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0)
})

test('no WebGL (Chinese): the notice and its button are in Chinese and the button is reached with Tab', async ({ page }) => {
  expectPageError(page, 'starmap:caught-error [map:no-webgl]')
  await page.addInitScript(withoutWebGL)
  await page.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'zh-Hans'))
  await page.goto('/')
  const notice = page.getByRole('alert').filter({ hasText: '这个浏览器现在不能显示 3D 地图' })
  await expect(notice).toBeVisible()
  const button = notice.getByRole('button', { name: '再试一次', exact: true })
  await page.evaluate(() => document.activeElement?.blur())
  let reached = false
  for (let presses = 0; presses < 80 && !reached; presses++) {
    await page.keyboard.press('Tab')
    reached = await button.evaluate((element) => element === document.activeElement)
  }
  expect(reached, 'Tab reaches the button').toBe(true)
})
