/** Portable exchange for the formal store. All file IO stays in this host. */
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { sha256File } from './file-hash.mjs'
import { isMediaBackupPath, portablePath } from './library-backup.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { privateDataState, storeFileOf } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { isInsideRepository } from './private-output.mjs'
import { createExclusive, newOutput, openReadOnly, requireStoreMode, writeJsonExclusive } from './store-backup.mjs'
import { createStore, openStore } from './store-host.mjs'
import { emptyLibraryCommands } from './store-init.mjs'
import { assetSourcesOf, directoryOf, pathKeyOf, validMediaBlock } from './store-media-registry.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { PUBLIC_EXTENSION_KEYS, PUBLIC_ASSET_ATTRIBUTES_REMOVED } from '../src/data/store/publicReadModel.ts'
import { emptyFormalState, FORMAL_TABLES, readFormalState } from '../src/worldgraph/store/formal.ts'
import { EXCHANGE_FORMAT, EXCHANGE_VERSION, planExchange, selectExchangeGraph } from '../src/worldgraph/store/exchange.ts'
import { jsonKey, opaqueId, reject, shape } from '../src/worldgraph/store/primitives.ts'
import { applyChangeSet, planCommands } from '../src/worldgraph/store/planner.ts'
import { memoryReader } from '../src/worldgraph/store/reader.ts'

const MANIFEST = 'exchange.json'
const MEDIA_PREFIX = 'media/user/'
const CONTENT_DIRECTORY = /^media\/user\/[a-f0-9]{16}\//
const SHA256 = /^[a-f0-9]{64}$/
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024

function readScope(scope) {
  if (scope?.kind === 'library') {
    shape(scope, ['kind'])
    return scope
  }
  shape(scope, ['kind', 'layerIds', 'entryIds'])
  if (scope.kind !== 'selection') reject('E_EXCHANGE_SCOPE', 'scope.kind')
  for (const key of ['layerIds', 'entryIds']) {
    const ids = scope[key]
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) reject('E_EXCHANGE_SCOPE', key)
    for (const id of ids) opaqueId(id, key)
  }
  return scope
}

/** A recipient's selected copy starts private. Keep only display extensions
 * belonging to the selected facts. Definition and provenance IDs stay stable. */
function shareGraph(graph) {
  const result = { ...graph }
  for (const table of ['entities', 'entries', 'anchors', 'assets', 'evidence', 'reviews']) {
    result[table] = graph[table].map(({ extensions, ...row }) => {
      const allowed = PUBLIC_EXTENSION_KEYS[table] ?? []
      const v2 = Object.fromEntries(Object.entries(extensions?.v2 ?? {}).filter(([key]) => allowed.includes(key)))
      if (Object.keys(v2).length) row.extensions = { v2 }
      if (table === 'entities' || table === 'anchors') row.visibility = 'private'
      if (table === 'assets') {
        row.attributes = Object.fromEntries(Object.entries(row.attributes).filter(([key]) => !PUBLIC_ASSET_ATTRIBUTES_REMOVED.includes(key)))
      }
      return row
    })
  }
  return result
}

function mediaPath(relative) {
  portablePath(relative)
  if (!relative.startsWith(MEDIA_PREFIX) || !isMediaBackupPath(relative)) reject('E_EXCHANGE_MEDIA_PATH', 'media')
  return relative
}

function referencesAndRegistry(graph, registeredFiles, links) {
  const assets = new Map(graph.assets.map(asset => [asset.id, asset]))
  const registryFiles = new Map(registeredFiles.map(file => [file.sha256, file]))
  const registryLinks = new Map(links.map(link => [link.assetId, link.sha256]))
  if (registryFiles.size !== registeredFiles.length || registryLinks.size !== links.length) reject('E_EXCHANGE_MEDIA', 'media.registry')
  const required = new Set()
  const used = new Set()
  for (const asset of assets.values()) {
    const local = assetSourcesOf(asset.attributes).filter(src => src.startsWith('/' + MEDIA_PREFIX)).map(src => mediaPath(src.slice(1)))
    for (const file of local) required.add(file)
    const sha256 = registryLinks.get(asset.id)
    if (sha256 === undefined) {
      if (local.some(file => CONTENT_DIRECTORY.test(file))) reject('E_EXCHANGE_MEDIA', 'assets.' + asset.id)
      continue
    }
    const file = registryFiles.get(sha256)
    if (!file || !local.length) reject('E_EXCHANGE_MEDIA', 'assets.' + asset.id)
    const outputs = new Set(file.outputs.map(output => mediaPath(directoryOf(sha256) + '/' + output.name)))
    if (local.some(relative => !outputs.has(relative))) reject('E_EXCHANGE_MEDIA', 'assets.' + asset.id)
    for (const relative of outputs) required.add(relative)
    used.add(sha256)
  }
  if (used.size !== registryFiles.size || links.some(link => !assets.has(link.assetId))) reject('E_EXCHANGE_MEDIA', 'media.registry')
  return required
}

function readPackage(value) {
  shape(value, ['format', 'version', 'scope', 'graph', 'media'])
  if (value.format !== EXCHANGE_FORMAT || value.version !== EXCHANGE_VERSION) reject('E_EXCHANGE_VERSION', 'version')
  const scope = readScope(value.scope)
  const graph = readFormalState(value.graph, OFFICIAL_POLICY)
  if (scope.kind === 'selection') {
    const selected = shareGraph(selectExchangeGraph(graph, scope))
    for (const table of FORMAL_TABLES) {
      if (graph[table].length !== selected[table].length || jsonKey(graph[table]) !== jsonKey(selected[table])) reject('E_EXCHANGE_SELECTION', table)
    }
    if (graph.revision !== 0 || graph.tombstones.length) reject('E_EXCHANGE_SELECTION', 'graph')
  }
  const media = value.media
  shape(media, ['files', 'registrations', 'links'])
  for (const key of ['files', 'registrations', 'links']) if (!Array.isArray(media[key])) reject('E_EXCHANGE_MEDIA', 'media.' + key)
  for (const file of media.registrations) shape(file, ['sha256', 'extension', 'bytes', 'outputs'])
  for (const link of media.links) shape(link, ['assetId', 'sha256'])
  const block = validMediaBlock({
    files: media.registrations.map(file => ({ ...file, op: 'put' })),
    assetFiles: media.links.map(link => ({ ...link, op: 'put' })),
  })
  const expected = referencesAndRegistry(graph, block.files, block.assetFiles)
  const paths = new Set()
  const inventory = new Map()
  for (const file of media.files) {
    shape(file, ['path', 'bytes', 'sha256'])
    const relative = mediaPath(file.path)
    const key = pathKeyOf(relative)
    if (paths.has(key) || !expected.delete(relative) || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0) reject('E_EXCHANGE_MEDIA', 'media.files')
    paths.add(key)
    inventory.set(relative, file)
  }
  if (expected.size) reject('E_EXCHANGE_MEDIA', 'media.files')
  for (const file of block.files) {
    for (const output of file.outputs) {
      const item = inventory.get(directoryOf(file.sha256) + '/' + output.name)
      if (item.sha256 !== output.sha256 || item.bytes !== output.bytes) reject('E_EXCHANGE_MEDIA', 'media.registrations')
    }
  }
  return { graph, scope, files: media.files, block }
}

async function ordinaryPath(root, relative, { directory = false, create = false, created = [] } = {}) {
  const parts = portablePath(relative).split('/')
  let current = root
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) reject('E_EXCHANGE_PATH', 'root')
  for (const [index, name] of parts.entries()) {
    current = path.join(current, name)
    const wantDirectory = directory || index < parts.length - 1
    if (create && wantDirectory) {
      try { await mkdir(current); created.push(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const info = await lstat(current)
    if (info.isSymbolicLink() || (wantDirectory ? !info.isDirectory() : !info.isFile())) reject('E_EXCHANGE_PATH', relative)
  }
  return current
}

async function checkFile(target, file) {
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes ||
      await sha256File(target) !== file.sha256) reject('E_EXCHANGE_MEDIA_BYTES', file.path)
}

async function copyVerified(source, target, file, created) {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL)
    created.push(target)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    await checkFile(source, file)
  }
  await checkFile(target, file)
  if (created.at(-1) === target) {
    const handle = await open(target, 'r+')
    try { await handle.sync() } finally { await handle.close() }
  }
}

async function cleanup(files, directories) {
  for (const file of files) await unlink(file).catch(() => {})
  for (const directory of directories.reverse()) await rmdir(directory).catch(() => {})
}

const countsOf = graph => Object.fromEntries(FORMAL_TABLES.map(table => [table, graph[table].length]).filter(([, count]) => count))

export async function exportExchange(privatePaths, { out, scope = { kind: 'library' }, preview = false } = {}) {
  const target = preview ? undefined : newOutput(out, '--out <新目录>')
  readScope(scope)
  requireStoreMode(privatePaths)
  return withLibraryOperation(privatePaths, async () => {
    const handle = openReadOnly(storeFileOf(privatePaths))
    let full, registry
    try {
      full = handle.readFormalState()
      registry = handle.mediaRegistry()
    } finally { await handle.close() }
    const selected = selectExchangeGraph(full, scope)
    const graph = scope.kind === 'selection' ? shareGraph(selected) : selected
    const ids = new Set(graph.assets.map(asset => asset.id))
    const links = registry.assetFiles.filter(link => ids.has(link.assetId))
    const shas = new Set(links.map(link => link.sha256))
    const registrations = registry.files.filter(file => shas.has(file.sha256))
      .map(({ sha256, extension, bytes, outputs }) => ({ sha256, extension, bytes, outputs }))
    const required = referencesAndRegistry(graph, registrations, links)
    const registeredDirectories = new Set(registrations.map(file => directoryOf(file.sha256)))
    if (registry.pendingFileOps.some(op => op.kind === 'delete-generated' && registeredDirectories.has(op.target))) {
      reject('E_EXCHANGE_MEDIA_PENDING', 'media')
    }
    const files = []
    for (const relative of [...required].sort()) {
      const source = await ordinaryPath(privatePaths.root, relative)
      files.push({ path: relative, bytes: (await lstat(source)).size, sha256: await sha256File(source) })
    }
    const value = { format: EXCHANGE_FORMAT, version: EXCHANGE_VERSION, scope, graph, media: { files, registrations, links } }
    readPackage(value)
    if (!preview) {
      const created = [], directories = []
      await createExclusive(target)
      directories.push(target)
      try {
        for (const file of files) {
          const parent = await ordinaryPath(target, path.posix.dirname(file.path), { directory: true, create: true, created: directories })
          await copyVerified(path.join(privatePaths.root, file.path), path.join(parent, path.posix.basename(file.path)), file, created)
        }
        const manifest = path.join(target, MANIFEST)
        await writeJsonExclusive(manifest, value)
        if ((await lstat(manifest)).size > MAX_MANIFEST_BYTES) {
          created.push(manifest)
          reject('E_EXCHANGE_SIZE', MANIFEST)
        }
      } catch (error) {
        await cleanup(created, directories)
        throw error
      }
    }
    return { out: target, scope, counts: countsOf(graph), photosAndVariants: files.length,
      ...(preview && scope.kind === 'selection' ? { graph, files } : {}) }
  })
}

function targetState(privatePaths, now) {
  const { state } = privateDataState(privatePaths)
  if (state === 'store') {
    const handle = openReadOnly(storeFileOf(privatePaths))
    try { return { graph: handle.readFormalState(), registry: handle.mediaRegistry(), exists: true } }
    finally { void handle.close() }
  }
  if (state !== 'empty') reject('E_EXCHANGE_TARGET', state)
  const empty = emptyFormalState()
  const graph = applyChangeSet(empty, planCommands(memoryReader(empty), emptyLibraryCommands(), {
    baseRevision: 0, now, policy: OFFICIAL_POLICY,
  }))
  return { graph, exists: false }
}

export async function importExchange(privatePaths, { from, apply = false } = {}) {
  if (typeof from !== 'string' || !from.trim()) reject('E_ARGUMENT', '--from')
  const source = path.resolve(from)
  const file = await ordinaryPath(source, MANIFEST)
  if ((await lstat(file)).size > MAX_MANIFEST_BYTES) reject('E_EXCHANGE_SIZE', MANIFEST)
  const incoming = readPackage(JSON.parse(await readFile(file, 'utf8')))
  const run = async (leaseToken) => {
    const now = new Date().toISOString()
    const target = targetState(privatePaths, now)
    const pending = new Set(target.registry?.pendingFileOps.filter(op => op.kind === 'delete-generated').map(op => op.target))
    if (incoming.block.files.some(file => pending.has(directoryOf(file.sha256)))) reject('E_EXCHANGE_MEDIA_PENDING', 'media')
    const plan = planExchange(target.graph, incoming.graph, OFFICIAL_POLICY)
    const result = { scope: incoming.scope.kind, added: plan.upserts.length, unchanged: plan.unchanged,
      tombstones: plan.tombstones.length, photosAndVariants: incoming.files.length, revision: plan.nextRevision }
    const created = [], directories = []
    let handle
    let saved = false
    try {
      for (const file of incoming.files) {
        const original = await ordinaryPath(source, file.path)
        if (!apply) await checkFile(original, file)
        else {
          const parent = await ordinaryPath(privatePaths.root, path.posix.dirname(file.path), { directory: true, create: true, created: directories })
          await copyVerified(original, path.join(parent, path.posix.basename(file.path)), file, created)
        }
      }
      if (!apply) return { ...result, applied: false }
      const requestId = uuidv7()
      const exchange = { graph: incoming.graph, media: incoming.block, requestId, baseRevision: plan.baseRevision }
      const store = storeFileOf(privatePaths)
      if (target.exists) {
        handle = openStore(store, { privatePaths, policy: OFFICIAL_POLICY })
        if (handle.diagnostic) reject(handle.diagnostic.code, 'store')
        await handle.importExchange(exchange, { leaseToken })
      } else {
        await ordinaryPath(privatePaths.root, 'data/store', { directory: true, create: true, created: directories })
        handle = await createStore(store, {
          libraryId: uuidv7(), policy: OFFICIAL_POLICY, now: () => now,
          lock: callback => withLibraryOperation(privatePaths, callback, { leaseToken }),
          initial: { requestId: uuidv7(), actor: 'store:init', commands: emptyLibraryCommands() },
          exchange,
        })
      }
      saved = true
      return { ...result, applied: true }
    } catch (error) {
      if (!saved && error?.outcome !== 'unknown') await cleanup(created, directories)
      throw error
    } finally {
      await handle?.close()
    }
  }
  return apply ? withLibraryOperation(privatePaths, run) : run()
}

const USAGE = [
  'npm run store:export-exchange -- --root <私人根> --out <新目录>',
  'npm run store:export-exchange -- --root <私人根> --entry <ID> [--layer <ID>] --preview',
  'npm run store:import-exchange -- --root <目标私人根> --from <交换包目录> [--apply]',
].join('\n')

async function main(command, args) {
  const shared = { root: { type: 'string' } }
  const { values } = parseArgs({ args, options: command === 'export'
    ? { ...shared, out: { type: 'string' }, entry: { type: 'string', multiple: true },
      layer: { type: 'string', multiple: true }, preview: { type: 'boolean' } }
    : { ...shared, from: { type: 'string' }, apply: { type: 'boolean' } } })
  if (!values.root?.trim()) reject('E_ARGUMENT', '--root')
  const privatePaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.resolve(values.root) })
  if (isInsideRepository(privatePaths.root)) reject('E_EXCHANGE_PRIVATE_ROOT', '--root')
  const result = command === 'export'
    ? await exportExchange(privatePaths, {
      out: values.out, preview: values.preview,
      scope: values.entry || values.layer
        ? { kind: 'selection', entryIds: values.entry ?? [], layerIds: values.layer ?? [] }
        : { kind: 'library' },
    })
    : await importExchange(privatePaths, { from: values.from, apply: values.apply })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command !== 'export' && command !== 'import') reject('E_ARGUMENT', 'command')
    await main(command, args)
  } catch (error) {
    console.error(`${error.code ?? error.name}${error.path ? ' ' + error.path : ''}`)
    if (error.code === 'E_ARGUMENT' || error.code?.startsWith('ERR_PARSE_ARGS')) console.error(USAGE)
    process.exitCode = 1
  }
}
