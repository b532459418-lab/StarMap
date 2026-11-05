import { Component, Fragment } from 'react'
import type { ReactNode } from 'react'
import { caughtErrorState, initialErrorBoundaryState, resetErrorState, type ErrorBoundaryState } from './errorBoundaryState.ts'

export interface ErrorFallbackProps {
  /** The boundary's name (`data-error-boundary` on its notice, the browser tests' report). */
  readonly name: string
  readonly error: unknown
  /** Clear the error and mount the children again. */
  readonly reset: () => void
}

interface ErrorBoundaryProps {
  readonly name: string
  readonly fallback: (props: ErrorFallbackProps) => ReactNode
  readonly children?: ReactNode
}

/**
 * One part of the page that shows a notice instead of disappearing with the whole page (robustness batch, design §2):
 * an error a descendant throws while rendering, in an effect or while its code loads (`lazy`, ./codeLoad.ts) is caught
 * here, and `fallback` renders in the children's place. Errors in event handlers and asynchronous code are not React's
 * and pass by, as before. Without an error it renders only its children.
 *
 * React reports every caught error to the root's `onCaughtError` (../main.tsx): logged, and reported to the browser
 * tests, which fail on it unless the case expects it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = initialErrorBoundaryState

  static getDerivedStateFromError(error: unknown) {
    return caughtErrorState(error)
  }

  reset = () => {
    this.setState(resetErrorState)
  }

  render() {
    if (this.state.caught) return this.props.fallback({ name: this.props.name, error: this.state.error, reset: this.reset })
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}
