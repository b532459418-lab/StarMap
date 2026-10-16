import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MODE_BENCH_SCALES, backupSegment, editorsSegment, generateRoots, httpSegment, mediaSegment, pipelineSegment, readSegment, restoreSegment,
  syntheticV2Files,
} from './store-mode-bench.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'
import { validateV2Files } from '../src/data/canonical/v2Schema.ts'

test('the synthetic V2 files of both scales are valid, and the real one has the real-scale counts', () => {
  for (const scale of Object.values(MODE_BENCH_SCALES)) assert.deepEqual(validateV2Files(syntheticV2Files(scale)), [])
  const real = MODE_BENCH_SCALES.real
  assert.equal(real.countries + real.cities, 3_000)
  assert.equal(real.visited + real.planned + real.wishes, 10_000)
  assert.equal(real.media, 10_000)
})

test('smoke: every segment of the new-library benchmark runs at the tiny scale', async (t) => {
  const { directory } = await tempPrivateRoot(t, 'starmap-store-mode-bench-')
  const scale = MODE_BENCH_SCALES.tiny
  const generated = await generateRoots(directory, scale)
  assert.equal(generated.previewOk, true)
  assert.equal(generated.revision, 1)
  const read = await readSegment(directory)
  assert.match(read.store.firstBuild, /^\[StarMap store\] 读模型（修订号 1）/)
  assert.equal(read.store.rebuilds.length, 5)
  const updates = await httpSegment(directory, scale)
  assert.equal(updates.v2.endToEnd.n, scale.updates)
  assert.equal(updates.store.commit.n, scale.updates)
  const pipeline = await pipelineSegment(directory)
  assert.ok(pipeline.v2FilesJsonBytes > 0 && pipeline.canonicalJsonBytes > 0)
  // 3C-4a: the eight editor writes in both modes.
  const editors = await editorsSegment(directory, scale)
  const endpoints = ['countries', 'records', 'wanttogo', 'wanttogo/update', 'wanttogo/convert', 'state', 'wanttogo/delete', 'countries/delete']
  for (const mode of ['v2', 'store']) {
    // The tiny scale has a single hidden want-to-go item to delete.
    const count = (endpoint) => (endpoint === 'wanttogo/delete' ? 1 : scale.updates)
    for (const endpoint of endpoints) assert.equal(editors[mode][endpoint].endToEnd.n, count(endpoint), `${mode} ${endpoint}`)
    if (mode === 'store') for (const endpoint of endpoints) assert.equal(editors.store[endpoint].commit.n, count(endpoint), endpoint)
  }
  assert.equal(editors.v2.state.commit, undefined, 'V2 mode has no host commit')
})

test('smoke: the media, backup and restore segments (3C-4b) run at the tiny scale', async (t) => {
  const { directory } = await tempPrivateRoot(t, 'starmap-store-mode-bench-')
  const scale = MODE_BENCH_SCALES.tiny
  await generateRoots(directory, scale)
  const media = await mediaSegment(directory, scale)
  assert.equal(media.files, scale.media * 2 + scale.cities)
  const backup = await backupSegment(directory)
  assert.equal(backup.mediaFiles, media.files)
  assert.ok(backup.mediaBytes > media.mediaBytes, 'the pins are counted too')
  assert.ok(backup.leaseMs > 0 && backup.mediaCopyMs >= 0)
  const restore = await restoreSegment(directory)
  assert.equal(restore.revision, backup.revision)
  assert.ok(restore.restored.files >= backup.mediaFiles + 1)
})
