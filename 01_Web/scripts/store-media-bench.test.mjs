/**
 * Smoke test of the media bench (./store-media-bench.mjs) at a tiny scale, in both modes: the segments run on the real
 * plugin path and leave libraries of the same size. The real scale is run by hand (see the bench's header).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latencySegment, opsSegment } from './store-media-bench.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'

test('smoke: the media bench segments run in both modes at a tiny scale', async (t) => {
  const { directory } = await tempPrivateRoot(t, 'starmap-store-media-bench-')
  const environment = { ...process.env }
  // The V2 importer runs as a child process; local requests never go through a proxy.
  for (const key of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[key]
  try {
    const ops = {}
    for (const mode of ['v2', 'store']) {
      ops[mode] = await opsSegment(directory, mode, { files: 3, imported: 3 })
      assert.ok(ops[mode].import50Ms > 0 && ops[mode].delete1Ms > 0 && ops[mode].renameImportMs > 0)
    }
    assert.equal(ops.store.mediaItems, ops.v2.mediaItems, 'the same library in both modes')
    const latency = await latencySegment(directory, 'store', { files: 3 })
    assert.ok(latency.taskListMs.n >= 1)
  } finally { process.env = environment }
})
