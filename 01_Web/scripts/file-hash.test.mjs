/**
 * scripts/file-hash.mjs: the one file SHA-256 the scripts share (batch 7).
 * Synthetic files in a temporary directory only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { sha256File } from './file-hash.mjs'

const withDirectory = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-file-hash-test-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the digest equals the SHA-256 of the whole content: empty, small and a file larger than one stream chunk', async () => withDirectory(async (directory) => {
  const large = Buffer.alloc(200_000)
  for (let index = 0; index < large.length; index += 1) large[index] = (index * 31 + 7) % 251
  for (const [name, bytes] of [['empty.bin', Buffer.alloc(0)], ['small.txt', Buffer.from('neutral synthetic bytes\n')], ['large.bin', large]]) {
    const file = path.join(directory, name)
    await writeFile(file, bytes)
    assert.equal(await sha256File(file), createHash('sha256').update(bytes).digest('hex'), name)
  }
  assert.equal(await sha256File(path.join(directory, 'empty.bin')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
}))

test('a missing file or a directory rejects with the file system error', async () => withDirectory(async (directory) => {
  await assert.rejects(sha256File(path.join(directory, 'missing.bin')), (error) => error.code === 'ENOENT')
  await assert.rejects(sha256File(directory), (error) => typeof error.code === 'string')
}))
