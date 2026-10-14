/**
 * Cesium build setup (batch 4B, E8): Cesium's own Vite recipe replaces the unmaintained vite-plugin-cesium; the dev
 * server loads Cesium's minified build (E1). Evaluates vite.config.ts itself, against an owned empty private root, like
 * vite-preview-config.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cesiumVersion = JSON.parse(await readFile(new URL('../node_modules/cesium/package.json', import.meta.url), 'utf8')).version
const MODES = [['public', 'build'], ['public', 'serve'], ['personal', 'serve'], ['personal', 'build']]

async function withConfig(run) {
  const prefix = 'starmap-cesium-config-'
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

const pluginNamesOf = (config) => config.plugins.flat(Infinity).filter(Boolean).map((plugin) => plugin.name)

test('every mode points Cesium at the versioned static directory and copies its run-time files there', async () => withConfig(async (configFor) => {
  for (const [mode, command] of MODES) {
    const config = await configFor({ mode, command, isPreview: false })
    assert.deepEqual(config.define, { CESIUM_BASE_URL: JSON.stringify(`/cesium/${cesiumVersion}`) }, `${mode} ${command}`)
    const names = pluginNamesOf(config)
    assert.ok(names.includes('vite-plugin-static-copy:serve') && names.includes('vite-plugin-static-copy:build'), `${mode} ${command}`)
    assert.equal(names.some((name) => name.startsWith('vite-plugin-cesium')), false, `${mode} ${command}`)
  }
}))

test('Cesium and only Cesium gets its own chunk, which opens with the license header of the installed package', async () => withConfig(async (configFor) => {
  const { output } = (await configFor({ mode: 'public', command: 'build', isPreview: false })).build.rolldownOptions
  const [group] = output.codeSplitting.groups
  assert.equal(group.name, 'cesium')
  for (const id of ['/x/node_modules/cesium/Source/Cesium.js', 'C:\\x\\node_modules\\@cesium\\engine\\Source\\Core\\Cartesian3.js', '/x/node_modules/@cesium/widgets/Source/Viewer/Viewer.js']) {
    assert.ok(group.test.test(id), id)
  }
  for (const id of ['/x/node_modules/resium/dist/resium.js', '/x/src/components/CesiumAtlasGlobe.tsx', '/x/node_modules/cesium-extra/index.js']) {
    assert.equal(group.test.test(id), false, id)
  }
  const header = await output.postBanner({ name: 'cesium' })
  assert.match(header, /^\/\*\*\n \* @license\n \* Cesium - https:\/\/github\.com\/CesiumGS\/cesium\n/)
  assert.ok(header.includes(` * Version ${cesiumVersion}\n`))
  assert.ok(header.includes('Licensed under the Apache License, Version 2.0') && header.endsWith('*/'))
  for (const name of ['index', 'jsx-runtime', 'CollectionPage']) assert.equal(await output.postBanner({ name }), '', name)
}))

// Batch 4B (E1): Cesium's minified build on the dev server only.
test('only the dev server loads Cesium from its minified build; builds bundle the sources', async () => withConfig(async (configFor) => {
  const minified = path.join(path.dirname(fileURLToPath(new URL('../node_modules/cesium/package.json', import.meta.url))), 'Build', 'Cesium', 'index.js')
  for (const mode of ['public', 'personal']) {
    const [alias, ...others] = (await configFor({ mode, command: 'serve', isPreview: false })).resolve.alias
    assert.deepEqual(others, [], mode)
    assert.equal(path.resolve(alias.replacement), path.resolve(minified), mode)
    assert.ok(alias.find.test('cesium'), mode)
    for (const id of ['cesium/Build/Cesium/Widgets/widgets.css', 'cesium/package.json', '@cesium/engine', 'resium']) assert.equal(alias.find.test(id), false, id)
    assert.equal((await configFor({ mode, command: 'build', isPreview: false })).resolve, undefined, mode)
  }
}))
