/**
 * Path containment for the scripts. Batch 7 merged the copies that the editor plugin, the upload staging, the media task
 * store, the whole-Inbox plan, the private data module and the private output gate each carried. Node built-ins only.
 *
 * Two separate steps, so each caller states which one it needs:
 * - `relativeInside` / `isPathInside` are lexical: both paths are resolved, nothing is read from disk. They keep the
 *   strictest rule of the former copies: a relative path that starts with `..` is outside, which also refuses a name
 *   inside the root that merely begins with `..` (such as `..x`), and so is an absolute one (another drive on Windows).
 * - `firstUnsafeComponent` reads the disk: it refuses symbolic links and junctions on the way from the root to the
 *   target. Callers that serve or write private files use it as well; the private output gate resolves links instead
 *   (./private-output.mjs `canonicalPath`), and the file-watcher filter stays lexical because a removed file has no
 *   entry left to check.
 */
import { lstat } from 'node:fs/promises'
import path from 'node:path'

/**
 * `target` relative to `root` (platform separators) when it lies inside `root`, otherwise undefined.
 * `allowRoot`: the root itself counts as inside (its relative path is '').
 */
export const relativeInside = (root, target, { allowRoot = false } = {}) => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return allowRoot ? '' : undefined
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative
}

/** Whether `target` lies inside `root`; options as for `relativeInside`. */
export const isPathInside = (root, target, options) => relativeInside(root, target, options) !== undefined

/**
 * The first existing component from `root` (included) down to `target` that is a symbolic link or junction, or that
 * is not a directory although `target` lies below it; undefined when there is none. `target` itself may be a file.
 * Missing components are skipped (a path that does not exist yet is fine); any other lstat failure is thrown.
 * A `target` outside `root` is returned as unsafe.
 */
export const firstUnsafeComponent = async (root, target) => {
  const relative = relativeInside(root, target, { allowRoot: true })
  const end = path.resolve(target)
  if (relative === undefined) return end
  let current = path.resolve(root)
  for (const part of ['', ...(relative ? relative.split(path.sep) : [])]) {
    if (part) current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (current !== end && !info.isDirectory())) return current
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return undefined
}
