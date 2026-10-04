import { test as base, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtureFileNames } from '../../scripts/browser-fixture.mjs'

export const test = base.extend({
  // SwiftShader allocations can survive closed contexts in a long-lived process.
  // End the actual browser after each case while retaining the shared synthetic service.
  testBrowser: async ({ playwright, browserName, launchOptions, headless, channel }, use) => {
    const browser = await playwright[browserName].launch({ ...launchOptions, headless, channel })
    try { await use(browser) } finally { await browser.close() }
  },
  page: async ({ testBrowser, contextOptions, baseURL, viewport, locale, serviceWorkers }, use) => {
    const context = await testBrowser.newContext({ ...contextOptions, baseURL, viewport, locale, serviceWorkers })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.origin === 'http://127.0.0.1:5173' ? route.continue() : route.abort()
        : route.continue()
    })
    await page.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'en'))
    try {
      await use(page)
      expect(errors, 'No uncaught application error').toEqual([])
    } finally { await context.close() }
  },
})
export { expect }

export const readFixture = async (key) => JSON.parse(await readFile(path.join(process.env.STARMAP_BROWSER_TEST_ROOT, 'data', 'v2', fixtureFileNames[key]), 'utf8'))
export async function openMap(page) {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
}
export async function selectReykjavik(page) {
  await page.getByRole('button', { name: 'Iceland', exact: true }).click()
  await page.getByRole('button', { name: 'Reykjavik', exact: true }).click()
  await expect(page.locator('.atlas-info-panel h2')).toHaveText('Reykjavik')
}
export async function openCollection(page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
}
