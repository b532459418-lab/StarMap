/**
 * scripts/path-containment.mjs: the path containment the scripts share (batch 7), and the callers whose answer the
 * merge changed. Synthetic paths and temporary directories only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { firstUnsafeComponent, isPathInside, mayBeInside, relativeInside } from './path-containment.mjs'
import { assertUploadPath } from './local-editor-upload.mjs'
import { shouldHandlePrivateDataChange } from './private-data-module.mjs'
import { isAllowedPrivateOutput, isInsideDirectory, isInsideRepository, mayBeInsideDirectory } from './private-output.mjs'
import { getPrivatePaths, sourceRoot } from './private-profile.mjs'
import { V2WriteError } from '../src/data/editor/errors.ts'

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

// ---------------------------------------------------------------------------
// Refusal checks (review of batch 7): a name that starts with `..` counts as inside
// ---------------------------------------------------------------------------

/** Names inside a root that only begin with `..`; Windows may drop a segment's trailing dots and spaces. */
const DOUBTFUL = ['..x', '.. ', '...']

test('mayBeInside: only .., ..<sep> and absolute paths are outside; names that begin with .. count as inside', () => {
  for (const name of DOUBTFUL) {
    assert.equal(mayBeInside(root, path.join(root, name, 'x.json')), true, JSON.stringify(name))
    assert.equal(mayBeInside(root, path.join(root, name)), true, JSON.stringify(name))
  }
  for (const target of [path.dirname(root), path.join(root, '..', 'other'), `${root}2`, `${root}-other${path.sep}x`]) {
    assert.equal(mayBeInside(root, target), false, target)
    assert.equal(mayBeInside(root, target, { allowRoot: true }), false, target)
  }
  assert.equal(mayBeInside(root, root), false)
  assert.equal(mayBeInside(root, root, { allowRoot: true }), true)
  assert.equal(mayBeInside(root, path.join(root, 'a', 'b.txt')), true)
  if (process.platform === 'win32') {
    const other = path.parse(root).root.slice(0, 1).toUpperCase() === 'Z' ? 'Y' : 'Z'
    assert.equal(mayBeInside(root, `${other}:\\x\\y`), false)
  }
})

test('allowing checks are unchanged: names that begin with .. stay outside', async () => withDirectory(async (directory) => {
  for (const name of DOUBTFUL) {
    assert.equal(isPathInside(root, path.join(root, name, 'x.json')), false, JSON.stringify(name))
    assert.equal(isInsideDirectory(path.join(root, name, 'baseline.json'), root), false, JSON.stringify(name))
    await assert.rejects(assertUploadPath(directory, path.join(directory, name, 'a.jpg')), (error) => error instanceof V2WriteError && error.code === 'E_MEDIA_JOB_REVIEW', JSON.stringify(name))
  }
  assert.equal(isInsideDirectory(root, root), true)
  assert.equal(isInsideDirectory(path.join(root, 'baseline.json'), root), true)
  assert.equal(isInsideDirectory(`${root}2`, root), false)
  // Inside the private root by the allowing rule only: `<privateRoot>/..x` does not get the private-root allowance.
  const privateRoot = path.join(sourceRoot, '06_private')
  assert.equal(isAllowedPrivateOutput(path.join(privateRoot, 'baseline.json'), { STARMAP_PRIVATE_ROOT: privateRoot }), true)
  for (const name of DOUBTFUL) {
    assert.equal(isAllowedPrivateOutput(path.join(privateRoot, name, 'baseline.json'), { STARMAP_PRIVATE_ROOT: privateRoot }), false, JSON.stringify(name))
  }
}))

test('the private output gate refuses <repository>/..x, <repository>/.. and <repository>/... as inside the repository', () => {
  const environment = { STARMAP_PRIVATE_ROOT: path.join(tmpdir(), 'starmap-containment-private-root') }
  for (const name of DOUBTFUL) {
    const target = path.join(sourceRoot, name, 'out.json')
    assert.equal(isInsideRepository(target), true, JSON.stringify(name))
    assert.equal(mayBeInsideDirectory(target, sourceRoot), true, JSON.stringify(name))
    assert.equal(isAllowedPrivateOutput(target, environment), false, JSON.stringify(name))
  }
  assert.equal(isAllowedPrivateOutput(path.join(tmpdir(), 'starmap-containment-out.json'), environment), true)
  // `privateRootCoversRepository` asks the refusing question: a repository folder whose name starts with .. might lie
  // inside the private root, so that root gets no private-root allowance (sourceRoot is fixed, so the rule is shown here).
  const parent = path.join(tmpdir(), 'starmap-containment-parent')
  for (const name of DOUBTFUL) {
    assert.equal(mayBeInsideDirectory(path.join(parent, `${name}repo`), parent), true, JSON.stringify(name))
    assert.equal(isInsideDirectory(path.join(parent, `${name}repo`), parent), false, JSON.stringify(name))
  }
})

test('the private data watcher handles events under data/v2 whose name starts with .. (a missed event is worse than a reload)', () => {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  assert.equal(shouldHandlePrivateDataChange('change', paths.v2FilePaths.places, paths), true)
  assert.equal(shouldHandlePrivateDataChange('change', paths.v2DataRoot, paths), true)
  for (const name of [...DOUBTFUL, path.join('a', '..x')]) {
    for (const event of ['add', 'change', 'unlink']) {
      assert.equal(shouldHandlePrivateDataChange(event, path.join(paths.v2DataRoot, name, 'places.json'), paths), true, `${event} ${name}`)
    }
  }
  assert.equal(shouldHandlePrivateDataChange('change', `${paths.v2DataRoot}2${path.sep}places.json`, paths), false)
  assert.equal(shouldHandlePrivateDataChange('change', path.join(paths.dataRoot, 'v2-backup', 'places.json'), paths), false)
})
