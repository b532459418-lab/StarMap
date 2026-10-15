/**
 * The personal build (`vite build --mode personal`): the private-data virtual module carries only what the pages can
 * show, and closeBundle copies only the media files those kept media items refer to (batch 7, review S3). Vite's dev
 * server also calls closeBundle when it shuts down, so the copy must run only for a build, and only in the personal
 * profile; the dev server's module keeps everything, because the editor restores and deletes hidden entries.
 * Everything lives in one owned OS temp directory (a temporary private root and temporary outDirs): the worktree's dist
 * is never written. The private data is the synthetic ./personal-build-filter.fixture.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { hiddenContentFixture, REMOVED } from './personal-build-filter.fixture.mjs'

const prefix = 'starmap-close-bundle-'

/** Every file under `directory` as sorted POSIX paths relative to it. */
const listFiles = async (directory) => {
  const files = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(path.relative(directory, full).split(path.sep).join('/'))
    }
  }
  await walk(directory)
  return files.sort()
}

test('personal build: the module carries only visible content and only its media are copied into build.outDir', async (t) => {
  const temporaryBase = path.resolve(tmpdir())
  const base = await mkdtemp(path.join(temporaryBase, prefix))
  const originalEnvironment = process.env
  const privateRoot = path.join(base, 'private')
  // Import-time path/proxy initialization sees only a synthetic environment pointing at the owned temp root.
  process.env = { STARMAP_PRIVATE_ROOT: privateRoot }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    const { getPrivatePaths } = await import('./private-profile.mjs')
    const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: privateRoot })
    const fixture = hiddenContentFixture()
    await mkdir(paths.v2DataRoot, { recursive: true })
    for (const [key, file] of Object.entries(paths.v2FilePaths)) await writeFile(file, `${JSON.stringify(fixture[key], null, 2)}\n`)
    // Every file any media item refers to, kept or removed, plus one nothing refers to.
    const allMediaFiles = [...new Set(fixture.media.items.flatMap((item) => [item.src, item.variants?.thumb?.src, item.variants?.preview?.src])
      .filter(Boolean).map((src) => src.slice('/media/user/'.length)))]
    for (const relative of [...allMediaFiles, 'stray/unreferenced.jpg']) {
      const file = path.join(paths.userMediaRoot, ...relative.split('/'))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, Buffer.from(`neutral placeholder bytes for ${relative}`))
    }

    let runs = 0
    // Each run gets its own temporary project root; outDir stays relative so the plugin must resolve it against root.
    // The outDir already exists, as after an earlier build, so "nothing copied" means it is still empty.
    const runFor = async ({ profile, command, load = true }) => {
      runs += 1
      const projectRoot = path.join(base, `project-${runs}`)
      const outDir = path.join(projectRoot, 'dist')
      await mkdir(outDir, { recursive: true })
      const plugin = travelAtlasLocalEditor({ profile, privateRoot })
      if (command) plugin.configResolved({ command, root: projectRoot, build: { outDir: 'dist' } })
      const code = load ? await plugin.load(plugin.resolveId('virtual:starmap-private-data')) : undefined
      await plugin.closeBundle()
      return { outDir, code }
    }

    await t.test('Dev server (command serve): the module keeps the hidden entries for the editor, and shutdown copies nothing', async () => {
      const { outDir, code } = await runFor({ profile: 'personal', command: 'serve' })
      for (const id of [...REMOVED.records, ...REMOVED.wantToGo, ...REMOVED.media]) assert.ok(code.includes(id), id)
      assert.deepEqual(await readdir(outDir), [])
    })

    await t.test('Without a resolved config closeBundle copies nothing', async () => {
      const { outDir } = await runFor({ profile: 'personal', load: false })
      assert.deepEqual(await readdir(outDir), [])
    })

    await t.test('Personal build: the module has no hidden entry, and only the kept media files are copied, byte for byte', async () => {
      const { outDir, code } = await runFor({ profile: 'personal', command: 'build' })
      for (const id of [...REMOVED.records, ...REMOVED.wantToGo, ...REMOVED.media, ...REMOVED.places]) assert.ok(!code.includes(id), id)
      for (const coordinate of REMOVED.coordinates) assert.ok(!code.includes(coordinate), coordinate)
      const copied = await listFiles(path.join(outDir, 'media', 'user'))
      assert.deepEqual(copied, [
        '1111111111111111/original.jpg', '1111111111111111/preview.webp', '1111111111111111/thumb.webp',
        '3333333333333333/original.jpg', '3333333333333333/preview.webp', '3333333333333333/thumb.webp',
        'legacy/p2.jpg',
      ])
      for (const hash of REMOVED.mediaHashes) assert.ok(!copied.some((file) => file.startsWith(hash)), hash)
      for (const relative of copied) {
        assert.deepEqual(await readFile(path.join(outDir, 'media', 'user', ...relative.split('/'))), await readFile(path.join(paths.userMediaRoot, ...relative.split('/'))), relative)
      }
    })

    await t.test('Public profile never copies, for a build or a dev server shutdown', async () => {
      for (const command of ['build', 'serve']) {
        const { outDir, code } = await runFor({ profile: 'public', command })
        assert.ok(!code.includes(REMOVED.records[0]), command)
        assert.deepEqual(await readdir(outDir), [], command)
      }
    })

    assert.equal(await readFile(paths.v2FilePaths.places, 'utf8'), `${JSON.stringify(fixture.places, null, 2)}\n`, 'source data untouched')
  } finally {
    process.env = originalEnvironment
    const resolvedBase = path.resolve(base)
    assert.equal(path.dirname(resolvedBase), temporaryBase, 'Cleanup must remain inside OS temp')
    assert.ok(path.basename(resolvedBase).startsWith(prefix))
    await rm(resolvedBase, { recursive: true, force: true })
  }
})
