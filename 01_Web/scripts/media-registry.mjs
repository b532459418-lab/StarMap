/**
 * Scan against registry (3C-4c, design v2 §3 step 3, with review §8-1 to §8-3): which Inbox files are sources already
 * confirmed, which moved, which are new records, and which need the user's confirmation. Pure: no IO, no clock; the
 * caller passes the registry rows (store-media-registry.mjs), the live media records and the scan facts (media-scan.mjs).
 *
 * Inputs
 * - `sources`: media_sources rows `{ seq, path, pathKey, sha256, recordId, state, descriptionDigest? }`.
 * - `records`: the live media records `{ recordId, assetId, placeId, sha256? }` (the media entity, its asset, its city
 *   and the content its asset is linked to). A record no source that is not deleted names is an orphan (a migrated item
 *   whose sources were never known): its content can claim a file again.
 * - `facts`: one per Inbox file, in walk order (`path`, `pathKey`, `sha256`, `placeId`, `descriptionDigest`, `cityFolder`, …).
 * - `explicit`: path keys the user added on purpose (an upload, a task's files, `--reimport`). They are always new
 *   records: never matched as moves, never held back as deleted (§8-3).
 *
 * The rules, file by file (`source` below never means a deleted one unless it says so):
 * 1. a source at the same path with the same content: unchanged (a missing one is present again). Explicit files too,
 *    so a retry never adds a record twice;
 * 2. a present source at the same path with other content: that source is gone (missing); the file is a candidate that
 *    replaces it;
 * 3. a deleted source at the same path with the same content, and the file is not explicit: skipped (a deleted source is
 *    not imported again);
 * 4. otherwise a candidate.
 * Present sources whose path the scan did not find are gone (missing). Candidates that are not explicit are grouped by
 * content and matched with the anchors of that content: gone sources, sources that were missing already, and orphan
 * records. With no anchor, each candidate is a new record (D2), except that content a deleted source had (§8-1), and a
 * file replacing another, need confirmation. With anchors that all belong to one record, and no more candidates than
 * anchors, the candidates are moves of that record (automatic). Anything else is ambiguous: a deterministic proposal
 * (same file name, then same city folder, then order) pairs candidates with anchors, the rest become new records, and
 * the whole group needs confirmation. Moves into another city's folder keep the record's place and are listed (§8-2);
 * so are confirmed sources whose description (place, kind, sidecar entry) changed but is not applied (D1).
 */

/** Kinds of a confirmation: an ambiguous match, content a deleted source had, a file that replaced another at its path. */
export const CONFIRMATION_KINDS = Object.freeze(['ambiguous-move', 'deleted-content', 'replaced'])

const baseNameOf = (key) => key.slice(key.lastIndexOf('/') + 1)
/** `mediainbox/<country>/<city>` of a path key (the folders the walk resolves places by). */
const cityFolderOf = (key) => key.split('/').slice(0, 3).join('/')

/** Group `items` by `keyOf`, keeping their order. */
function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}

/**
 * Pair candidates with anchors, best match first: the same file name scores 2, the same city folder 1 (an orphan record
 * has no path: 0). Pairs are taken by score, then candidate order, then anchor order; each candidate and anchor once.
 * Deterministic. Returns Map candidate → anchor (unpaired candidates are absent).
 */
function pairCandidates(candidates, anchors) {
  const scored = []
  candidates.forEach((candidate, c) => {
    const key = candidate.fact.pathKey
    anchors.forEach((anchor, a) => {
      const anchorKey = anchor.source?.pathKey
      const score = anchorKey === undefined ? 0 : (baseNameOf(anchorKey) === baseNameOf(key) ? 2 : 0) + (cityFolderOf(anchorKey) === cityFolderOf(key) ? 1 : 0)
      scored.push({ score, c, a })
    })
  })
  scored.sort((x, y) => y.score - x.score || x.c - y.c || x.a - y.a)
  const pairs = new Map()
  const usedAnchors = new Set()
  for (const { c, a } of scored) {
    if (pairs.has(candidates[c]) || usedAnchors.has(a)) continue
    pairs.set(candidates[c], anchors[a])
    usedAnchors.add(a)
  }
  return pairs
}

/**
 * Classify one scan. Returns, in walk order where it applies:
 * - unchanged / reappeared: `{ fact, source }` (reappeared: a missing source found at its path again);
 * - gone: sources to mark missing (`{ source, replacedBy? }`);
 * - deletedSkips: `{ fact, source }` (rule 3);
 * - newRecords: `{ fact, explicit, replacing }` created without confirmation;
 * - moves: `{ fact, anchor, recordId }` made without confirmation (`anchor.source`, or `anchor.record` for an orphan);
 * - confirmations: `{ kind, sha256, entries: [{ fact, proposal: { action: 'move', anchor, recordId } | { action: 'new' } }],
 *   anchors: [{ source? , record? , recordId }] }`, one per content (kinds combine into `kinds`);
 * - crossCity: automatic and proposed moves into a folder of another city than the record's (`{ fact, recordId, placeId }`);
 * - descriptionChanged: confirmed sources whose description digest changed (`{ fact, source }`), moves into another city
 *   excluded (they are in crossCity).
 */
export function classifyScan({ sources, records, facts, explicit = new Set() }) {
  const live = sources.filter((source) => source.state !== 'deleted')
  const liveAt = groupBy(live, (source) => source.pathKey)
  const deletedAt = groupBy(sources.filter((source) => source.state === 'deleted'), (source) => source.pathKey)
  const deletedContent = new Set(sources.filter((source) => source.state === 'deleted').map((source) => source.sha256))
  const recordById = new Map(records.map((record) => [record.recordId, record]))
  const sourceCount = new Map()
  for (const source of live) sourceCount.set(source.recordId, (sourceCount.get(source.recordId) ?? 0) + 1)

  const unchanged = []
  const reappeared = []
  const deletedSkips = []
  const candidates = []
  const settled = new Set()
  const gone = new Map()
  const scanned = new Set(facts.map((fact) => fact.pathKey))

  for (const fact of facts) {
    const here = liveAt.get(fact.pathKey) ?? []
    const same = here.find((source) => source.sha256 === fact.sha256)
    if (same) {
      settled.add(same.seq)
      ;(same.state === 'present' ? unchanged : reappeared).push({ fact, source: same })
      // Another present source at this path (the content came back after a replacement) is gone.
      for (const other of here) if (other !== same && other.state === 'present') gone.set(other.seq, { source: other, replacedBy: fact })
      continue
    }
    const replacing = here.filter((source) => source.state === 'present')
    for (const source of replacing) gone.set(source.seq, { source, replacedBy: fact })
    const isExplicit = explicit.has(fact.pathKey)
    const deleted = (deletedAt.get(fact.pathKey) ?? []).find((source) => source.sha256 === fact.sha256)
    if (deleted && !isExplicit) {
      deletedSkips.push({ fact, source: deleted })
      continue
    }
    candidates.push({ fact, explicit: isExplicit, replacing })
  }
  for (const source of live) {
    if (source.state === 'present' && !scanned.has(source.pathKey) && !settled.has(source.seq)) gone.set(source.seq, { source })
  }

  // Anchors of a content: gone sources, sources missing already (not found again), orphan records.
  const anchorsOf = new Map()
  const addAnchor = (sha256, anchor) => {
    if (!anchorsOf.has(sha256)) anchorsOf.set(sha256, [])
    anchorsOf.get(sha256).push(anchor)
  }
  for (const source of [...live].sort((a, b) => a.seq - b.seq)) {
    if (settled.has(source.seq)) continue
    if (gone.has(source.seq) || source.state === 'missing') addAnchor(source.sha256, { source, recordId: source.recordId })
  }
  for (const record of [...records].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))) {
    if (record.sha256 !== undefined && !sourceCount.has(record.recordId)) addAnchor(record.sha256, { record, recordId: record.recordId })
  }

  const newRecords = []
  const moves = []
  const confirmations = []
  for (const candidate of candidates.filter((item) => item.explicit)) newRecords.push(candidate)
  for (const [sha256, group] of groupBy(candidates.filter((item) => !item.explicit), (item) => item.fact.sha256)) {
    const anchors = anchorsOf.get(sha256) ?? []
    if (anchors.length === 0) {
      for (const candidate of group) {
        const kinds = [...(deletedContent.has(sha256) ? ['deleted-content'] : []), ...(candidate.replacing.length ? ['replaced'] : [])]
        if (kinds.length === 0) { newRecords.push(candidate); continue }
        confirmations.push({ kind: kinds[0], kinds, sha256, anchors: [], entries: [{ fact: candidate.fact, replacing: candidate.replacing, proposal: { action: 'new' } }] })
      }
      continue
    }
    const pairs = pairCandidates(group, anchors)
    const recordIds = new Set(anchors.map((anchor) => anchor.recordId))
    if (recordIds.size === 1 && group.length <= anchors.length) {
      for (const candidate of group) {
        const anchor = pairs.get(candidate)
        moves.push({ fact: candidate.fact, anchor, recordId: anchor.recordId })
      }
      continue
    }
    confirmations.push({
      kind: 'ambiguous-move', kinds: ['ambiguous-move'], sha256, anchors,
      entries: group.map((candidate) => {
        const anchor = pairs.get(candidate)
        return { fact: candidate.fact, replacing: candidate.replacing, proposal: anchor ? { action: 'move', anchor, recordId: anchor.recordId } : { action: 'new' } }
      }),
    })
  }

  const crossCityOf = (fact, recordId) => {
    const record = recordById.get(recordId)
    return record !== undefined && record.placeId !== fact.placeId ? { fact, recordId, placeId: record.placeId } : undefined
  }
  const crossCity = [
    ...moves.map((move) => crossCityOf(move.fact, move.recordId)),
    ...confirmations.flatMap((group) => group.entries.filter((entry) => entry.proposal.action === 'move').map((entry) => crossCityOf(entry.fact, entry.proposal.recordId))),
  ].filter(Boolean)
  const movedAway = new Set(crossCity.map((item) => item.fact.pathKey))
  const descriptionChanged = [
    ...unchanged, ...reappeared,
    ...moves.filter((move) => move.anchor.source).map((move) => ({ fact: move.fact, source: move.anchor.source })),
  ].filter(({ fact, source }) => source.descriptionDigest !== undefined && source.descriptionDigest !== fact.descriptionDigest && !movedAway.has(fact.pathKey))

  return {
    unchanged, reappeared, deletedSkips, newRecords, moves, confirmations, crossCity, descriptionChanged,
    gone: [...gone.values()].sort((a, b) => a.source.seq - b.source.seq),
  }
}

/**
 * The decisions of a classification: without `accept`, an import with confirmations is `blocked` (nothing may be
 * written). With `accept`, every confirmation's proposal is applied. Returns { blocked, newRecords, moves, reappeared,
 * gone }: newRecords `{ fact, explicit }`; moves `{ fact, anchor, recordId }`; gone sources whose anchor did not move
 * them (a source matched as a move is updated, not marked missing).
 */
export function resolveClassification(classification, { accept = false } = {}) {
  const blocked = classification.confirmations.length > 0 && !accept
  const newRecords = classification.newRecords.map(({ fact, explicit }) => ({ fact, explicit }))
  const moves = [...classification.moves]
  if (!blocked) {
    for (const group of classification.confirmations) {
      for (const entry of group.entries) {
        if (entry.proposal.action === 'move') moves.push({ fact: entry.fact, anchor: entry.proposal.anchor, recordId: entry.proposal.recordId })
        else newRecords.push({ fact: entry.fact, explicit: false })
      }
    }
  }
  const moved = new Set(moves.filter((move) => move.anchor.source).map((move) => move.anchor.source.seq))
  return {
    blocked,
    newRecords: blocked ? [] : newRecords,
    moves: blocked ? [] : moves,
    reappeared: classification.reappeared,
    gone: classification.gone.filter((item) => !moved.has(item.source.seq)),
  }
}

/**
 * Folder bindings that matter for an import (design v2 §3): only those of a folder holding a file that becomes a new
 * record. `pins` are the scan's (`{ folder, … }`, portable), `facts` the new records' facts.
 */
export function pinsFor(pins, facts) {
  const folders = new Set(facts.flatMap((fact) => [fact.countryFolder, fact.cityFolder]))
  return pins.filter((pin) => folders.has(pin.folder))
}

/**
 * The registry part of an import (the request's `media` block), from resolved decisions:
 * - new records: their content's media_files row when it is not registered yet (`files`: sha256 → file entry; one
 *   row per content), the asset link, and a present source with the description digest (`created`: path key →
 *   { assetId, entityId });
 * - moves: the source's new path (present), or, for an orphan record, a new present source;
 * - reappeared sources present again; gone sources missing;
 * - the scan cache: a row for every scanned file whose size, time or content is new, and none for paths gone.
 */
export function registryDeltaOf(decisions, { created, files, registeredFiles, facts, cache = [] }) {
  const media = { files: [], assetFiles: [], sources: [], scanCache: [] }
  const putFiles = new Set()
  for (const { fact } of decisions.newRecords) {
    const ids = created.get(fact.pathKey)
    if (!ids) throw new Error(`E_MEDIA_PLAN: no ids for a new record (${fact.pathKey})`)
    if (!registeredFiles.has(fact.sha256) && !putFiles.has(fact.sha256)) {
      const entry = files.get(fact.sha256)
      if (!entry) throw new Error('E_MEDIA_PLAN: no file entry for new content')
      media.files.push({ op: 'put', ...entry, sha256: fact.sha256 })
      putFiles.add(fact.sha256)
    }
    media.assetFiles.push({ op: 'put', assetId: ids.assetId, sha256: fact.sha256 })
    media.sources.push({ op: 'add', path: fact.path, sha256: fact.sha256, recordId: ids.entityId, state: 'present', descriptionDigest: fact.descriptionDigest })
  }
  for (const move of decisions.moves) {
    if (move.anchor.source) media.sources.push({ op: 'update', seq: move.anchor.source.seq, path: move.fact.path, state: 'present' })
    else media.sources.push({ op: 'add', path: move.fact.path, sha256: move.fact.sha256, recordId: move.recordId, state: 'present', descriptionDigest: move.fact.descriptionDigest })
  }
  for (const { source } of decisions.reappeared) media.sources.push({ op: 'update', seq: source.seq, state: 'present' })
  for (const { source } of decisions.gone) media.sources.push({ op: 'update', seq: source.seq, state: 'missing' })
  // Present paths change in one batch: free a path before another source takes it.
  media.sources.sort((a, b) => order(a) - order(b))
  const cached = new Map(cache.map((row) => [row.pathKey, row]))
  const scanned = new Set()
  for (const fact of facts) {
    scanned.add(fact.pathKey)
    const row = cached.get(fact.pathKey)
    if (!row || row.size !== fact.size || row.mtimeMs !== fact.mtimeMs || row.sha256 !== fact.sha256) {
      media.scanCache.push({ op: 'put', path: fact.path, size: fact.size, mtimeMs: fact.mtimeMs, sha256: fact.sha256 })
    }
  }
  for (const row of cache) if (!scanned.has(row.pathKey)) media.scanCache.push({ op: 'remove', pathKey: row.pathKey })
  return media
}

/** Batch order of source operations: those that leave a path (missing) first, then moves and returns, then additions. */
const order = (operation) => (operation.op === 'update' && operation.state === 'missing' && operation.path === undefined ? 0 : operation.op === 'update' ? 1 : 2)
