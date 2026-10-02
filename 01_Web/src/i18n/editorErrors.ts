import { domainErrorResources } from './domainErrorResources.ts'

export type EditorErrorBody = { error?: string; details?: string; code?: string; params?: Record<string, unknown> }
type Translate = (key: string, values?: Record<string, unknown>) => string

/** Preserve the server message for existing recovery decisions; translate only at display time. */
export class LocalEditorError extends Error {
  readonly code?: string
  readonly params: Record<string, unknown>
  readonly details?: string

  constructor(body: EditorErrorBody) {
    super([body.error, body.details].filter(Boolean).join('\n') || '本地编辑操作失败。')
    this.name = 'LocalEditorError'
    this.code = body.code ?? (!body.error && !body.details ? 'E_LOCAL_EDITOR_FAILED' : undefined)
    this.params = body.params ?? {}
    this.details = body.details
  }
}

export const editorErrorNotice = (error: unknown, fallbackKey: string) =>
  error instanceof Error ? error : { key: fallbackKey }

export function formatEditorError(error: Error, t: Translate): string {
  if (!(error instanceof LocalEditorError) || !error.code || !Object.hasOwn(domainErrorResources.en, error.code)) return error.message
  const params = error.params
  const field = typeof params.field === 'string' ? params.field : ''
  const fieldKey = `field_${field}`
  const values: Record<string, unknown> = {
    ...params,
    field: Object.hasOwn(domainErrorResources.en, fieldKey) ? t(`domainError:${fieldKey}`) : field,
    reason: typeof params.reason === 'string' ? params.reason : '',
    message: typeof params.message === 'string' ? params.message : '',
    ids: Array.isArray(params.ids) ? params.ids.map(String).join(', ') : '',
    folders: Array.isArray(params.folders) ? params.folders.map(String).join(', ') : '',
  }
  if (Array.isArray(params.cities)) values.cities = params.cities.map((city: unknown) => {
    const record = city && typeof city === 'object' ? city as Record<string, unknown> : {}
    return t('domainError:mediaItem', {
      name: typeof record.name === 'string' ? record.name : t('domainError:unknownCity'),
      count: typeof record.count === 'number' ? record.count : 0,
    })
  }).join(', ')
  const legacyFiles = error.code === 'E_LEGACY_UNMIGRATED' && Array.isArray(params.legacyFiles) && params.legacyFiles.length
    ? t('domainError:legacyFiles', { files: params.legacyFiles.map(String).join(', ') })
    : undefined
  return [t(`domainError:${error.code}`, values).trim(), legacyFiles, error.details].filter(Boolean).join('\n')
}

const conversionCodes = ['E_CONVERT_COUNTRY_KIND', 'E_CONVERT_NO_COORDINATES', 'E_CONVERT_HIDDEN', 'E_CONVERT_CITY_IN_FOOTPRINT', 'E_PLANNED_NO_COORDINATES'] as const
/** Existing domain rules keep returning their stable messages; only presentation changes. */
export function localizedConversionReason(reason: string | undefined, t: Translate): string | undefined {
  if (reason === undefined) return undefined
  const code = conversionCodes.find((candidate) => domainErrorResources.zh[candidate] === reason)
  return code ? t(`domainError:${code}`) : reason
}
