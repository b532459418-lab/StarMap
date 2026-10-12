/** `vite preview` hardening (batch 2B): evaluates vite.config.ts itself for every mode, against an owned empty private root. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crossSiteRequestGuard } from './local-editor-request-guard.mjs'

const GUARD_PLUGIN = 'starmap-preview-cross-site-guard'

async function withConfig(run) {
  const prefix = 'starmap-preview-config-'
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  const previous = process.env.STARMAP_PRIVATE_ROOT
  process.env.STARMAP_PRIVATE_ROOT = directory
  try {
    const { default: configFor } = await import('../vite.config.ts')
    await run(configFor)
    assert.deepEqual(await readdir(directory), [], 'evaluating the config writes nothing into the private root')
  } finally {
    if (previous === undefined) delete process.env.STARMAP_PRIVATE_ROOT
    else process.env.STARMAP_PRIVATE_ROOT = previous
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith(prefix))
    await rm(directory, { recursive: true, force: true })
  }
}

const pluginsOf = (config) => config.plugins.flat(Infinity).filter(Boolean)

test('vite preview in every mode: no CORS grant, and the cross-site guard is the first preview middleware', async () => withConfig(async (configFor) => {
  for (const mode of ['public', 'personal', 'production']) {
    const config = await configFor({ mode, command: 'serve', isPreview: true })
    assert.deepEqual(config.preview, { cors: false }, mode)
    const previewHooks = pluginsOf(config).filter((plugin) => typeof plugin.configurePreviewServer === 'function')
    assert.equal(previewHooks[0]?.name, GUARD_PLUGIN, mode)
    const registered = []
    await previewHooks[0].configurePreviewServer({ middlewares: { use: (handler) => registered.push(handler) } })
    assert.deepEqual(registered, [crossSiteRequestGuard], mode)
  }
}))

test('dev servers and builds are unchanged: no preview settings and no preview guard plugin', async () => withConfig(async (configFor) => {
  for (const [mode, command] of [['public', 'build'], ['public', 'serve'], ['personal', 'serve'], ['personal', 'build']]) {
    const config = await configFor({ mode, command, isPreview: false })
    assert.equal(config.preview, undefined, `${mode} ${command}`)
    assert.equal(pluginsOf(config).some((plugin) => plugin.name === GUARD_PLUGIN), false, `${mode} ${command}`)
  }
}))
