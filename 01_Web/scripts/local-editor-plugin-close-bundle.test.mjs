/**
 * closeBundle copies the private media into the build output for `build:personal`. Vite's dev server also calls
 * closeBundle when it shuts down, so the copy must run only for a build, and only in the personal profile.
 * Everything lives in one owned OS temp directory (a temporary private root and temporary outDirs): the worktree's dist
 * is never written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const prefix = 'starmap-close-bundle-'

test('closeBundle copies private media into build.outDir only for a personal build', async (t) => {
  const temporaryBase = path.resolve(tmpdir())
  const base = await mkdtemp(path.join(temporaryBase, prefix))
  const originalEnvironment = process.env
  const privateRoot = path.join(base, 'private')
  // Import-time path/proxy initialization sees only a synthetic environment pointing at the owned temp root.
  process.env = { STARMAP_PRIVATE_ROOT: privateRoot }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    const mediaSegments = ['abc123', 'thumb.webp']
    const fakeBytes = Buffer.from('neutral placeholder bytes, not an image')
    await mkdir(path.join(privateRoot, 'media', 'user', mediaSegments[0]), { recursive: true })
    await writeFile(path.join(privateRoot, 'media', 'user', ...mediaSegments), fakeBytes)

    let runs = 0
    // Each run gets its own temporary project root; outDir stays relative so the plugin must resolve it against root.
    // The outDir already exists, as after an earlier build, so "nothing copied" means it is still empty.
    const closeBundleFor = async ({ profile, command }) => {
      runs += 1
      const projectRoot = path.join(base, `project-${runs}`)
      const outDir = path.join(projectRoot, 'dist')
      await mkdir(outDir, { recursive: true })
      const plugin = travelAtlasLocalEditor({ profile, privateRoot })
      if (command) plugin.configResolved({ command, root: projectRoot, build: { outDir: 'dist' } })
      await plugin.closeBundle()
      return outDir
    }

    await t.test('Dev server shutdown (command serve) copies nothing in the personal profile', async () => {
      const outDir = await closeBundleFor({ profile: 'personal', command: 'serve' })
      assert.deepEqual(await readdir(outDir), [])
    })

    await t.test('Without a resolved config closeBundle copies nothing', async () => {
      const outDir = await closeBundleFor({ profile: 'personal' })
      assert.deepEqual(await readdir(outDir), [])
    })

    await t.test('Personal build copies the media into <root>/<build.outDir>/media/user with identical bytes', async () => {
      const outDir = await closeBundleFor({ profile: 'personal', command: 'build' })
      assert.deepEqual(await readdir(path.join(outDir, 'media', 'user')), [mediaSegments[0]])
      assert.deepEqual(await readdir(path.join(outDir, 'media', 'user', mediaSegments[0])), [mediaSegments[1]])
      assert.deepEqual(await readFile(path.join(outDir, 'media', 'user', ...mediaSegments)), fakeBytes)
    })

    await t.test('Public profile never copies, for a build or a dev server shutdown', async () => {
      for (const command of ['build', 'serve']) {
        const outDir = await closeBundleFor({ profile: 'public', command })
        assert.deepEqual(await readdir(outDir), [], command)
      }
    })

    assert.deepEqual(await readFile(path.join(privateRoot, 'media', 'user', ...mediaSegments)), fakeBytes, 'source media untouched')
  } finally {
    process.env = originalEnvironment
    const resolvedBase = path.resolve(base)
    assert.equal(path.dirname(resolvedBase), temporaryBase, 'Cleanup must remain inside OS temp')
    assert.ok(path.basename(resolvedBase).startsWith(prefix))
    await rm(resolvedBase, { recursive: true, force: true })
  }
})
