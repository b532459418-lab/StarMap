/**
 * The files a deletion still has to remove (3C-4c, design v1 §3 with design v2 §4): the rows of `pending_file_ops`,
 * written in the same transaction as the deletion that made them. Run under the library lease, after that deletion, at
 * the start of every media write, and by `library:recover --confirm`.
 *
 * - While a backup copies media (store-backup.mjs mediaCopyInProgress), nothing is deleted: everything waits.
 * - Each target must lie inside its folder (MediaInbox/ or media/user/, isPathInside) with no link or junction on the
 *   way (firstUnsafeComponent); otherwise the row stays for review and nothing is touched.
 * - The registry decides whether a file is still referenced, read again now (design v2 §4):
 *   - a generated directory: an asset linked to its content keeps it (the row is settled, the directory stays);
 *     otherwise the directory goes, and so does its media_files row when nothing links it;
 *   - an Inbox source: a source that is not deleted, at the same path with the same content (the photo was added again
 *     meanwhile), keeps the file; so does a file whose content is not the one the deletion recorded (another file took
 *     the path). Otherwise the file goes, and its entry in the city's sidecar (media.json) too, as V2's deletion does.
 * - Idempotent: a file already gone counts as done (the sidecar entry is still removed). A file Windows reports busy or
 *   denied (EBUSY, EPERM, EACCES) stays queued for the next run.
 * The settled rows leave in one small write (no revision change).
 */
import { lstat, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { sha256File } from './file-hash.mjs'
import { atomicJsonWrite, exists, readJson } from './json-file.mjs'
import { firstUnsafeComponent, isPathInside } from './path-containment.mjs'
import { mediaCopyInProgress } from './store-backup.mjs'
import { pathKeyOf } from './store-media-registry.mjs'

const RETRY_LATER = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Remove the sidecar entry of an Inbox file (`<city>/media.json`, key `<photos|drone>/<name>`, case-insensitive), as V2 does. */
async function removeSidecarEntry(file) {
  const mediaFolder = path.dirname(file)
  const sidecar = path.join(path.dirname(mediaFolder), 'media.json')
  if (!(await exists(sidecar))) return
  const key = path.posix.join(path.basename(mediaFolder), path.basename(file)).toLocaleLowerCase('en-US')
  const entries = await readJson(sidecar, {})
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return
  let changed = false
  for (const name of Object.keys(entries)) {
    if (name.replaceAll('\\', '/').toLocaleLowerCase('en-US') !== key) continue
    delete entries[name]
    changed = true
  }
  if (changed) await atomicJsonWrite(sidecar, entries)
}

/**
 * Run the pending file operations of `store` (the media store adapter: mediaRegistry, settleFileOps). Resolves
 * { paused, deletedSources, deletedDirectories, cancelled, kept }: `kept` rows stay queued (busy files, unsafe paths).
 */
export async function runPendingFileOps({ privatePaths, store, leaseToken, hashFile = sha256File }) {
  const result = { paused: false, deletedSources: 0, deletedDirectories: 0, cancelled: 0, kept: 0 }
  const registry = store.mediaRegistry()
  if (registry.pendingFileOps.length === 0) return result
  if (await mediaCopyInProgress(privatePaths)) return { ...result, paused: true, kept: registry.pendingFileOps.length }
  const linked = new Set(registry.assetFiles.map((link) => link.sha256))
  const liveSources = new Set(registry.sources.filter((source) => source.state !== 'deleted').map((source) => `${source.pathKey}\u0000${source.sha256}`))
  const settled = []
  const filesGone = []
  for (const operation of registry.pendingFileOps) {
    const target = path.join(privatePaths.root, ...operation.target.split('/'))
    const folder = operation.kind === 'delete-source' ? privatePaths.inboxRoot : privatePaths.userMediaRoot
    const sha256 = operation.detail?.sha256
    if (!isPathInside(folder, target) || await firstUnsafeComponent(privatePaths.root, target) !== undefined || typeof sha256 !== 'string') {
      result.kept += 1
      continue
    }
    if (operation.kind === 'delete-generated') {
      if (linked.has(sha256)) { result.cancelled += 1; settled.push(operation.seq); continue }
      try { await rm(target, { recursive: true, force: true, maxRetries: 2 }) } catch (error) {
        if (RETRY_LATER.has(error?.code)) { result.kept += 1; continue }
        throw error
      }
      result.deletedDirectories += 1
      settled.push(operation.seq)
      filesGone.push(sha256)
      continue
    }
    if (liveSources.has(`${pathKeyOf(operation.target)}\u0000${sha256}`)) { result.cancelled += 1; settled.push(operation.seq); continue }
    let info
    try { info = await lstat(target) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (info?.isFile()) {
      if (await hashFile(target) !== sha256) { result.cancelled += 1; settled.push(operation.seq); continue }
      try { await unlink(target) } catch (error) {
        if (RETRY_LATER.has(error?.code)) { result.kept += 1; continue }
        if (error?.code !== 'ENOENT') throw error
      }
      result.deletedSources += 1
    }
    await removeSidecarEntry(target)
    settled.push(operation.seq)
  }
  if (settled.length) await store.settleFileOps({ seqs: settled, files: [...new Set(filesGone)] }, { leaseToken })
  return result
}
