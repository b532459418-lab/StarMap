/**
 * The SHA-256 of a file's content (lowercase hex), read as a stream. Batch 7 merged the scripts' copies into this one:
 * the media importer, the whole-Inbox plan, media tasks, the library backup and the store backup each had their own.
 * Node built-ins only.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export const sha256File = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
