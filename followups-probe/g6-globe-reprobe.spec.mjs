// Temporary (test stability follow-ups, round 1, G6; design §6.3): copied into 01_Web/tests/browser/ on the runner only.
// The map:globe boundary's Reload map mounts the globe again. If WebGL went away meanwhile, the new mount must probe
// again and show the no-WebGL notice, not build a viewer that cannot have a context (a blank map, design §6.1).
// The globe is made to throw while rendering by the dev server's own module with one line added (no product hook): the
// module as Vite serves it, fetched through the route, with a throw before its first hook while
// window.__starmapGlobeThrows is set. WebGL goes away when window.__starmapWebGLGone is set (an init script, as the
// no-WebGL case of map-recovery.spec.mjs).
import { test, expect, expectPageError, openMap, pageErrors, selectReykjavik } from './helpers.mjs'
import { createBrowserFixture } from '../../scripts/browser-fixture.mjs'

test.beforeEach(async () => { await createBrowserFixture(process.env.STARMAP_BROWSER_TEST_ROOT) })

const webglCanGo = () => {
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
    if (window.__starmapWebGLGone && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) return null
    return original.call(this, type, ...rest)
  }
}
const ANCHOR = /const \{\s*locale,\s*t\s*\} = useUiLocale\(\);?/g
const MESSAGE = 'injected render error for map:globe'

test('G6: after the globe failed while rendering and WebGL went away, Reload map shows the no-WebGL notice', async ({ page }) => {
  test.setTimeout(120_000)
  const report = `starmap:caught-error [map:globe] ${MESSAGE}`
  expectPageError(page, report)
  expectPageError(page, 'starmap:caught-error [map:no-webgl]')
  await page.addInitScript(webglCanGo)
  const served = []
  await page.route((url) => new URL(url).pathname === '/src/components/CesiumAtlasGlobe.tsx', async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    const found = (body.match(ANCHOR) ?? []).length
    served.push(found)
    if (found !== 1) return route.fulfill({ response, body })
    return route.fulfill({ response, headers: { ...response.headers(), 'cache-control': 'no-store' },
      body: body.replace(ANCHOR, (match) => `if (window.__starmapGlobeThrows) throw new Error(${JSON.stringify(MESSAGE)});` + String.fromCharCode(10) + match) })
  })
  await openMap(page)
  expect(served, 'the globe module was served once, with its anchor found once').toEqual([1])
  await expect.poll(async () => (await page.evaluate(() => window.__travelAtlasDebugRenderLoop?.state()))?.frames ?? 0, { timeout: 20000 }).toBeGreaterThan(1)
  // The globe throws on its next render: a new selection gives it new props.
  await page.evaluate(() => { window.__starmapGlobeThrows = true })
  await selectReykjavik(page)
  const notice = page.locator('[data-error-boundary="map:globe"]')
  await expect(notice).toBeVisible()
  await expect.poll(() => pageErrors(page).includes(report)).toBe(true)
  // WebGL is gone (after a GPU reset, say), then the user reloads the map.
  await page.evaluate(() => { window.__starmapGlobeThrows = false; window.__starmapWebGLGone = true })
  await notice.getByRole('button', { name: 'Reload map', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: 'This browser can\'t show the 3D map right now' })).toBeVisible({ timeout: 20000 })
  await expect(page.locator('[data-map-webgl="unavailable"]')).toHaveCount(1)
  await expect(page.locator('.cesium-widget')).toHaveCount(0)
})
