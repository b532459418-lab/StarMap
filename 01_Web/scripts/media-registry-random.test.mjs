/**
 * Random Inbox changes against the scan rules (3C-4c, ./media-registry.mjs): a model library (Inbox files, registry
 * sources, live records) under seeded random steps: new files, copies, moves (across cities too), folder renames,
 * removals, replacements, files put back after a deletion, deletions in the App (with the file deletion done or
 * paused) and explicit uploads. After every step an import runs (its confirmations accepted or not, at random) and the
 * invariants are checked. Invented paths and contents; no file system.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyScan, registryDeltaOf, resolveClassification } from './media-registry.mjs'
import { pathKeyOf } from './store-media-registry.mjs'

/** Seeds and steps of the run (the report quotes them). */
export const SEEDS = Object.freeze(Array.from({ length: 20 }, (_, index) => 1000 + index))
export const STEPS = 300

/** mulberry32. */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CITIES = [
  { folder: 'MediaInbox/Synthland/Harbor Town', placeId: 'place-harbor' },
  { folder: 'MediaInbox/Synthland/Hill Town', placeId: 'place-hill' },
  { folder: 'MediaInbox/Second Land/River Town', placeId: 'place-river' },
]
const cityOf = (value) => CITIES.find((city) => value.startsWith(`${city.folder}`)) ?? CITIES[0]

function model(seed) {
  const next = random(seed)
  const pick = (items) => items[Math.floor(next() * items.length)]
  const state = { inbox: new Map(), sources: [], records: new Map(), files: new Set(), seq: 0, ids: 0, contents: 0, renames: 0 }
  const freshPath = (city = pick(CITIES)) => `${city.folder}${state.renames && next() < 0.3 ? ` ${state.renames}` : ''}/photos/f${++state.ids}.jpg`
  const freshContent = () => `C${++state.contents}`
  const factOf = (pathValue, sha256) => {
    const city = cityOf(pathValue)
    const parts = pathValue.split('/')
    return {
      path: pathValue, pathKey: pathKeyOf(pathValue), sha256, placeId: city.placeId, descriptionDigest: `d-${city.placeId}`, size: 1, mtimeMs: 1,
      countryFolder: parts.slice(0, 2).join('/'), cityFolder: parts.slice(0, 3).join('/'),
    }
  }
  const facts = () => [...state.inbox].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pathValue, sha256]) => factOf(pathValue, sha256))
  const records = () => [...state.records.values()]
  const registry = () => state.sources.map((source) => ({ ...source }))
  return { next, pick, state, freshPath, freshContent, facts, records, registry }
}

/** Apply a media block's source operations the way the host does (one present source per path). */
function applySources(state, operations, requestId) {
  for (const operation of operations) {
    if (operation.op === 'add') {
      state.sources.push({ seq: ++state.seq, path: operation.path, pathKey: pathKeyOf(operation.path), sha256: operation.sha256, recordId: operation.recordId,
        state: operation.state, descriptionDigest: operation.descriptionDigest, confirmedRequest: requestId })
    } else {
      const source = state.sources.find((row) => row.seq === operation.seq)
      assert.ok(source, 'an update names an existing source')
      if (operation.path !== undefined) { source.path = operation.path; source.pathKey = pathKeyOf(operation.path) }
      if (operation.state !== undefined) source.state = operation.state
    }
    const present = state.sources.filter((row) => row.state === 'present')
    assert.equal(new Set(present.map((row) => row.pathKey)).size, present.length, 'at most one present source per path, after every operation')
  }
}

/** Anchors a content has before an import: non-deleted sources whose path no longer holds it, and records without sources. */
function anchorsBefore(state) {
  const anchors = new Set()
  for (const source of state.sources) {
    if (source.state !== 'deleted' && state.inbox.get(source.path) !== source.sha256) anchors.add(source.sha256)
  }
  for (const record of state.records.values()) {
    if (!state.sources.some((source) => source.state !== 'deleted' && source.recordId === record.recordId)) anchors.add(record.sha256)
  }
  return anchors
}

function runSeed(seed) {
  const m = model(seed)
  const { state, next, pick } = m
  const tally = { imports: 0, blocked: 0, accepted: 0, newRecords: 0, moves: 0, confirmations: 0, deletedSkips: 0, operations: {} }
  for (let step = 0; step < STEPS; step++) {
    const explicit = new Set()
    const files = [...state.inbox.keys()]
    const roll = next()
    let operation
    if (roll < 0.2 || files.length === 0) { operation = 'add'; state.inbox.set(m.freshPath(), m.freshContent()) }
    else if (roll < 0.3) { operation = 'copy'; state.inbox.set(m.freshPath(), state.inbox.get(pick(files))) }
    else if (roll < 0.45) { operation = 'move'; const from = pick(files); const content = state.inbox.get(from); state.inbox.delete(from); state.inbox.set(m.freshPath(), content) }
    else if (roll < 0.5) {
      operation = 'rename-folder'
      const city = pick(CITIES)
      state.renames += 1
      for (const from of files.filter((file) => file.startsWith(`${city.folder}/`) || file.startsWith(`${city.folder} `))) {
        const content = state.inbox.get(from)
        state.inbox.delete(from)
        state.inbox.set(`${city.folder} ${state.renames}/photos/${from.slice(from.lastIndexOf('/') + 1)}`, content)
      }
    } else if (roll < 0.6) { operation = 'remove'; state.inbox.delete(pick(files)) }
    else if (roll < 0.68) { operation = 'replace'; state.inbox.set(pick(files), m.freshContent()) }
    else if (roll < 0.75) {
      operation = 'put-back'
      const deleted = state.sources.filter((source) => source.state === 'deleted')
      if (deleted.length) { const source = pick(deleted); state.inbox.set(next() < 0.5 ? source.path : m.freshPath(), source.sha256) }
    } else if (roll < 0.85) {
      operation = 'delete-in-app'
      const live = m.records()
      if (live.length) {
        const record = pick(live)
        const paused = next() < 0.4
        for (const source of state.sources.filter((row) => row.recordId === record.recordId && row.state !== 'deleted')) {
          const wasPresent = source.state === 'present'
          source.state = 'deleted'
          // The pending deletion of the source file: done unless a backup paused it; re-checked against the registry.
          const stillNamed = state.sources.some((row) => row.state !== 'deleted' && row.pathKey === source.pathKey && row.sha256 === source.sha256)
          if (wasPresent && !paused && !stillNamed && state.inbox.get(source.path) === source.sha256) state.inbox.delete(source.path)
        }
        state.records.delete(record.recordId)
      }
    } else if (roll < 0.95) {
      operation = 'upload'
      const missing = state.sources.filter((source) => source.state === 'missing')
      const deleted = state.sources.filter((source) => source.state === 'deleted')
      const kind = next()
      const content = kind < 0.3 && missing.length ? pick(missing).sha256 : kind < 0.5 && deleted.length ? pick(deleted).sha256 : m.freshContent()
      const target = kind >= 0.3 && kind < 0.4 && deleted.length && !state.inbox.has(pick(deleted).path) ? pick(deleted).path : m.freshPath()
      if (!state.inbox.has(target)) { state.inbox.set(target, content); explicit.add(pathKeyOf(target)) }
    } else {
      operation = 'revert'
      const replaced = state.sources.filter((source) => source.state === 'missing')
      if (replaced.length) { const source = pick(replaced); state.inbox.set(source.path, source.sha256) }
    }
    tally.operations[operation] = (tally.operations[operation] ?? 0) + 1

    // ---- The import.
    const facts = m.facts()
    const before = { records: new Set(state.records.keys()), anchors: anchorsBefore(state),
      deletedPairs: new Set(state.sources.filter((source) => source.state === 'deleted').map((source) => `${source.pathKey}\u0000${source.sha256}`)),
      deletedContent: new Set(state.sources.filter((source) => source.state === 'deleted').map((source) => source.sha256)) }
    const input = { sources: m.registry(), records: m.records(), facts, explicit }
    const classification = classifyScan(input)
    assert.deepEqual(classifyScan({ sources: m.registry(), records: m.records(), facts: m.facts(), explicit }), classification, `seed ${seed} step ${step}: deterministic`)
    for (const item of classification.newRecords) {
      if (item.explicit) continue
      assert.ok(!before.anchors.has(item.fact.sha256), `seed ${seed} step ${step}: no automatic new record for content that has an anchor (${operation})`)
      assert.ok(!before.deletedContent.has(item.fact.sha256), `seed ${seed} step ${step}: no automatic new record for deleted content (${operation})`)
    }
    const accept = classification.confirmations.length > 0 && next() < 0.5
    const decisions = resolveClassification(classification, { accept })
    tally.imports += 1
    tally.confirmations += classification.confirmations.length
    tally.deletedSkips += classification.deletedSkips.length
    if (decisions.blocked) { tally.blocked += 1; continue }
    if (accept) tally.accepted += 1
    for (const item of decisions.newRecords) {
      if (!explicit.has(item.fact.pathKey)) assert.ok(!before.deletedPairs.has(`${item.fact.pathKey}\u0000${item.fact.sha256}`), `seed ${seed} step ${step}: a deleted source is never imported again by a scan`)
    }
    const created = new Map()
    for (const item of decisions.newRecords) {
      const recordId = `r${++state.ids}`
      created.set(item.fact.pathKey, { assetId: `a-${recordId}`, entityId: recordId })
      state.records.set(recordId, { recordId, assetId: `a-${recordId}`, placeId: item.fact.placeId, sha256: item.fact.sha256 })
    }
    const fileEntries = new Map(decisions.newRecords.map((item) => [item.fact.sha256, { extension: '.jpg', bytes: 1, outputs: [] }]))
    const delta = registryDeltaOf(decisions, { created, files: fileEntries, registeredFiles: state.files, facts })
    for (const file of delta.files) state.files.add(file.sha256)
    applySources(state, delta.sources, `req-${step}`)
    tally.newRecords += decisions.newRecords.length
    tally.moves += decisions.moves.length

    // ---- Invariants after an import.
    for (const recordId of before.records) assert.ok(state.records.has(recordId), `seed ${seed} step ${step}: an import never removes a record`)
    for (const key of explicit) {
      assert.ok(decisions.newRecords.some((item) => item.fact.pathKey === key && item.explicit), `seed ${seed} step ${step}: an explicit upload is a new record`)
    }
    const present = state.sources.filter((source) => source.state === 'present')
    for (const source of present) assert.equal(state.inbox.get(source.path), source.sha256, `seed ${seed} step ${step}: a present source is in the Inbox`)
    const presentAt = new Map(present.map((source) => [source.pathKey, source]))
    for (const fact of facts) {
      const accounted = presentAt.get(fact.pathKey)?.sha256 === fact.sha256 || before.deletedPairs.has(`${fact.pathKey}\u0000${fact.sha256}`)
      assert.ok(accounted, `seed ${seed} step ${step}: every Inbox file is a present source or a deleted one (${fact.path})`)
    }
    for (const source of state.sources) {
      if (source.state !== 'deleted') assert.ok(state.records.has(source.recordId), `seed ${seed} step ${step}: a live source names a live record`)
    }
    const again = classifyScan({ sources: m.registry(), records: m.records(), facts: m.facts(), explicit: new Set() })
    assert.deepEqual([again.newRecords.length, again.moves.length, again.confirmations.length, again.gone.length, again.reappeared.length], [0, 0, 0, 0, 0],
      `seed ${seed} step ${step}: scanning again right after an import changes nothing`)
  }
  return tally
}

test(`random Inbox changes keep every invariant (${SEEDS.length} seeds × ${STEPS} steps)`, () => {
  const totals = { imports: 0, blocked: 0, accepted: 0, newRecords: 0, moves: 0, confirmations: 0, deletedSkips: 0, operations: {} }
  for (const seed of SEEDS) {
    const tally = runSeed(seed)
    for (const key of ['imports', 'blocked', 'accepted', 'newRecords', 'moves', 'confirmations', 'deletedSkips']) totals[key] += tally[key]
    for (const [name, count] of Object.entries(tally.operations)) totals.operations[name] = (totals.operations[name] ?? 0) + count
  }
  // Every kind of step and outcome actually happened.
  for (const name of ['add', 'copy', 'move', 'rename-folder', 'remove', 'replace', 'put-back', 'delete-in-app', 'upload', 'revert']) assert.ok(totals.operations[name] > 0, name)
  for (const key of ['blocked', 'accepted', 'newRecords', 'moves', 'confirmations', 'deletedSkips']) assert.ok(totals[key] > 0, key)
  if (process.env.STARMAP_MEDIA_RANDOM_REPORT === '1') console.log(JSON.stringify(totals))
})
