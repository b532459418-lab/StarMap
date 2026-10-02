import { LocalEditorError, type EditorErrorBody } from '../i18n/editorErrors.ts'

export type EditorResponse<T> = EditorErrorBody & { ok: boolean } & T

const recordOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const failureFields = ['error', 'code', 'params', 'details'] as const

const validEnvelope = (body: unknown): body is EditorErrorBody & { ok: boolean } => {
  if (!recordOf(body) || typeof body.ok !== 'boolean') return false
  if (body.ok && failureFields.some((field) => Object.hasOwn(body, field))) return false
  for (const field of ['error', 'details', 'code']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return false
  }
  return body.params === undefined || recordOf(body.params)
}

const invalidResponse = (response: Response, cause?: unknown) => new LocalEditorError({
  code: 'E_EDITOR_RESPONSE_INVALID',
  params: { status: response.status },
  // Keep the parser diagnostic, never the complete response text or an HTML page.
  ...(cause instanceof Error ? { details: cause.message } : {}),
})

/** Parse only the flat local-editor envelope. Failed/unknown writes must never be retried here. */
export async function parseLocalEditorResponse<T>(response: Response): Promise<EditorResponse<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw invalidResponse(response, error)
  }
  if (!validEnvelope(body) || (!response.ok && body.ok)) throw invalidResponse(response)
  if (!response.ok || body.ok !== true) throw new LocalEditorError(body)
  return body as EditorResponse<T>
}
