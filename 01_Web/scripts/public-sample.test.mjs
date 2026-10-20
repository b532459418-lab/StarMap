/**
 * The native public sample's audit and generator (./public-sample.mjs, 3C-5A spec §2.4): the committed sample passes;
 * each rule fails on a copy that breaks it. Copies live under the OS temp directory and hold only the sample itself.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SAMPLE_ALLOWED_FILES, SAMPLE_DIRECTORY, SAMPLE_SOURCE_FILE_NAME, auditPublicSampleDirectory, runSampleBuild } from './public-sample.mjs'
import { SAMPLE_READ_MODEL_FILE_NAME, sampleReadModelText } from '../src/data/sample/sampleBuild.ts'

const quiet = { log: () => {}, logError: () => {} }

/** A copy of the sample directory; `edit(model)` changes its read model, which then counts as freshly generated. */
function copy(t, edit) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'starmap-public-sample-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const name of SAMPLE_ALLOWED_FILES) cpSync(path.join(SAMPLE_DIRECTORY, name), path.join(directory, name))
  let text = readFileSync(path.join(directory, SAMPLE_READ_MODEL_FILE_NAME), 'utf8')
  if (edit) {
    const model = JSON.parse(text)
    edit(model)
    text = `${JSON.stringify(model, null, 2)}\n`
    writeFileSync(path.join(directory, SAMPLE_READ_MODEL_FILE_NAME), text)
  }
  return { directory, expectedText: () => text }
}
const failsWith = (t, edit, pattern) => {
  const { directory, expectedText } = copy(t, edit)
  const errors = auditPublicSampleDirectory(directory, { expectedText })
  assert.ok(errors.some((error) => pattern.test(error)), `${pattern}: ${errors.join(' | ')}`)
}

test('the committed native sample passes the audit, and sample:build --check finds it up to date', async () => {
  assert.deepEqual(auditPublicSampleDirectory(), [])
  assert.equal(await runSampleBuild(['--check'], quiet), 0)
  assert.equal(await runSampleBuild(['--all'], quiet), 1)
})

test('sample:build writes the generated read model, and --check refuses a stale one', async (t) => {
  const { directory } = copy(t)
  writeFileSync(path.join(directory, SAMPLE_READ_MODEL_FILE_NAME), '{}\n')
  assert.equal(await runSampleBuild(['--check'], { directory, ...quiet }), 1)
  assert.equal(await runSampleBuild([], { directory, ...quiet }), 0)
  assert.equal(readFileSync(path.join(directory, SAMPLE_READ_MODEL_FILE_NAME), 'utf8'), sampleReadModelText())
  assert.equal(await runSampleBuild(['--check'], { directory, ...quiet }), 0)
})

test('the audit refuses a read model the source did not generate, and files that do not belong', (t) => {
  const { directory } = copy(t, (model) => { model.entries[0].fields.note = 'Edited by hand.' })
  assert.ok(auditPublicSampleDirectory(directory).some((error) => /must be what sampleSource\.ts generates/.test(error)))
  const extra = copy(t)
  writeFileSync(path.join(extra.directory, 'notes.local.json'), '{}')
  assert.ok(auditPublicSampleDirectory(extra.directory, { expectedText: extra.expectedText }).some((error) => /may contain only/.test(error)))
})

test('the audit refuses an invalid read model and the wrong origin', (t) => {
  failsWith(t, (model) => { model.entries[0].entityId = '01a0ed02-0000-7000-8000-000000000000' }, /full read-model check \(E_REFERENCE/)
  failsWith(t, (model) => { model.formatVersion = 2 }, /E_READ_MODEL_TOO_NEW/)
  failsWith(t, (model) => { model.origin = 'local' }, /origin = sample/)
})

test('the audit requires the public-sample marks: public entities and anchors, privacy_level in both headers', (t) => {
  failsWith(t, (model) => { model.entities[0].visibility = 'private' }, /every entity and anchor must be public/)
  failsWith(t, (model) => { model.anchors[0].visibility = 'private' }, /every entity and anchor must be public/)
  failsWith(t, (model) => { model.sources.find((row) => row.id === 'v2:import').extensions.v2.wantToGo.privacy_level = 'private' }, /wantToGo header must declare/)
})

test('the audit requires runnable, neutral entries and nothing hidden or written by the local editor', (t) => {
  failsWith(t, (model) => { model.entries[0].source.recordId = 'trip-1' }, /footprint record ids must start with sample_/)
  failsWith(t, (model) => { model.entries.find((row) => row.layerId === 'starmap:want-to-go').source.recordId = 'item-1' }, /Want to Go record ids must start with wtg_/)
  failsWith(t, (model) => { model.viewItems[0].hidden = true }, /must not contain hidden content/)
  failsWith(t, (model) => { model.entries[0].extensions.v2.source = 'local-editor' }, /written by the local editor/)
  failsWith(t, (model) => {
    const travel = model.entries.filter((row) => row.layerId === 'starmap:travel').map((row) => row.id)
    model.entries = model.entries.filter((row) => !travel.includes(row.id))
    model.viewItems = model.viewItems.filter((row) => !travel.includes(row.itemId))
    model.sequences = []
  }, /at least one runnable footprint entry/)
})

test('the audit refuses local paths in the read model and in the source', (t) => {
  for (const value of ['C:\\Users\\someone\\photo.jpg', 'D:/Archive/trip.jpg', '/Users/someone/photo.jpg', '/home/someone/photo.jpg', 'file:///tmp/a.jpg', 'MediaInbox/Iceland/a.jpg', '/media/user/abc/original.jpg']) {
    failsWith(t, (model) => { model.entries[0].fields.note = value }, /sample\.read-model\.json must not contain a local path/)
  }
  const { directory, expectedText } = copy(t)
  const source = path.join(directory, SAMPLE_SOURCE_FILE_NAME)
  writeFileSync(source, `${readFileSync(source, 'utf8')}\n// copied from E:\\private\\notes\n`)
  assert.ok(auditPublicSampleDirectory(directory, { expectedText }).some((error) => /sampleSource\.ts must not contain a local path/.test(error)))
})
