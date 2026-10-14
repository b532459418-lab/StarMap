// Public build smoke (batch 4, E4). Runs only with `npm run test:browser -- --public-smoke`, which serves the existing
// dist/ through `vite preview` instead of the development server. Since 5B no build contains the editor client: CI's
// Public build smoke job refuses any `/__travelatlas/editor` in dist/**/*.js before these cases run. The cases check
// the runtime side: the public page shows the neutral sample, never calls the local editor, and the preview has no
// editor endpoint.
import { readFile } from 'node:fs/promises'
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

// Batch 4B (E8): Cesium is bundled into a content-hashed chunk, and the files it loads at run time come from the
// directory named after the installed Cesium version (vite.config.ts). A missing copy would only show as absent globe
// detail, so the smoke checks the requests themselves.
test('Cesium code is content-hashed and its workers and assets load from the versioned static directory', async ({ page }) => {
  const { version } = JSON.parse(await readFile(new URL('../../node_modules/cesium/package.json', import.meta.url), 'utf8'))
  const staticPrefix = `/cesium/${version}/`
  const scripts = [], cesiumResponses = [], workers = []
  page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname))
  page.on('response', (response) => {
    const { pathname } = new URL(response.url())
    if (response.request().resourceType() === 'script') scripts.push(pathname)
    if (pathname.startsWith('/cesium/')) cesiumResponses.push(`${response.status()} ${pathname}`)
  })
  await page.goto('/')
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
  await selectReykjavik(page)
  await expect.poll(() => workers.filter((pathname) => pathname.startsWith(`${staticPrefix}Workers/`)).length).toBeGreaterThan(0)
  expect(scripts.filter((pathname) => /^\/assets\/cesium-[\w-]{8}\.js$/.test(pathname))).toHaveLength(1)
  expect(cesiumResponses.some((entry) => entry.startsWith(`200 ${staticPrefix}Assets/`))).toBe(true)
  expect(cesiumResponses.filter((entry) => !entry.startsWith(`200 ${staticPrefix}`))).toEqual([])
})
