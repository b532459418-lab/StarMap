/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileSha256, FILE_HASH_CHUNK_BYTES } from './fileSha256.ts'

test('chunked browser hashing matches server SHA-256 for empty and UTF-8 values', async () => {
  for (const text of ['', 'abc', 'Synthetic · 中文']) {
    assert.equal(await fileSha256(new Blob([text])), createHash('sha256').update(text).digest('hex'))
  }
})
test('a multi-chunk file never requests an unbounded file buffer', async () => {
  const bytes = new Uint8Array(FILE_HASH_CHUNK_BYTES * 2 + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255
  const blob = new Blob([bytes]), requests: number[] = []
  const input = { size: blob.size, slice(start = 0, end = blob.size) {
    requests.push(end - start); assert.ok(end - start <= FILE_HASH_CHUNK_BYTES)
    return blob.slice(start, end)
  } }
  assert.equal(await fileSha256(input), createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(requests, [FILE_HASH_CHUNK_BYTES, FILE_HASH_CHUNK_BYTES, 17])
})
test('failed file reads propagate rather than producing an upload fingerprint', async () => {
  const error = new Error('synthetic unavailable file')
  const file = { size: 1, slice() { throw error } }
  await assert.rejects(fileSha256(file), candidate => candidate === error)
})
