/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { resources } from './resources.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../data/uiLocale.ts'
import { LocalEditorError, editorErrorNotice, formatEditorError, localizedConversionReason, requiresEditorReload } from './editorErrors.ts'
import { V2_WRITE_ERROR_CODES, messageFor } from '../data/v2write/errors.ts'
// @ts-expect-error The server refusal is an erasable JavaScript module without browser dependencies.
import { legacyWriteRefusal } from '../../scripts/legacy-data.mjs'

test('Every server write code has a translation; error notices follow language without changing recovery messages', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  for (const code of V2_WRITE_ERROR_CODES) assert.ok(i18n.exists(`domainError:${code}`), code)
  const error = new LocalEditorError({ error: messageFor('E_REQUIRED', { field: 'city' }), code: 'E_REQUIRED', params: { field: 'city' } })
  assert.equal(editorErrorNotice(error, 'editor:saveFailed'), error)
  assert.equal(formatEditorError(error, i18n.t), 'Enter Chinese city name.')
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.equal(formatEditorError(error, i18n.t), '请填写城市中文名。')
  assert.equal(error.message, '请填写城市中文名。')
  const partial = new LocalEditorError({ error: '足迹已创建，但想去记录未更新。', code: 'E_PARTIAL_WRITE', params: { message: '足迹已创建，但想去记录未更新。' }, details: 'diagnostic' })
  assert.ok(partial.message.startsWith('足迹已创建，但'))
  assert.ok(formatEditorError(partial, i18n.t).includes('diagnostic'))
  assert.equal(formatEditorError(new LocalEditorError({ error: 'legacy error', code: 'E_FUTURE', details: 'raw details' }), i18n.t), 'legacy error\nraw details')
  assert.equal(formatEditorError(new Error('network diagnostic'), i18n.t), 'network diagnostic')
  assert.deepEqual(editorErrorNotice(null, 'editor:saveFailed'), { key: 'editor:saveFailed' })
})

test('Media summaries keep user names, correct counts and details, without mutating params', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  const params = { cities: [{ name: '京都・Kyoto', count: 1 }, { name: 'Other', count: 2 }] }
  const original = structuredClone(params)
  const error = new LocalEditorError({ code: 'E_COUNTRY_HAS_MEDIA', params, details: 'raw importer output' })
  const display = formatEditorError(error, i18n.t)
  assert.match(display, /京都・Kyoto.*1 media item/)
  assert.match(display, /Other.*2 media items/)
  assert.ok(display.endsWith('raw importer output'))
  assert.deepEqual(params, original)
  const reason = messageFor('E_CONVERT_NO_COORDINATES')
  assert.equal(localizedConversionReason(reason, i18n.t), 'This place has no coordinates and cannot be marked as visited.')
  assert.equal(localizedConversionReason('external reason', i18n.t), 'external reason')
  assert.equal(localizedConversionReason(undefined, i18n.t), undefined)
})

test('Media validation and importer stages translate while preserving original diagnostics and dimensions', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: false, initAsync: false })
  const cases = [
    { code: 'E_MEDIA_NAME_INVALID', params: { field: 'media_filename' }, en: 'File name is invalid.', zh: '文件名无效。' },
    { code: 'E_MEDIA_UPLOAD_EMPTY', params: {}, en: 'No file content was received.', zh: '没有收到文件内容。' },
    { code: 'E_MEDIA_UPLOAD_TOO_LARGE', params: { limitMiB: 250, limitBytes: 262144000 }, en: 'A file cannot exceed 250 MiB.', zh: '单个文件不能超过 250 MiB。' },
    { code: 'E_MEDIA_PANORAMA_RATIO', params: { width: 64, height: 48 }, en: 'The selected image is 64 × 48', zh: '所选图片为 64 × 48' },
    { code: 'E_MEDIA_IMAGE_INVALID', params: {}, en: 'The image dimensions could not be read', zh: '无法读取图片尺寸' },
    { code: 'E_MEDIA_IMPORT_FAILED', params: { stage: 'preflight', reason: 'neutral executor failure' }, en: 'Media preflight failed.', zh: '媒体预检失败。' },
    { code: 'E_MEDIA_IMPORT_FAILED', params: { stage: 'apply', reason: 'neutral executor failure' }, en: 'Media import failed.', zh: '媒体导入失败。' },
    { code: 'E_MEDIA_IMPORT_FAILED', params: { stage: 'future-stage', reason: 'neutral executor failure' }, en: 'Media import failed.', zh: '媒体导入失败。' },
  ]
  for (const entry of cases) {
    const params = structuredClone(entry.params)
    const error = new LocalEditorError({ code: entry.code, params, error: 'original server message', details: 'raw stdout\r\nraw stderr\n' })
    await i18n.changeLanguage(EN_UI_LOCALE)
    const english = formatEditorError(error, i18n.t)
    assert.ok(english.startsWith(entry.en), english)
    assert.ok(english.endsWith(error.details!))
    assert.ok(!english.includes('{{'), english)
    await i18n.changeLanguage(DEFAULT_UI_LOCALE)
    const chinese = formatEditorError(error, i18n.t)
    assert.ok(chinese.startsWith(entry.zh), chinese)
    assert.ok(chinese.endsWith(error.details!))
    if ('reason' in entry.params && typeof entry.params.reason === 'string') {
      assert.ok(english.includes(entry.params.reason))
      assert.ok(chinese.includes(entry.params.reason))
    }
    assert.equal(error.message, 'original server message\nraw stdout\r\nraw stderr\n')
    assert.deepEqual(params, entry.params)
  }
})

test('Unmigrated-data refusals and empty response errors translate without changing server messages', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: EN_UI_LOCALE, initAsync: false })
  const refusal = legacyWriteRefusal({ legacyFiles: ['travel-map.local.json'], v2Files: [] })
  const error = new LocalEditorError(refusal.body)
  const english = formatEditorError(error, i18n.t)
  assert.match(english, /No changes were saved/)
  assert.match(english, /4fd32a9/)
  assert.match(english, /return to the latest version/)
  assert.match(english, /Old-format files: travel-map.local.json/)
  assert.equal(error.message, refusal.body.error)
  const emptyError = new LocalEditorError({})
  assert.equal(formatEditorError(emptyError, i18n.t), 'The local editing operation failed.')
  assert.equal(formatEditorError(new LocalEditorError({ details: 'raw diagnostic' }), i18n.t), 'raw diagnostic')
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.match(formatEditorError(error, i18n.t), /这次修改没有保存/)
  assert.match(formatEditorError(error, i18n.t), /旧格式文件：travel-map.local.json/)
  assert.equal(formatEditorError(emptyError, i18n.t), '本地编辑操作失败。')
  assert.equal(error.message, refusal.body.error)
})

test('Recovery follows structured codes and written files, preserving raw messages and params', () => {
  const params = { written: ['places'], failed: 'travelMap', reason: 'neutral disk failure' }
  const partial = new LocalEditorError({ error: 'Partial save without Chinese prefix', code: 'E_PARTIAL_WRITE', params })
  assert.ok(requiresEditorReload(partial))
  assert.equal(partial.message, 'Partial save without Chinese prefix')
  assert.equal(partial.params, params)
  assert.ok(requiresEditorReload(new LocalEditorError({ code: 'E_WRITE_FAILED', params })))
  assert.ok(requiresEditorReload(new LocalEditorError({ code: 'E_EDITOR_RESPONSE_INVALID', params: { status: 503 } })))
  for (const written of [[], undefined, null, 'places']) {
    assert.equal(requiresEditorReload(new LocalEditorError({ error: '足迹已创建，但来自错误原因的普通文字。', code: 'E_WRITE_FAILED', params: { written } })), false)
  }
  assert.equal(requiresEditorReload(new LocalEditorError({ error: '足迹已创建，但这是普通拒绝消息。', code: 'E_REQUIRED' })), false)
  assert.equal(requiresEditorReload(new LocalEditorError({ error: '足迹已创建，但这是普通拒绝消息。', code: 'E_LEGACY_UNMIGRATED' })), false)
  assert.ok(requiresEditorReload(new Error('足迹已创建，但想去条目没有移除。')))
  assert.ok(requiresEditorReload(new LocalEditorError({ error: '足迹已创建，但想去条目没有移除。', code: 'E_FUTURE' })))
  assert.equal(requiresEditorReload(new LocalEditorError({ error: 'future refusal', code: 'E_FUTURE' })), false)
  assert.equal(requiresEditorReload(new Error('ordinary failure')), false)
  assert.equal(requiresEditorReload(null), false)
  assert.deepEqual(params, { written: ['places'], failed: 'travelMap', reason: 'neutral disk failure' })
})

test('Unknown write outcomes require reload without changing ordinary error handling or original errors', () => {
  const unknownErrors = [
    new TypeError('Failed to fetch'),
    new DOMException('The operation was aborted.', 'AbortError'),
    new Error('Unknown write failure'),
    new LocalEditorError({ error: 'Future write failure', code: 'E_FUTURE' }),
  ]
  for (const error of unknownErrors) {
    const message = error.message
    assert.equal(requiresEditorReload(error), false)
    assert.equal(requiresEditorReload(error, { afterWrite: true }), true)
    assert.equal(editorErrorNotice(error, 'editor:convertFailed'), error)
    assert.equal(error.message, message)
  }
  for (const error of [null, undefined, 'unknown rejection', {}]) {
    assert.equal(requiresEditorReload(error), false)
    assert.equal(requiresEditorReload(error, { afterWrite: true }), true)
  }
  for (const code of ['E_REQUIRED', 'E_LEGACY_UNMIGRATED', 'E_LOCAL_EDITOR_FAILED']) {
    assert.equal(requiresEditorReload(new LocalEditorError({ error: 'Ordinary refusal', code }), { afterWrite: true }), false)
  }
  assert.equal(requiresEditorReload(new LocalEditorError({ code: 'E_WRITE_FAILED', params: { written: [] } }), { afterWrite: true }), false)
  assert.equal(requiresEditorReload(new LocalEditorError({ code: 'E_WRITE_FAILED', params: { written: ['travel'] } }), { afterWrite: true }), true)
})

test('Unknown write result guidance follows the current language beside the unchanged transport diagnostic', async () => {
  const i18n = createInstance()
  await i18n.init({ resources, lng: EN_UI_LOCALE, fallbackLng: false, initAsync: false })
  const error = new TypeError('Failed to fetch')
  assert.ok(i18n.exists('editor:writeResultUnknown'))
  const english = i18n.t('editor:writeResultUnknown')
  assert.notEqual(english, 'editor:writeResultUnknown')
  assert.equal(formatEditorError(error, i18n.t), 'Failed to fetch')
  await i18n.changeLanguage(DEFAULT_UI_LOCALE)
  assert.ok(i18n.exists('editor:writeResultUnknown'))
  assert.notEqual(i18n.t('editor:writeResultUnknown'), english)
  assert.equal(formatEditorError(error, i18n.t), 'Failed to fetch')
})
