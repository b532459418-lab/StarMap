/**
 * Test helpers for media in the new-library mode through the plugin (3C-4c): a migrated synthetic library
 * (./media-inbox.fixture.mjs: invented places, plain-colour images, a real V2 import, then store:migrate) served by the
 * local editor plugin without a server (./store-mode.fixture.mjs). Not a test file itself; not imported by the App.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { PLACE, importedV2Library } from './media-inbox.fixture.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { directoryOf, pathKeyOf } from './store-media-registry.mjs'
import { applyMigration } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER } from './store-session.mjs'
import { servedV2Files } from './private-read-model.fixture.mjs'
import { authorizedHeaders, captureMiddleware, editorPrefix, moduleOf, requestTo, tempPrivateRoot, treeDigest } from './store-mode.fixture.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

export const NOW = '2026-10-16T00:00:00.000Z'
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const exists = (file) => stat(file).then(() => true, (error) => { if (error?.code === 'ENOENT') return false; throw error })
export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * A migrated synthetic library served by the plugin. Helpers: `reading()` (the virtual module: revision and V2 files),
 * `write(route, input, base, id?, method?)` (a store write with the protocol headers), `post(route, input)` (a
 * request without them: media tasks), `upload(bytes, { fileName, … })`, `registry()` (a separate read-only
 * connection: the registry, the media entities and check()), `assetAt(portable)` (the asset of the record the present
 * source at a path names), `hide(ids, base)`, `dataDigest()` (the tree without operations/), `generated(sha256)`.
 */
export async function servedLibrary(t, prefix) {
  const context = await tempPrivateRoot(t, prefix)
  const { root, paths, closeAfter } = context
  const inbox = await importedV2Library(paths, { now: NOW })
  assert.equal((await applyMigration(paths, { now: NOW })).revision, 1)
  // The plugin resolves paths and proxies from the environment when it is first imported: only this root, no real values.
  const originalEnvironment = process.env
  process.env = { STARMAP_PRIVATE_ROOT: root }
  let travelAtlasLocalEditor
  try { ({ travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')) } finally { process.env = originalEnvironment }
  const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
  // Closed before the temporary root is removed (Windows cannot delete an open store).
  closeAfter({ close: () => plugin.buildEnd() })
  const handler = captureMiddleware(plugin).handlers[1]
  let sequence = 0
  const nextId = () => `01960000-0000-7000-8000-${(sequence += 1).toString(16).padStart(12, '0')}`
  const library = {
    ...context, inbox, plugin, handler, nextId,
    async reading() {
      const module = await moduleOf(plugin)
      return { revision: module.privateStoreRevision, files: servedV2Files(module) }
    },
    write: (route, input, base, id = nextId(), method = 'POST') => requestTo(handler, {
      url: editorPrefix + route, method, content: Buffer.from(JSON.stringify(input)),
      headers: { ...authorizedHeaders, [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) },
    }),
    post: (route, input, method = 'POST') => requestTo(handler, { url: editorPrefix + route, method, content: Buffer.from(JSON.stringify(input)) }),
    upload: (content, { fileName, countryId = PLACE.synthland, cityId = PLACE.harbor }) => requestTo(handler, {
      url: `${editorPrefix}upload?${new URLSearchParams({ countryId, cityId, fileName })}`, content,
      headers: { ...authorizedHeaders, 'content-length': String(content.length) },
    }),
    async registry() {
      const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
      try { return { ...handle.mediaRegistry(), entities: handle.mediaEntities(), problems: handle.check().problems } } finally { await handle.close() }
    },
    async assetAt(portable) {
      const { sources, entities } = await library.registry()
      const atPath = sources.filter((item) => item.pathKey === pathKeyOf(portable))
      const source = atPath.find((item) => item.state === 'present') ?? atPath.at(-1)
      return entities.find((entity) => entity.id === source?.recordId)?.fields.asset
    },
    async hide(ids, base) {
      const { body } = await requestTo(handler, { url: `${editorPrefix}state`, method: 'GET', headers: {} })
      const hidden = await library.write('state', { ...body.state, hiddenMediaIds: [...body.state.hiddenMediaIds, ...ids] }, base, undefined, 'PUT')
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body))
      return hidden.body.revision
    },
    async dataDigest() {
      return Object.fromEntries(Object.entries(await treeDigest(root)).filter(([file]) => !file.startsWith('operations/')))
    },
    generated: (sha256) => path.join(root, ...directoryOf(sha256).split('/')),
  }
  return library
}
