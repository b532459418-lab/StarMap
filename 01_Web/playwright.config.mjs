import { defineConfig } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'

const root = process.env.STARMAP_BROWSER_TEST_ROOT
if (!root || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starmap-browser-')) throw new Error('Use npm run test:browser or npm run perf:browser to create isolated data.')
const performance = process.env.STARMAP_BROWSER_PERFORMANCE === '1'
// `--public-smoke` checks the built public bundle (dist/) through `vite preview`, never the dev server. Its cases
// live in *.smoke.mjs, so the default run (*.spec.mjs against the dev server) never picks them up.
const publicSmoke = process.env.STARMAP_BROWSER_PUBLIC_SMOKE === '1'
// 3C-4d: `--migration` runs *.migration.mjs against a fixture left unmigrated (V2 files only). Every other dev-server
// group runs *.spec.mjs against a fixture migrated into the new library.
const migration = process.env.STARMAP_BROWSER_MIGRATION === '1'
const serverEnv = { STARMAP_PRIVATE_ROOT: root, VITE_MAP_SOURCE: 'local', VITE_CESIUM_ION_TOKEN: '', VITE_TIANDITU_TOKEN: '', VITE_TRAVEL_ATLAS_DATA_MODE: '' }
export default defineConfig({
  testDir: './tests/browser',
  testMatch: performance ? '**/*.perf.mjs' : publicSmoke ? '**/*.smoke.mjs' : migration ? '**/*.migration.mjs' : '**/*.spec.mjs',
  // Dev-server groups warm Vite once before their first case (see the file). The public smoke uses vite preview, and
  // the performance baseline keeps measuring the unwarmed first load it has always recorded.
  ...(performance || publicSmoke ? {} : { globalSetup: './tests/browser/dev-server-warmup.mjs' }),
  workers: 1,
  fullyParallel: false,
  // A committed test.only would silently skip the rest of a CI group.
  forbidOnly: !!process.env.CI,
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
    command: publicSmoke ? 'npm run preview -- --mode public --host 127.0.0.1 --port 5173 --strictPort' : 'npm run dev:personal',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60000,
    env: serverEnv,
  },
})
