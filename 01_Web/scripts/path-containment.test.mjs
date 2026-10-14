/**
 * scripts/path-containment.mjs: the path containment the scripts share (batch 7), and the callers whose answer the
 * merge changed. Synthetic paths and temporary directories only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { firstUnsafeComponent, isPathInside, relativeInside } from './path-containment.mjs'
import { assertUploadPath } from './local-editor-upload.mjs'
import { shouldHandlePrivateDataChange } from './private-data-module.mjs'
import { isInsideDirectory } from './private-output.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const root = path.join(tmpdir(), 'starmap-containment-root')

const withDirectory = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-containment-test-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const linkDirectory = (target, at) => symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir')

test('relativeInside: inside paths give their relative path; the root itself only with allowRoot', () => {
  assert.equal(relativeInside(root, path.join(root, 'a', 'b.txt')), path.join('a', 'b.txt'))
  assert.equal(relativeInside(root, path.join(root, 'a', '..', 'b')), 'b')
  assert.equal(relativeInside(root, path.join(root, 'a', '..x')), path.join('a', '..x'))
  assert.equal(relativeInside(root, root), undefined)
  assert.equal(relativeInside(root, `${root}${path.sep}`), undefined)
  assert.equal(relativeInside(root, root, { allowRoot: true }), '')
  assert.equal(isPathInside(root, root), false)
  assert.equal(isPathInside(root, root, { allowRoot: true }), true)
})

test('relativeInside: the parent, siblings that only share a prefix, and a first segment beginning with .. are outside', () => {
  for (const target of [
    path.dirname(root),
    path.join(root, '..'),
    path.join(root, '..', 'other'),
    `${root}2`,
    `${root}-other${path.sep}x`,
    // The strictest rule of the former copies (the editor plugin's): a first segment that begins with `..` is refused
    // even when it names an entry inside the root.
    path.join(root, '..x'),
    path.join(root, '..x', 'file'),
  ]) {
    assert.equal(relativeInside(root, target), undefined, target)
    assert.equal(relativeInside(root, target, { allowRoot: true }), undefined, target)
  }
})

test('relativeInside on Windows: another drive is outside; letter case does not matter', { skip: process.platform !== 'win32' }, () => {
  const drive = path.parse(root).root.slice(0, 1).toUpperCase()
  const other = drive === 'Z' ? 'Y' : 'Z'
  assert.equal(relativeInside(root, `${other}:\\x\\y`), undefined)
  assert.equal(relativeInside(root.toUpperCase(), path.join(root.toLowerCase(), 'a')), 'a')
})

test('firstUnsafeComponent: plain directories, a file target and missing components are safe', async () => withDirectory(async (directory) => {
  await mkdir(path.join(directory, 'a', 'b'), { recursive: true })
  await writeFile(path.join(directory, 'a', 'b', 'file.txt'), 'x')
  assert.equal(await firstUnsafeComponent(directory, path.join(directory, 'a', 'b', 'file.txt')), undefined)
  assert.equal(await firstUnsafeComponent(directory, path.join(directory, 'a', 'b')), undefined)
  assert.equal(await firstUnsafeComponent(directory, path.join(directory, 'a', 'missing', 'deeper', 'file.txt')), undefined)
  assert.equal(await firstUnsafeComponent(directory, directory), undefined)
}))

test('firstUnsafeComponent: a link or junction anywhere (the root included) and a file used as a directory are reported', async () => withDirectory(async (directory) => {
  const outside = path.join(directory, 'outside')
  const library = path.join(directory, 'library')
  await mkdir(outside)
  await mkdir(path.join(library, 'media'), { recursive: true })
  await writeFile(path.join(outside, 'secret.txt'), 'outside')
  await writeFile(path.join(library, 'media', 'file.txt'), 'x')
  await linkDirectory(outside, path.join(library, 'linked'))
  assert.equal(await firstUnsafeComponent(library, path.join(library, 'linked', 'secret.txt')), path.join(library, 'linked'))
  assert.equal(await firstUnsafeComponent(library, path.join(library, 'linked')), path.join(library, 'linked'))
  assert.equal(await firstUnsafeComponent(library, path.join(library, 'media', 'file.txt', 'below')), path.join(library, 'media', 'file.txt'))
  const linkedRoot = path.join(directory, 'linked-root')
  await linkDirectory(library, linkedRoot)
  assert.equal(await firstUnsafeComponent(linkedRoot, path.join(linkedRoot, 'media', 'file.txt')), linkedRoot)
  assert.equal(await firstUnsafeComponent(library, path.join(outside, 'secret.txt')), path.join(outside, 'secret.txt'))
}))

// ---------------------------------------------------------------------------
// Callers whose answer changed with the merge: a first segment beginning with `..`
// ---------------------------------------------------------------------------

test('assertUploadPath (upload staging and media tasks) now also refuses a first segment that begins with ..', async () => withDirectory(async (directory) => {
  const refused = (target) => assert.rejects(assertUploadPath(directory, target), (error) => error instanceof V2WriteError && error.code === 'E_MEDIA_JOB_REVIEW')
  await assertUploadPath(directory, path.join(directory, 'MediaInbox', 'a.jpg'))
  await assertUploadPath(directory, path.join(directory, 'MediaInbox', '..a.jpg'))
  await refused(path.join(directory, '..x', 'a.jpg'))
  await refused(directory)
  await refused(path.join(directory, '..', 'a.jpg'))
}))

test('the private data watcher (data/v2 and below) now ignores a first segment under data/v2 that begins with ..', () => {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  assert.equal(shouldHandlePrivateDataChange('change', paths.v2FilePaths.places, paths), true)
  assert.equal(shouldHandlePrivateDataChange('change', paths.v2DataRoot, paths), true)
  assert.equal(shouldHandlePrivateDataChange('change', path.join(paths.v2DataRoot, 'a', '..x'), paths), true)
  assert.equal(shouldHandlePrivateDataChange('change', path.join(paths.v2DataRoot, '..x', 'places.json'), paths), false)
})

test('the private output gate (isInsideDirectory) now treats a first segment beginning with .. as outside', () => {
  assert.equal(isInsideDirectory(root, root), true)
  assert.equal(isInsideDirectory(path.join(root, 'baseline.json'), root), true)
  assert.equal(isInsideDirectory(path.join(root, '..x', 'baseline.json'), root), false)
  assert.equal(isInsideDirectory(`${root}2`, root), false)
})
