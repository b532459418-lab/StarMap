/**
 * The browser tests do not go blind behind the error boundaries (robustness batch, design §3).
 *
 * An error a boundary caught is not an uncaught error: without this, a page that shows a boundary's notice would pass
 * every browser case. So, in the browser tests' dev server only (./browserTestReport.ts), each caught error is
 * reported again with `reportError`: the page has an uncaught error, Playwright a `pageerror`, and the page fixture
 * (tests/browser/helpers.mjs) fails the case, unless the case declared it (`expectPageError`). The message names the
 * boundary: `starmap:caught-error [<boundary>] <message>`. The map without WebGL is reported the same way
 * (`map:no-webgl`): it is not an error, but a test environment that lost WebGL must not pass quietly.
 *
 * No build has this module: it is reached only behind `import.meta.env.DEV` (the CI refuses its prefix in dist/).
 * Constraint: Node 24 loads it directly (no DOM, no `import.meta`); the report function can be replaced in tests.
 */

const PREFIX = 'starmap:caught-error'

/** The report of an error `boundary` caught, as an Error whose message names the boundary. */
export function caughtErrorReportOf(boundary: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${PREFIX} [${boundary}] ${message}`)
}

/** Report an error `boundary` caught as an uncaught error of the page. */
export function reportCaughtError(boundary: string, error: unknown, report: (error: unknown) => void = globalThis.reportError): void {
  report(caughtErrorReportOf(boundary, error))
}
