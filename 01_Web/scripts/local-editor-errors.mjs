import { V2WriteError, errorBody } from '../src/data/v2write/errors.ts'

/** Keep structured editor errors and raw diagnostics separate from system errno codes. */
export function normalizeLocalEditorError(error, fallbackCode = 'E_UNEXPECTED') {
  if (error instanceof V2WriteError || (error?.name === 'V2WriteError' && typeof error?.code === 'string')) {
    return errorBody(error)
  }
  const params = error instanceof Error ? { reason: error.message } : undefined
  const body = errorBody(new V2WriteError(fallbackCode, params))
  return {
    ...body,
    // Even an empty Error message stays byte-for-byte compatible with the HTTP catch.
    ...(error instanceof Error ? { error: error.message } : {}),
    ...(typeof error?.details === 'string' ? { details: error.details } : {}),
  }
}

export const maxJsonBodyBytes = 1024 * 1024

/** Read only the supplied request stream; this module has no filesystem or configuration IO. */
export async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxJsonBodyBytes) throw new V2WriteError('E_REQUEST_TOO_LARGE', { limitBytes: maxJsonBodyBytes })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new V2WriteError('E_REQUEST_INVALID', { reason: error.message })
  }
}
