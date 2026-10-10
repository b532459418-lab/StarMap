/** Pure, narrow Bridge-compatible App projection of a fully validated Saved.
 * No App loader, IO, identity allocation, host/session or permission authority.
 * The returned provenance is consistency evidence, not proof of read freshness.
 */
import { freezeCopy, jsonKey, shape, STORE_TABLES, utcTimestamp } from '../src/worldgraph/store/schema.ts'
import { bridgeV2, BRIDGE } from '../src/data/canonical/storeBridge.ts'
import { restoreBridgeV2, projectBridgeCompatibility, projectBridgeOriginalRoutes } from '../src/data/canonical/storeBridgeProjection.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { types } from 'node:util'
import { baselineExportNames } from '../src/data/derive/baseline.ts'
import { orderBySavedIds } from '../src/data/derive/editorState.ts'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { checkRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { withRepositoryMergeSavedValidation, readRepositoryMergeSavedArchive } from './world-store-branch-merge-store-contract.mjs'

const FORMAT = 'starmap.repository-merge-app-projection'
const fail = code => { throw new RepositoryError(code) }
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0

const helperPaths = new Map(Object.entries(baselineExportNames).flatMap(([module, names]) =>
  names.evaluated.map(name => [`$.app.${module}.${name}`, { kind: 'helper-evaluation-reference',
    evaluatedIn: `baseline.modules.${module}.${name}`, callable: false }])))
helperPaths.set('$.app.editorState.orderBySavedIds', { kind: 'static-helper-reference',
  module: 'src/data/derive/editorState.ts', export: 'orderBySavedIds', callable: false })
const mapPaths = new Set(['$.app.wantToGo.wantToGoItemById', '$.app.wantToGo.plannedRecordById'])

/** AppData has pure closures, two lookup Maps and optional undefined fields.
 * Export a declared data DTO, never executable code or silently empty Maps.
 * Build under bounded node/depth/escaped-byte limits before shared ctx.measure;
 * only trusted derived output uses these rules. Saved preflight stays strict.
 */
function derivedDto(input, ctx) {
  let nodes = 0, bytes = 0
  const active = new Set(), limits = ctx.limits
  const charge = n => { if ((bytes += n) > limits.maxBytes) fail('E_APP_PROJECTION_DERIVED_BUDGET') }
  function string(value) {
    charge(2)
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i)
      if ([34, 92, 8, 9, 10, 12, 13].includes(c)) charge(2)
      else if (c < 32) charge(6)
      else if (c < 128) charge(1)
      else if (c < 2048) charge(2)
      else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { charge(4); i++ }
      else charge(c >= 0xd800 && c <= 0xdfff ? 6 : 3)
    }
  }
  function copy(value, location, depth) {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) fail('E_APP_PROJECTION_DERIVED_BUDGET')
    if (typeof value === 'function') {
      const declared = helperPaths.get(location)
      if (!declared || location === '$.app.editorState.orderBySavedIds' && value !== orderBySavedIds) fail('E_APP_PROJECTION_DERIVED_SHAPE')
      return copy(declared, location + '.declaration', depth + 1)
    }
    if (typeof value === 'string') { string(value); return value }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      charge(Buffer.byteLength(JSON.stringify(value))); return value
    }
    if (!value || typeof value !== 'object' || types.isProxy(value)) fail('E_APP_PROJECTION_DERIVED_SHAPE')
    if (active.has(value)) fail('E_APP_PROJECTION_DERIVED_SHAPE')
    active.add(value)
    try {
      if (Object.getPrototypeOf(value) === Map.prototype) {
        if (!mapPaths.has(location) || Reflect.ownKeys(value).length || value.size > (limits.maxNodes - nodes) / 3) fail('E_APP_PROJECTION_DERIVED_SHAPE')
        return copy({ kind: 'map-entries', entries: [...Map.prototype.entries.call(value)] }, location + '.mapData', depth + 1)
      }
      const array = Array.isArray(value), proto = Object.getPrototypeOf(value)
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('E_APP_PROJECTION_DERIVED_SHAPE')
      const keys = Reflect.ownKeys(value), length = array ? Object.getOwnPropertyDescriptor(value, 'length').value : keys.length
      if (array && keys.length !== length + 1 || length > limits.maxNodes - nodes) fail('E_APP_PROJECTION_DERIVED_BUDGET')
      charge(2 + Math.max(0, length - 1))
      const result = array ? [] : {}
      for (let i = 0; i < length; i++) {
        const key = array ? String(i) : keys[i], descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('E_APP_PROJECTION_DERIVED_SHAPE')
        if (descriptor.value === undefined && !array) continue // Declared derived optional-object rule.
        if (!array) { string(key); charge(1) }
        Object.defineProperty(result, key, { value: copy(descriptor.value, location + '.' + key, depth + 1),
          enumerable: true, writable: true, configurable: true })
      }
      return result
    } finally { active.delete(value) }
  }
  return copy(input, '$', 0)
}

function checkedAppDto(compatibility, ctx) {
  shape(compatibility.app, Object.keys(baselineExportNames))
  for (const [module, names] of Object.entries(baselineExportNames)) {
    const keys = [...names.data, ...names.evaluated, ...(module === 'editorState' ? ['orderBySavedIds'] : [])]
    shape(compatibility.app[module], keys)
    for (const name of [...names.evaluated, ...(module === 'editorState' ? ['orderBySavedIds'] : [])]) {
      if (typeof compatibility.app[module][name] !== 'function') fail('E_APP_PROJECTION_DERIVED_SHAPE')
    }
  }
  for (const name of ['wantToGoItemById', 'plannedRecordById']) {
    if (Object.getPrototypeOf(compatibility.app.wantToGo[name]) !== Map.prototype) fail('E_APP_PROJECTION_DERIVED_SHAPE')
  }
  return ctx.measure(derivedDto(compatibility, ctx))
}

/** Table rows are keyed facts, not the order of a V2 source document. Keep
 * nested ordering (metadata, sequences and view states) exactly unchanged.
 * Revisions/clocks are retained separately, never reset in the actual Saved.
 */
function representedContent(world) {
  return { format: world.format, formatVersion: world.formatVersion,
    ...Object.fromEntries(STORE_TABLES.map(table => [table, world[table].map(row => {
      const ignored = table === 'entries' ? ['revision', 'createdAt', 'updatedAt'] : ['revision']
      return Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.includes(key)))
    }).sort(compareId)])) }
}

/** A closed roundtrip profile accounts for every current WorldStore table.
 * The existing G2 projector alone does not prove that unknown native facts,
 * definitions, reviews, anchors, relations or view states are represented.
 */
function bridgeProfile(state, now, ctx) {
  const world = state.world
  if (!world.sources.some(row => row.id === BRIDGE.metadata)) fail('E_APP_PROJECTION_PROFILE')
  const document = ctx.measure({ format: 'starmap.v2-readonly-bridge', version: 1,
    store: world, manifest: state.identities })
  const files = ctx.measure(restoreBridgeV2(document))
  const rebuilt = ctx.measure(bridgeV2(files, { now, manifest: state.identities,
    allocateId: () => fail('E_APP_PROJECTION_ALLOCATION') }))
  if (jsonKey(rebuilt.manifest) !== jsonKey(state.identities)) fail('E_APP_PROJECTION_PROFILE')
  const actualContent = ctx.measure(representedContent(world))
  const expectedContent = ctx.measure(representedContent(rebuilt.store))
  if (jsonKey(actualContent) !== jsonKey(expectedContent)) fail('E_APP_PROJECTION_PROFILE')
  // Canonical table ordering comes from the preserved source ledger. A keyed
  // table's incidental array order must not reorder original route output.
  return { document: rebuilt }
}

/** No untrusted validation token or caller-declared manifest is accepted.
 * Tightened budgets cover full Saved replay and each derived representation.
 */
export function projectRepositoryMergeSavedApp(value, options) {
  checkRepositoryMergeArchiveInputs([options])
  shape(options, ['now', 'policy', 'limits'], ['now'])
  utcTimestamp(options.now, '$.now')
  const policy = options.policy ?? {}, limits = options.limits ?? {}, now = options.now
  return withRepositoryMergeSavedValidation([value, options, policy], limits, undefined, ctx => {
    const saved = readRepositoryMergeSavedArchive(value, policy, ctx.limits, ctx)
    const projection = saved.projection, state = projection.state
    const { document } = bridgeProfile(state, now, ctx)
    const compatibility = checkedAppDto(projectBridgeCompatibility(document, now), ctx)
    const originalRoutes = ctx.measure(projectBridgeOriginalRoutes(document))
    if (jsonKey(originalRoutes) !== jsonKey(compatibility.timeContext.originalRoutes)) fail('E_APP_PROJECTION_ROUTES')
    const repositoryMetadata = ctx.measure({ repositoryRevision: state.revision, worldRevision: state.world.revision,
      identities: state.identities, proposals: state.proposals, retired: state.retired,
      rowRevisions: Object.fromEntries(STORE_TABLES.map(table => [table, state.world[table].map(row => ({ id: row.id, revision: row.revision }))])),
      entryClocks: state.world.entries.map(row => ({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt })) })
    const raw = ctx.measure({ format: FORMAT, formatVersion: 1, savedDigest: saved.savedDigest,
      stateDigest: digest(state), projectionDigest: digest(projection), policyDigest: digest(policy),
      identity: saved.baseArchive.descriptor.identity, now,
      coverage: { profile: 'bridge-v2-compatible', tables: STORE_TABLES,
        representedContentDigest: digest(representedContent(state.world)), repositoryMetadataPreserved: true },
      dataRepresentation: { format: 'starmap.app-data-dto', formatVersion: 1, callable: false,
        helpers: 'declared-baseline-evaluation-references', maps: 'ordered-tagged-entries', undefinedObjectFields: 'omitted' },
      ...compatibility, originalRoutes, repositoryMetadata,
      readOnly: true, appActivated: false, executable: false, persisted: false, commands: [],
      foreignReceiptsBecomeLocal: false, newLocalApprovalIssued: false })
    const result = ctx.measure({ ...raw, projectionEnvelopeDigest: digest(raw) })
    return freezeCopy(result)
  })
}
