/**
 * Code that failed to load, told apart from code that failed while it ran (robustness batch, design §2.4).
 *
 * A failed dynamic import is remembered by the browser for the page (Chromium 153 does not request the same address
 * again: the robustness repro, design §1.6), so loading it again in the same page cannot succeed; a reload of the page
 * can (new code after a site update included). The notices therefore offer a retry only for an error the code threw
 * while rendering, and a page reload for code that did not load. `codeOf(import('…'))` marks the second kind.
 *
 * Constraint: Node 24 loads it directly.
 */

/** A dynamic import that failed; `cause` is the browser's error, and the message is its message. */
export class CodeLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'CodeLoadError'
  }
}

/** The module, or a CodeLoadError when it could not be loaded. */
export function codeOf<T>(load: Promise<T>): Promise<T> {
  return load.catch((error: unknown) => { throw new CodeLoadError(error) })
}
