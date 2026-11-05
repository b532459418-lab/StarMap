/**
 * The log of an error an error boundary caught (robustness batch; React 19's `onCaughtError`, ../main.tsx).
 *
 * React's own handler for these errors only logs them (`defaultOnCaughtError`, a console.error with the component
 * stack); passing `onCaughtError` replaces it, so this logs the same: the error, which boundary caught it and where.
 * Every build keeps this log. The browser tests' report of the same errors is ./caughtErrorReport.ts.
 *
 * Constraint: Node 24 loads it directly (no DOM, no `import.meta`).
 */

/** What React passes with a caught error: the component stack and the class component that caught it. */
export interface CaughtErrorInfo {
  readonly componentStack?: string | null
  readonly errorBoundary?: unknown
}

/** The boundary's `name` (../components/ErrorBoundary.tsx), or 'unknown' for another boundary or none. */
export function boundaryNameOf(info: CaughtErrorInfo | undefined): string {
  const props = (info?.errorBoundary as { props?: { name?: unknown } } | null | undefined)?.props
  return typeof props?.name === 'string' && props.name ? props.name : 'unknown'
}

/** Log a caught error as React's default handler does, naming the boundary. */
export function logCaughtError(error: unknown, info: CaughtErrorInfo | undefined, log: (...values: unknown[]) => void = console.error): void {
  log(error, `\n\nThe above error was caught by the error boundary "${boundaryNameOf(info)}".${info?.componentStack ?? ''}`)
}
