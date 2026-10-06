import { sha256 } from '@noble/hashes/sha2.js'

export const FILE_HASH_CHUNK_BYTES = 1024 * 1024

/** Preserve the server's SHA-256 protocol with bounded browser buffers. */
export async function fileSha256(file: Pick<Blob, 'size' | 'slice'>): Promise<string> {
  const hash = sha256.create()
  const channel = new MessageChannel()
  try {
    for (let offset = 0; offset < file.size; offset += FILE_HASH_CHUNK_BYTES) {
      hash.update(new Uint8Array(await file.slice(offset, Math.min(file.size, offset + FILE_HASH_CHUNK_BYTES)).arrayBuffer()))
      // Give rendering/input events an opportunity between bounded CPU chunks.
      await new Promise<void>(resolve => {
        channel.port1.onmessage = () => resolve()
        channel.port2.postMessage(0)
      })
    }
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
  } finally { channel.port1.close(); channel.port2.close(); hash.destroy() }
}
