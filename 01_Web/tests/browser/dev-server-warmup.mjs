// Playwright globalSetup for the development-server groups (batch 4). It runs after the web server answers and
// before the first case: one throwaway browser opens the map, then Collection, reloads it and waits again. That makes
// Vite finish its dependency optimisation and transform the application modules, so the first case of each runner or
// shard no longer pays the cold-server cost inside its own time budget. Cases still launch their own browsers.
//
// Browsing is read-only. The synthetic root is compared before and after; any change fails the run. A browsing
// failure only logs a warning: the cases then run against a cold server, as they did before this warm-up existed.
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const stepTimeout = 180000

async function snapshot(root) {
  const entries = {}
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const key = path.relative(root, target).split(path.sep).join('/')
      if (entry.isDirectory()) {
        entries[`${key}/`] = 'directory'
        await walk(target)
      } else {
        entries[key] = createHash('sha256').update(await readFile(target)).digest('hex')
      }
    }
  }
  await walk(root)
  return entries
}

export default async function warmDevServer(config) {
  const root = path.resolve(process.env.STARMAP_BROWSER_TEST_ROOT ?? '')
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('The dev-server warm-up requires the isolated synthetic browser fixture.')
  const { baseURL, launchOptions, viewport, locale } = config.projects[0].use
  const before = await snapshot(root)
  const started = performance.now()
  const browser = await chromium.launch(launchOptions)
  try {
    const context = await browser.newContext({ baseURL, viewport, locale, serviceWorkers: 'block' })
    const origin = new URL(baseURL).origin
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin ? route.abort() : route.continue()
    })
    await context.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'en'))
    const page = await context.newPage()
    page.setDefaultTimeout(stepTimeout)
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: stepTimeout })
    await page.getByRole('navigation', { name: 'Primary navigation' }).waitFor()
    await page.locator('.cesium-widget canvas').waitFor()
    await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
    await page.locator('.collection-card').first().waitFor()
    // Reloading on Collection is what a saved write does in several cases.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: stepTimeout })
    await page.locator('.collection-card').first().waitFor()
    console.log(`Dev-server warm-up finished in ${Math.round((performance.now() - started) / 1000)} s.`)
  } catch (error) {
    console.warn(`Dev-server warm-up incomplete after ${Math.round((performance.now() - started) / 1000)} s; cases start against a colder server: ${String(error?.message ?? error).split('\n')[0]}`)
  } finally {
    await browser.close()
  }
  const after = await snapshot(root)
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]).sort()
  if (changed.length) throw new Error(`The dev-server warm-up changed the synthetic fixture: ${changed.join(', ')}`)
}
