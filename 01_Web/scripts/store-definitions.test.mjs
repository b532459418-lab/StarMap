/**
 * The official definitions version (3C-5 G): store format 4 records it (`store_definitions`), a store opens only at the
 * code's version (older: E_STORE_UPGRADE_REQUIRED, newer: E_STORE_TOO_NEW), and `npm run store:upgrade` brings the
 * format and the definitions up in one transaction under the library lease, compatibly or not at all. Temporary private
 * roots with the neutral 3C-1b edge fixture; a store of an older version is made from a current one
 * (./store-mode.fixture.mjs downgradeStoreToFormat3, setStoreDefinitionsVersion), and newer code is played by the
 * `definitionsVersion` and `definitions` options.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { STORE_FORMAT_VERSION, checkStoreFile, createStore, openStore, withoutLibraryLock } from './store-host.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { runStoreUpgradeCli, upgradeStore } from './store-upgrade.mjs'
import { downgradeStoreToFormat1, downgradeStoreToFormat3, edgeV2Files, quietly, setStoreDefinitionsVersion, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { officialDefinitionSyncCommands } from '../src/data/store/definitionUpgrades.ts'
import { OFFICIAL_DEFINITION_HISTORY } from '../src/data/store/officialDefinitionHistory.fixture.ts'
import { OFFICIAL, OFFICIAL_DEFINITIONS, OFFICIAL_DEFINITIONS_VERSION, OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { projectStoreToCanonical } from '../src/data/store/projectCanonical.ts'

const NOW = '2026-10-29T00:00:00.000Z'
const id = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`
const bytesOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const CODE = OFFICIAL_DEFINITIONS_VERSION
const FIRST = OFFICIAL_DEFINITION_HISTORY[1]

/** A newer code's definitions: the current ones with a new optional media field and a new layer (a 3C-6 template). */
const newerDefinitions = () => {
  const definitions = structuredClone(OFFICIAL_DEFINITIONS)
  const media = definitions.entityTypes.find((row) => row.id === OFFICIAL.media)
  media.fields = [...media.fields, { key: 'testNote', kind: 'text' }]
  definitions.layers = [...definitions.layers, {
    id: 'starmap:test-template', revision: 0, title: { names: { en: 'Synthetic template' } }, schemaVersion: 1, acceptedEntityTypes: [OFFICIAL.place], entryFields: [{ key: 'note', kind: 'text' }],
  }]
  return definitions
}

async function migratedStore(t) {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-store-definitions-')
  await writeV2Files(paths, edgeV2Files())
  await applyMigration(paths, { now: NOW })
  return { root, paths, file: storeFileOf(paths) }
}
const readState = async (file, options = {}) => {
  const handle = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY, ...options })
  try { return handle.readFormalState() } finally { await handle.close() }
}
const metaOf = async (file, options = {}) => {
  const handle = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY, ...options })
  try { return { diagnostic: handle.diagnostic, meta: handle.diagnostic ? undefined : handle.meta() } } finally { await handle.close() }
}
const canonicalOf = (state) => projectStoreToCanonical(state, { source: 'local' }).canonical
/** The content of a definition row (everything but its revision). */
const content = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'revision'))
/** The store's rows of the official definitions (by the ids `definitions` has), without revisions. */
const definitionContent = (state, definitions = OFFICIAL_DEFINITIONS) => Object.fromEntries(['sources', 'entityTypes', 'relationTypes', 'layers']
  .map((table) => [table, definitions[table].map((own) => state[table].find((row) => row.id === own.id)).filter(Boolean).map(content)]))
const codeContent = (definitions) => Object.fromEntries(['sources', 'entityTypes', 'relationTypes', 'layers'].map((table) => [table, definitions[table].map(content)]))
/** Rows other than the official definitions, as they are. */
const otherRows = (state) => ({ ...state, sources: state.sources.filter((row) => !OFFICIAL_DEFINITIONS.sources.some((own) => own.id === row.id)), entityTypes: [], relationTypes: [], layers: [], revision: 0 })

test('U1 a store of format 3 (definitions version 1) opens with E_STORE_UPGRADE_REQUIRED and is upgraded to format 4 and the code\'s definitions in one transaction', async (t) => {
  const { paths, file } = await migratedStore(t)
  downgradeStoreToFormat3(file, FIRST)
  const refused = await metaOf(file)
  assert.deepEqual(refused.diagnostic, { code: 'E_STORE_UPGRADE_REQUIRED', detail: { version: 3 } })
  // The rows as a format-3 store has them (the host's older-format check reads them and writes nothing).
  const older = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
  assert.deepEqual([older.ok, older.upgradeRequired], [true, true])
  const expected = officialDefinitionSyncCommands(projectFree(file))
  const { result, check, lines } = await upgradeStore(paths, { requestId: id(1), now: () => NOW })
  const after = await readState(file)
  assert.deepEqual([result.upgraded, result.fromVersion, result.toVersion, result.fromDefinitions, result.toDefinitions], [true, 3, STORE_FORMAT_VERSION, 1, CODE])
  assert.equal(result.revision, result.fromRevision + (expected.length ? 1 : 0), 'one request: the revision moves on only when a definition row changes')
  assert.equal(check.ok, true)
  assert.match(lines.join('\n'), new RegExp(`从存储格式 3 升级到 ${STORE_FORMAT_VERSION}，官方定义版本 1 → ${CODE}`))
  assert.deepEqual(definitionContent(after), codeContent(OFFICIAL_DEFINITIONS), 'the official definition rows are the code\'s')
  assert.deepEqual((await metaOf(file)).meta.definitionsVersion, CODE)
  assert.equal((await metaOf(file)).meta.formatVersion, STORE_FORMAT_VERSION)
})

test('U1 the upgrade changes only the definition rows: every other row, the official view and its derived baseline stay', async (t) => {
  const { paths, file } = await migratedStore(t)
  const current = await readState(file)
  downgradeStoreToFormat3(file, FIRST)
  await upgradeStore(paths, { requestId: id(2), now: () => NOW })
  const after = await readState(file)
  assert.deepEqual(otherRows(after), otherRows(current))
  assert.deepEqual(canonicalOf(after), canonicalOf(current))
})

test('U2 stores of format 1 and 2 go to format 4 and the code\'s definitions in the same transaction', async (t) => {
  const { paths, file } = await migratedStore(t)
  downgradeStoreToFormat1(file)
  const { result } = await upgradeStore(paths, { requestId: id(3), now: () => NOW })
  assert.deepEqual([result.fromVersion, result.toVersion, result.fromDefinitions, result.toDefinitions], [1, STORE_FORMAT_VERSION, 1, CODE])
  assert.deepEqual([(await metaOf(file)).meta.formatVersion, (await metaOf(file)).meta.definitionsVersion], [STORE_FORMAT_VERSION, CODE])
  // Format 2 (store_definitions gone, user_version 2).
  const db = rawConnection(file)
  try { db.exec('DROP TABLE store_definitions'); db.exec('PRAGMA user_version = 2'); db.exec('UPDATE store_meta SET format_version = 2') } finally { db.close() }
  const second = await upgradeStore(paths, { requestId: id(4), now: () => NOW })
  assert.deepEqual([second.result.fromVersion, second.result.fromDefinitions, second.result.toDefinitions], [2, 1, CODE])
  assert.equal((await metaOf(file)).meta.definitionsVersion, CODE)
})

test('U3 running the upgrade again changes nothing; U7 a store whose definitions are older opens with E_STORE_UPGRADE_REQUIRED and gets only the definitions', async (t) => {
  const { paths, file } = await migratedStore(t)
  const bytes = bytesOf(file)
  const again = await upgradeStore(paths, { requestId: id(5) })
  assert.deepEqual([again.result.upgraded, again.check], [false, undefined])
  assert.match(again.lines.join('\n'), /没有改动/)
  assert.equal(bytesOf(file), bytes)
  // Newer code (one version up, a new optional field and a new layer): this store is older than it.
  const newer = { definitionsVersion: CODE + 1 }
  assert.deepEqual((await metaOf(file, newer)).diagnostic, { code: 'E_STORE_UPGRADE_REQUIRED', detail: { definitions: CODE } })
  const writer = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY, ...newer })
  assert.equal(writer.diagnostic.code, 'E_STORE_UPGRADE_REQUIRED')
  await writer.close()
  const recovered = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
  assert.equal(recovered.ok, true)
  const before = await readState(file)
  const upgraded = await upgradeStore(paths, { requestId: id(6), now: () => NOW, ...newer, definitions: newerDefinitions() })
  assert.deepEqual([upgraded.result.fromVersion, upgraded.result.toVersion, upgraded.result.fromDefinitions, upgraded.result.toDefinitions], [STORE_FORMAT_VERSION, STORE_FORMAT_VERSION, CODE, CODE + 1])
  assert.equal(upgraded.result.revision, before.revision + 1, 'one request: the changed media type and the new layer')
  assert.match(upgraded.lines.join('\n'), /更新或新增了 2 条定义/)
  const after = await readState(file, newer)
  assert.deepEqual(definitionContent(after, newerDefinitions()), codeContent(newerDefinitions()))
  assert.equal(after.entityTypes.find((row) => row.id === OFFICIAL.media).revision, before.entityTypes.find((row) => row.id === OFFICIAL.media).revision + 1)
  assert.equal(after.layers.find((row) => row.id === 'starmap:test-template').revision, 0)
  assert.equal((await metaOf(file, newer)).diagnostic, undefined)
  // U6 for this store: the current code is older than it now.
  assert.deepEqual((await metaOf(file)).diagnostic, { code: 'E_STORE_TOO_NEW', detail: { definitions: CODE + 1 } })
})

test('U4 a definition the planner refuses inside the transaction, and U5 an incompatible definition, leave the store byte for byte as it was', async (t) => {
  const { paths, file } = await migratedStore(t)
  downgradeStoreToFormat3(file, FIRST)
  const bytes = bytesOf(file)
  // U4: a new layer that names an entity type the store does not have: the planner refuses it in the transaction.
  const refused = structuredClone(OFFICIAL_DEFINITIONS)
  refused.layers = [...refused.layers, { id: 'starmap:test-broken', revision: 0, title: { names: { en: 'Broken' } }, schemaVersion: 1, acceptedEntityTypes: ['starmap:missing-type'], entryFields: [] }]
  await assert.rejects(upgradeStore(paths, { requestId: id(7), now: () => NOW, definitions: refused }), { code: 'E_REFERENCE', outcome: 'not_committed' })
  assert.equal(bytesOf(file), bytes, 'nothing changed: format 3, definitions version 1')
  // U5: the media type's optional field made required, and a field removed: refused before the transaction.
  for (const change of [
    (definitions) => { definitions.entityTypes.find((row) => row.id === OFFICIAL.place).fields.find((field) => field.key === 'iso3166Alpha2').required = true },
    (definitions) => { const media = definitions.entityTypes.find((row) => row.id === OFFICIAL.media); media.fields = media.fields.filter((field) => field.key !== 'asset') },
  ]) {
    const incompatible = structuredClone(OFFICIAL_DEFINITIONS)
    change(incompatible)
    await assert.rejects(upgradeStore(paths, { requestId: id(8), now: () => NOW, definitions: incompatible }), { code: 'E_SCHEMA_CHANGE' })
    assert.throws(() => officialDefinitionSyncCommands(projectFree(file), incompatible), { code: 'E_SCHEMA_CHANGE' })
    assert.equal(bytesOf(file), bytes)
  }
  const cli = quietly()
  assert.equal(await runStoreUpgradeCli([], { privatePaths: paths, ...cli }), 0, 'the real definitions still upgrade')
})

/** The rows of a store of any format, read raw (no open checks). */
function projectFree(file) {
  const db = rawConnection(file, { readOnly: true })
  try {
    const rows = (table) => db.prepare(`SELECT id, revision, body FROM ${table}`).all().map((row) => ({ id: row.id, revision: row.revision, ...JSON.parse(row.body) }))
    return { sources: rows('sources'), entityTypes: rows('entity_types'), relationTypes: rows('relation_types'), layers: rows('layers').map((row) => ({ ...row, ...(row.id === OFFICIAL.travel ? { systemKey: 'travel' } : row.id === OFFICIAL.wantToGo ? { systemKey: 'want_to_go' } : {}) })) }
  } finally { db.close() }
}

test('U6 code older than the store\'s definitions: open, read-only open, the upgrade and the command line all refuse with E_STORE_TOO_NEW', async (t) => {
  const { paths, file } = await migratedStore(t)
  setStoreDefinitionsVersion(file, CODE + 1)
  const bytes = bytesOf(file)
  assert.deepEqual((await metaOf(file)).diagnostic, { code: 'E_STORE_TOO_NEW', detail: { definitions: CODE + 1 } })
  const writer = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY })
  assert.equal(writer.diagnostic.code, 'E_STORE_TOO_NEW')
  assert.throws(() => writer.meta(), { code: 'E_STORE_TOO_NEW' })
  await writer.close()
  await assert.rejects(upgradeStore(paths, { requestId: id(9) }), { code: 'E_STORE_TOO_NEW' })
  const cli = quietly()
  assert.equal(await runStoreUpgradeCli([], { privatePaths: paths, ...cli }), 1)
  assert.match(cli.lines.join('\n'), /E_STORE_TOO_NEW/)
  const { runStoreMediaCli } = await import('./store-media-cli.mjs')
  const media = quietly()
  assert.equal(await runStoreMediaCli({ privatePaths: paths, argv: [], ...media }), 1)
  assert.match(media.lines.join('\n'), /E_STORE_TOO_NEW/)
  assert.equal(bytesOf(file), bytes)
})

test('U8 a new store is created at format 4 with the code\'s definitions version', async (t) => {
  const { paths, file } = await migratedStore(t)
  assert.deepEqual([(await metaOf(file)).meta.formatVersion, (await metaOf(file)).meta.definitionsVersion], [STORE_FORMAT_VERSION, CODE])
  assert.deepEqual(definitionContent(await readState(file)), codeContent(OFFICIAL_DEFINITIONS))
  const empty = path.join(path.dirname(file), 'empty.sqlite')
  const handle = await createStore(empty, { libraryId: id(100), lock: withoutLibraryLock, now: () => NOW, definitionsVersion: CODE })
  try { assert.deepEqual([handle.meta().formatVersion, handle.meta().definitionsVersion], [STORE_FORMAT_VERSION, CODE]) } finally { await handle.close() }
  void paths
})

test('U9 restoring a backup of a format-3 store upgrades it to format 4 and the code\'s definitions', async (t) => {
  const { paths, root, file } = await migratedStore(t)
  const canonical = canonicalOf(await readState(file))
  const { BACKUP_FILES, backupStore, restoreStore } = await import('./store-backup.mjs')
  const out = path.join(path.dirname(root), 'backup')
  await backupStore(paths, { out, now: NOW, backupId: '019a0000-0000-7000-8000-00000000e030' })
  const snapshot = path.join(out, BACKUP_FILES.store)
  downgradeStoreToFormat3(snapshot, FIRST)
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const manifestFile = path.join(out, BACKUP_FILES.manifest)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const snapshotBytes = await readFile(snapshot)
  manifest.files[BACKUP_FILES.store] = { bytes: snapshotBytes.length, sha256: sha256(snapshotBytes) }
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const complete = JSON.parse(await readFile(path.join(out, BACKUP_FILES.complete), 'utf8'))
  await writeFile(path.join(out, BACKUP_FILES.complete), `${JSON.stringify({ ...complete, manifestSha256: sha256(await readFile(manifestFile)) }, null, 2)}\n`)
  const to = path.join(path.dirname(root), 'restored')
  await restoreStore({ from: out, to, now: '2026-10-30T00:00:00.000Z' })
  const restored = path.join(to, 'data', 'store', 'world.sqlite')
  const { meta } = await metaOf(restored)
  assert.deepEqual([meta.formatVersion, meta.definitionsVersion], [STORE_FORMAT_VERSION, CODE])
  assert.deepEqual(canonicalOf(await readState(restored)), canonical)
})
