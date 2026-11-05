import { reportCaughtError } from './caughtErrorReport.ts'

/**
 * The browser tests' report of caught errors (./caughtErrorReport.ts), only where their dev server turns it on
 * (playwright.config.mjs sets VITE_STARMAP_REPORT_CAUGHT_ERRORS=1). In a build `import.meta.env.DEV` is the literal
 * false: this is `undefined` and the reporting module is not bundled. Callers use `reportToBrowserTests?.(…)`.
 */
export const reportToBrowserTests = import.meta.env.DEV && import.meta.env.VITE_STARMAP_REPORT_CAUGHT_ERRORS === '1'
  ? reportCaughtError
  : undefined
