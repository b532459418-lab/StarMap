/**
 * The client side of a write to the new library (3C-3, design 3B §4.4 and §4.5). Used only by the want-to-go update
 * in ./localEditorApi.ts, so it is loaded behind the same gate (`import.meta.env.DEV && localEditorAvailable`) and is in
 * no build output.
 *
 * - One user action gets one request id (UUIDv7, `x-starmap-request-id`); the page's store revision travels as
 *   `x-starmap-base-revision`.
 * - When the outcome is not known (E_OUTCOME_UNKNOWN, the connection broke before a response, or the response could not
 *   be read), the same request is sent once more with the same request id: the server answers a committed request with
 *   its original receipt and never writes it twice. If that is still unknown, `onUnconfirmed` blocks every further write
 *   on the page until a reload (batch 6's requireLocalEditorReload) and E_OUTCOME_UNKNOWN is thrown.
 * - Every other failure (E_STALE, E_OPERATION_CONFLICT, E_LIBRARY_BUSY, E_STORE_BUSY, input errors) is confirmed not
 *   committed and is thrown as it is, without a retry.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, `import type` for types).
 */
import { uuidv7 } from './canonical/uuidv7.ts'
import { LocalEditorError } from '../i18n/editorErrors.ts'

export const STORE_REQUEST_ID_HEADER = 'x-starmap-request-id'
export const STORE_BASE_REVISION_HEADER = 'x-starmap-base-revision'

export type StoreWriteHeaders = Readonly<Record<string, string>>

export interface StoreWriteOptions {
  /** The store revision the page was built from. */
  readonly baseRevision: number
  /** Called once when the outcome stays unknown after the retry. */
  readonly onUnconfirmed: () => void
  /** Request id generator (tests). */
  readonly newRequestId?: () => string
}

/** Whether a failed attempt may have been committed: the server said so, the connection broke, or the answer was unreadable. */
export function isUnconfirmedOutcome(error: unknown): boolean {
  if (error instanceof LocalEditorError) return error.code === 'E_OUTCOME_UNKNOWN' || error.code === 'E_EDITOR_RESPONSE_INVALID'
  // fetch rejects with a TypeError when no response arrives; an abort is the caller's own decision.
  return error instanceof TypeError
}

/** Send one store write (`send` performs the request with the given headers), retrying an unknown outcome once. */
export async function sendStoreWrite<T>(send: (headers: StoreWriteHeaders) => Promise<T>, options: StoreWriteOptions): Promise<T> {
  const headers: StoreWriteHeaders = {
    [STORE_REQUEST_ID_HEADER]: (options.newRequestId ?? (() => uuidv7()))(),
    [STORE_BASE_REVISION_HEADER]: String(options.baseRevision),
  }
  try {
    return await send(headers)
  } catch (error) {
    if (!isUnconfirmedOutcome(error)) throw error
  }
  try {
    return await send(headers)
  } catch (error) {
    if (!isUnconfirmedOutcome(error)) throw error
    options.onUnconfirmed()
    throw new LocalEditorError({ code: 'E_OUTCOME_UNKNOWN' })
  }
}
