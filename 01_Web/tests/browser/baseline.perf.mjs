import { test, expect, openCollection } from './helpers.mjs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'

test('record a descriptive browser baseline with 1000 synthetic Want to Go entries', async ({ page, testBrowser }, testInfo) => {
  await page.addInitScript(() => {
    window.__baselineLongTasks = []
    new PerformanceObserver((list) => window.__baselineLongTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true })
  })
  const start = performance.now()
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Iceland', exact: true })).toBeVisible()
  await expect(page.locator('.cesium-widget canvas')).toBeVisible()
  const mapUiReadyMs = performance.now() - start
  const openStart = performance.now()
  await openCollection(page)
  await expect(page.locator('.collection-card')).toHaveCount(1004)
  const collectionOpenMs = performance.now() - openStart
  const scroll = await page.evaluate(async () => {
    const container = document.querySelector('.atlas-journey-scroll')
    const frames = []
    let previous = await new Promise(requestAnimationFrame)
    for (let index = 0; index < 120; index++) {
      container.scrollTop = (index + 1) / 120 * (container.scrollHeight - container.clientHeight)
      const current = await new Promise(requestAnimationFrame)
      frames.push(current - previous)
      previous = current
    }
    return { frames, finalScroll: container.scrollTop }
  })
  expect(scroll.finalScroll).toBeGreaterThan(0)
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click()
  await page.getByRole('button', { name: /Map layers, .* layers shown/ }).click()
  const layer = page.getByRole('menuitemcheckbox', { name: /^Want to Go (Shown|Hidden)$/ })
  const toggles = []
  for (let index = 0; index < 6; index++) {
    const checked = await layer.getAttribute('aria-checked')
    const toggleStart = performance.now()
    await layer.click()
    await expect(layer).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    toggles.push(performance.now() - toggleStart)
  }
  const browserMetrics = await page.evaluate(() => ({
    navigation: performance.getEntriesByType('navigation').map(({ domContentLoadedEventEnd, loadEventEnd, responseEnd }) => ({ domContentLoadedEventEnd, loadEventEnd, responseEnd }))[0],
    fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    longTasks: window.__baselineLongTasks,
  }))
  const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
  const baseline = {
    measuredAt: new Date().toISOString(),
    environment: { platform: os.platform(), architecture: os.arch(), cpu: os.cpus()[0]?.model, browserVersion: testBrowser.version(), viewport: page.viewportSize(), rendering: 'headless Chromium, SwiftShader software WebGL', profile: 'Vite personal development, bundled local imagery, no external providers' },
    dataset: { extraWantToGo: 1000, collectionCards: 1004 },
    mapUiReadyMs, collectionOpenMs,
    scroll: { samples: scroll.frames.length, medianFrameMs: quantile(scroll.frames, 0.5), p95FrameMs: quantile(scroll.frames, 0.95), framesOver50Ms: scroll.frames.filter((value) => value > 50).length },
    layerToggle: { samples: toggles.length, medianMs: quantile(toggles, 0.5), p95Ms: quantile(toggles, 0.95) },
    ...browserMetrics,
    limitations: ['Single local run; timings are descriptive and are not CI pass thresholds.', 'UI-ready and two-animation-frame toggle timings do not prove Cesium tiles or GPU rendering are complete.', 'Development modules, automation, and software WebGL differ from a production build on a real GPU.'],
  }
  const file = testInfo.outputPath('baseline.json')
  await writeFile(file, JSON.stringify(baseline, null, 2) + '\n')
  await testInfo.attach('browser-baseline', { path: file, contentType: 'application/json' })
  console.log(JSON.stringify({ mapUiReadyMs, collectionOpenMs, scroll: baseline.scroll, layerToggle: baseline.layerToggle }))
})
