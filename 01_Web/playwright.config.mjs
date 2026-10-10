import { defineConfig } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'

const root = process.env.STARMAP_BROWSER_TEST_ROOT
if (!root || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Use npm run test:browser or npm run perf:browser to create isolated data.')
const performance = process.env.STARMAP_BROWSER_PERFORMANCE === '1'
const repositoryPreview = process.env.STARMAP_BROWSER_REPOSITORY_PREVIEW === '1'
if (performance && repositoryPreview) throw new Error('Repository preview and performance suites are exclusive.')
export default defineConfig({
  testDir: './tests/browser',
  testMatch: repositoryPreview ? '**/repository-preview.spec.mjs' : performance ? '**/*.perf.mjs' : '**/*.spec.mjs',
  testIgnore: repositoryPreview ? [] : ['**/repository-preview.spec.mjs'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: performance ? 180000 : 60000,
  globalTimeout: 1500000,
  expect: { timeout: 15000 },
  outputDir: performance ? './test-results/performance' : './test-results/browser',
  reporter: [['list'], ['html', { outputFolder: performance ? 'playwright-report/performance' : 'playwright-report/browser', open: 'never' }]],
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    serviceWorkers: 'block',
    actionTimeout: 15000,
    navigationTimeout: 30000,
    screenshot: 'only-on-failure',
    trace: performance ? 'off' : 'retain-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: repositoryPreview ? 'npm run dev:repository-preview' : 'npm run dev:personal',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60000,
    env: { STARMAP_PRIVATE_ROOT: repositoryPreview ? '' : root, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '' },
  },
})
