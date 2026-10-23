/**
 * The local editor's error responses and request bodies (the plugin, the store session, the media endpoints). 3C-5 E:
 * the write context and the refusal responses moved here from the retired ./v2-editor-store.mjs.
 */
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { V2WriteError, errorBody } from '../src/data/editor/errors.ts'

/** An error response body (`{ ok: false, error, code, params? }`). */
export const editorErrorBody = (code, params) => errorBody(new V2WriteError(code, params))

/** The context of an editor write: `now` and `newId` default to the current time and UUIDv7; `countryCatalog` is the plugin's country catalog (upper-case ISO keys). */
export const createEditorWriteContext = ({ countryCatalog, now = new Date(), newId = () => uuidv7() }) => ({ countryCatalog, now, newId })

const reasonOf = (error) => (error instanceof Error ? error.message : String(error ?? '未知错误'))
const isEditorError = (error) => error instanceof V2WriteError || (error?.name === 'V2WriteError' && typeof error?.code === 'string')

/**
 * Refusals that need a choice of the user, with nothing written → 409, `params.candidates` for the page: a place choice
 * (batch 2A, E_PLACE_CHOICE_REQUIRED) or a journey choice (batch 2C, E_JOURNEY_CHOICE_REQUIRED); the decision layer
 * reports the place choice first, so there is only one at a time. Every other refusal is 400.
 */
const CHOICE_REQUIRED_CODES = new Set(['E_PLACE_CHOICE_REQUIRED', 'E_JOURNEY_CHOICE_REQUIRED'])

/** A planner's refusal as a response: 400 (409 for a choice); an unexpected error keeps its reason (E_UNEXPECTED). */
export const editorFailureResponse = (error) => ({
  status: isEditorError(error) && CHOICE_REQUIRED_CODES.has(error.code) ? 409 : 400,
  body: isEditorError(error) ? errorBody(error) : editorErrorBody('E_UNEXPECTED', { reason: reasonOf(error) }),
})

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
