/**
 * The state of an error boundary (./ErrorBoundary.tsx), as pure transitions (robustness batch, design §2).
 *
 * - caught: the error a descendant threw while rendering (or in an effect), React's `getDerivedStateFromError`;
 * - reset: the error cleared and the attempt counted up, so the children mount again from scratch (their key).
 *
 * `caught` is its own flag: a component may throw `undefined` or `null`.
 * Constraint: Node 24 loads it directly.
 */
export interface ErrorBoundaryState {
  readonly caught: boolean
  readonly error: unknown
  readonly attempt: number
}

export const initialErrorBoundaryState: ErrorBoundaryState = Object.freeze({ caught: false, error: undefined, attempt: 0 })

/** `getDerivedStateFromError`: the part of the state an error sets. */
export const caughtErrorState = (error: unknown): Pick<ErrorBoundaryState, 'caught' | 'error'> => ({ caught: true, error })

/** The retry: no error, and a new attempt (the children remount). */
export const resetErrorState = (state: ErrorBoundaryState): ErrorBoundaryState => ({ caught: false, error: undefined, attempt: state.attempt + 1 })
