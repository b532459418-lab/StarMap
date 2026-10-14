// Public build smoke (batch 4, E4). Runs only with `npm run test:browser -- --public-smoke`, which serves the existing
// dist/ through `vite preview` instead of the development server. The bundle still carries the editor's client-side
// paths until the editing components are lazy-loaded (5B), so these checks are about runtime behaviour: the public
// page shows the neutral sample, never calls the local editor, and the preview has no editor endpoint.
import { test, expect, openCollection, selectReykjavik } from './helpers.mjs'

const editorPrefix = '/__travelatlas/editor/'

test('the public build shows the neutral sample without write controls or local editor requests', async ({ page }) => {
  const editorRequests = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.startsWith(editorPrefix)) editorRequests.push(`${request.method()} ${pathname}`)
  })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
  await selectReykjavik(page)
  await expect(page.getByRole('button', { name: 'Edit city photos', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mark as Want to Go', exact: true })).toHaveCount(0)
  await openCollection(page)
  // An entry of the tracked public sample (src/data/v2-sample/want-to-go.json): its Sample tag and its note, which
  // keeps its original language.
  await expect(page.getByRole('list', { name: 'Tags for Tromsø', exact: true }).getByRole('listitem').filter({ hasText: 'Sample' })).toBeVisible()
  await expect(page.getByText('北极圈以北的城市，冬季可以看极光', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add a place you want to go', exact: true })).toHaveCount(0)
  expect(editorRequests).toEqual([])
})

test('the public preview has no local editor endpoint', async ({ page }) => {
  // Even a same-origin request with the editor header receives no editor data.
  const direct = await page.request.get(`${editorPrefix}state`, { headers: { 'x-travelatlas-local-editor': '1' } })
  expect(direct.headers()['content-type'] ?? '').not.toContain('json')
  expect((await direct.text()).trimStart().startsWith('{')).toBe(false)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  const fromPage = await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store', headers: { 'x-travelatlas-local-editor': '1' } })
    return { type: response.headers.get('content-type') ?? '', body: (await response.text()).trimStart().slice(0, 1) }
  }, `${editorPrefix}state`)
  expect(fromPage.type).not.toContain('json')
  expect(fromPage.body).not.toBe('{')
})
