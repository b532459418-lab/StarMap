import { LocalEditorError } from '../i18n/editorErrors.ts'
import { parseLocalEditorResponse } from './localEditorResponse.ts'

const invalidResponse = (response: Response) => new LocalEditorError({
  code: 'E_EDITOR_RESPONSE_INVALID', params: { status: response.status },
})

const nonemptyText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const inboxRelativePath = (value: unknown): value is string => {
  if (!nonemptyText(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\')) return false
  // eslint-disable-next-line no-control-regex -- Response paths cannot contain control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Preserve the flat payload, but require a confirmed delivered file before a session records its path. */
export async function parseMediaUploadResponse(response: Response) {
  const body = await parseLocalEditorResponse<{ fileName: string; bytes: number; sourcePath: string }>(response)
  if (!nonemptyText(body.fileName) || !Number.isSafeInteger(body.bytes) || body.bytes <= 0 || !inboxRelativePath(body.sourcePath)) {
    throw invalidResponse(response)
  }
  return body
}

/** The importer can legitimately produce empty output and no restored ids for an empty requested path list. */
export async function parseMediaImportResponse(response: Response, sourcePaths: readonly string[] = []) {
  const body = await parseLocalEditorResponse<{ output: string; restoredMediaIds: string[] }>(response)
  if (typeof body.output !== 'string' || !Array.isArray(body.restoredMediaIds) || !body.restoredMediaIds.every(nonemptyText)
    || (sourcePaths.length > 0 && body.restoredMediaIds.length === 0)) {
    throw invalidResponse(response)
  }
  return body
}
