/**
 * Smoke test of the media bench (./store-media-bench.mjs) at a tiny scale: the segments run on the real plugin path in
 * the store mode (the only write path since 3C-4d; the V2 mode is refused) and leave the library of the expected size.
 * The real scale is run by hand (see the bench's header).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latencySegment, opsSegment } from './store-media-bench.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'

test('smoke: the media bench segments run in the store mode at a tiny scale; the V2 mode is refused', async (t) => {
  const { directory } = await tempPrivateRoot(t, 'starmap-store-media-bench-')
  const environment = { ...process.env }
  // Local requests never go through a proxy.
  for (const key of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[key]
  try {
    await assert.rejects(opsSegment(directory, 'v2', { files: 3, imported: 3 }), /store mode only/)
    const ops = await opsSegment(directory, 'store', { files: 3, imported: 3 })
    assert.ok(ops.import50Ms > 0 && ops.delete1Ms > 0 && ops.renameImportMs > 0)
    // The rename folder's 3 photos and 3 new ones imported, one deleted; the renamed folder moves its records.
    assert.equal(ops.mediaItems, ops.beforeItems + 3 + 3 - 1)
    const latency = await latencySegment(directory, 'store', { files: 3 })
    assert.ok(latency.taskListMs.n >= 1)
  } finally { process.env = environment }
})
