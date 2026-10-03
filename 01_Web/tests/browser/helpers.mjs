import { test as base, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtureFileNames } from '../../scripts/browser-fixture.mjs'

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.origin === 'http://127.0.0.1:5173' ? route.continue() : route.abort()
        : route.continue()
    })
    await page.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'en'))
    await use(page)
    expect(errors, 'No uncaught application error').toEqual([])
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
