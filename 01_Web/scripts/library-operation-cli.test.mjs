import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { createMediaJobStore } from './media-job-store.mjs'
import { createLocalEditorImporter } from './local-editor-importer.mjs'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import { getPrivatePaths } from './private-profile.mjs'

const execute = promisify(execFile)
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(webRoot, 'scripts', 'import-media.mjs')
const newId = sequentialUuids(Date.UTC(2026, 9, 4))
const countryId = newId()
const cityId = newId()

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-cli-coordination-'))
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir())
    assert.ok(path.basename(root).startsWith('starmap-cli-coordination-'))
    await rm(root, { recursive: true, force: true })
  })
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, JSON.stringify({
    schema_version: 1, generated_at: '2026-10-04T00:00:00.000Z', places: [
      { id: countryId, subtype: 'country', names: { 'zh-Hans': '测试国家', en: 'Test Country' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 } },
      { id: cityId, subtype: 'city', names: { 'zh-Hans': '测试城市', en: 'Test City' }, partOf: countryId, location: { lat: 64, lng: -21 } },
    ],
  }))
  const folder = path.join(paths.inboxRoot, 'Test Country', 'Test City', 'photos')
  await mkdir(folder, { recursive: true })
  const source = path.join(folder, 'synthetic.jpg')
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 140, b: 90 } } }).jpeg().toFile(source)
  return { paths, source }
}

async function snapshot(root) {
  const files = {}
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name)
      const relative = path.relative(root, target).split(path.sep).join('/')
      if (item.isDirectory()) await walk(target)
      else if (relative !== 'operations/library-operation-state.json') {
        assert.ok(item.isFile(), 'Synthetic fixtures must contain ordinary files only')
        files[relative] = createHash('sha256').update(await readFile(target)).digest('hex')
      }
    }
  }
  await walk(root)
  return files
}

async function cli(paths, args = []) {
  const env = { ...process.env, STARMAP_PRIVATE_ROOT: paths.root }
  delete env.STARMAP_LIBRARY_LEASE
  try {
    const result = await execute(process.execPath, [script, ...args], { cwd: webRoot, env, timeout: 20000 })
    return { code: 0, ...result }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('actual CLI apply refuses unclosed media jobs; preflight stays read only and remains available', { timeout: 30000 }, async (t) => {
  const { paths } = await fixture(t)
  await withLibraryOperation(paths, () => createMediaJobStore(paths).create({ countryId, cityId, kind: 'photo', files: [{ fileName: 'waiting.jpg', bytes: 128 }] }))
  const before = await snapshot(paths.root)
  const applied = await cli(paths, ['--apply'])
  assert.equal(applied.code, 1)
  assert.match(applied.stderr, /E_MEDIA_JOB_PENDING/)
  assert.deepEqual(await snapshot(paths.root), before)
  const checked = await cli(paths)
  assert.equal(checked.code, 0, checked.stderr)
  assert.deepEqual(await snapshot(paths.root), before)
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})

test('actual external CLI cannot enter an editor-held lease and preserves all fixture bytes', { timeout: 30000 }, async (t) => {
  const { paths } = await fixture(t)
  await withLibraryOperation(paths, async () => {
    const before = await snapshot(paths.root)
    for (const args of [[], ['--apply']]) {
      const result = await cli(paths, args)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /E_LIBRARY_BUSY/)
      assert.deepEqual(await snapshot(paths.root), before)
    }
  })
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})

test('actual importer preflight and apply join the explicitly injected parent lease without deadlock', { timeout: 30000 }, async (t) => {
  const { paths, source } = await fixture(t)
  const original = await readFile(source)
  const run = createLocalEditorImporter({ webRoot, privateRoot: paths.root })
  await withLibraryOperation(paths, async (leaseToken) => {
    const lock = path.join(paths.root, 'operations', 'library-operation.lock')
    const before = await readFile(lock, 'utf8')
    await run({ leaseToken })
    assert.equal(await readFile(lock, 'utf8'), before)
    assert.equal((await inspectLibraryOperation(paths)).state, 'busy')
  })
  assert.deepEqual(await readFile(source), original)
  const catalog = JSON.parse(await readFile(paths.v2FilePaths.media, 'utf8'))
  assert.equal(catalog.items.length, 1)
  const generated = await snapshot(paths.userMediaRoot)
  assert.ok(Object.keys(generated).some((name) => name.endsWith('/thumb.webp')))
  assert.ok(Object.keys(generated).some((name) => name.endsWith('/preview.webp')))
  assert.ok(Object.keys(generated).some((name) => name.includes('/original.')))
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})
