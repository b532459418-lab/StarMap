/** Cooperating, trusted same-process authority for synthetic Merge Stores only.
 * No HTTP/OS identity, V2 lease, App activation or private-library access.
 * Session/grant validity is checked at Store's locked authorization boundary,
 * not continuously through COMMIT. A grant allows one explicit attempt.
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { freezeCopy, jsonKey, opaqueId } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { checkRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { createRepositoryMergeStoreHost, openRepositoryMergeStore } from './world-store-branch-merge-store.mjs'

const MAX_TTL = 900000
const writingRoots = new Set()
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
const asyncValue = value => value && typeof value.then === 'function'
function dataObject(value, allowed) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('E_HOST_AUTHORITY')
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('E_HOST_AUTHORITY')
  }
}
function physical(root) {
  return Object.fromEntries(['', 'world.sqlite', 'binding.json'].map(name => {
    const stat = lstatSync(path.join(root, name), { bigint: true })
    if (stat.isSymbolicLink() || (name ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) fail('E_HOST_SELECTION')
    return [name || 'root', { dev: String(stat.dev), ino: String(stat.ino) }]
  }))
}

/** Bootstrap callbacks and clock are trusted dependencies, never request data.
 * Only this controller can mint its opaque sessions. No StoreHost or writable
 * handle escapes; another trusted bootstrap can still create its own host.
 */
export function createRepositoryMergeHostAuthority(input) {
  dataObject(input, ['sandboxRoot', 'hostId', 'approve', 'clock', 'policy'])
  if (input.approve !== undefined && typeof input.approve !== 'function') fail('E_HOST_AUTHORITY')
  if (input.clock !== undefined && typeof input.clock !== 'function') fail('E_HOST_CLOCK')
  const approve = input.approve ?? (() => false), clock = input.clock ?? (() => performance.now()), hostId = input.hostId
  const suppliedPolicy = input.policy ?? {}
  checkRepositoryMergeArchiveInputs([suppliedPolicy])
  const policy = freezeCopy(suppliedPolicy)
  const sessions = new WeakMap()
  let current, closed = false, busy = false, poisoned = false, clockFailed = false, lastTime = -1, ticket
  function guard() {
    if (closed) fail('E_HOST_CLOSED')
    if (busy) { poisoned = true; fail('E_HOST_BUSY') }
  }
  function time() {
    if (clockFailed) fail('E_HOST_CLOCK')
    let value
    try { value = clock() } catch { clockFailed = true; if (current) current.revoked = true; fail('E_HOST_CLOCK') }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value < lastTime) {
      if (current) current.revoked = true
      clockFailed = true
      fail('E_HOST_CLOCK')
    }
    if (poisoned) fail('E_HOST_BUSY')
    lastTime = value
    return value
  }
  function valid(token) {
    const record = sessions.get(token)
    if (!record || record !== current || record.revoked || closed) fail('E_HOST_SESSION')
    if (time() >= record.expiresAt) { record.revoked = true; record.grant = undefined; fail('E_HOST_SESSION_EXPIRED') }
    if (poisoned) fail('E_HOST_BUSY')
    return record
  }
  function scope(action) {
    guard(); busy = true; poisoned = false
    try { return action() } finally { ticket = undefined; busy = false; poisoned = false }
  }
  const host = createRepositoryMergeStoreHost({ sandboxRoot: input.sandboxRoot, hostId, authorize(info) {
    if (!ticket) return false
    valid(ticket.session)
    const selected = ticket.selection
    if (info.root !== selected.root || !equal(info.identity, selected.identity) || !equal(info.binding, selected.binding)
      || !equal(physical(selected.root), ticket.physical)) fail('E_HOST_SELECTION')
    if (info.kind === 'open' && !ticket.opened) { ticket.opened = true; return true }
    if (info.kind !== 'apply' || !ticket.opened || ticket.applied) return false
    if (!equal(info, ticket.intent)) fail('E_HOST_STALE')
    ticket.applied = true
    return true
  } })
  function read(record, callback, requireDigest = false) {
    if (!record.selection) fail('E_HOST_SELECTION')
    const selected = record.selection
    if (!equal(physical(selected.root), record.physical)) fail('E_HOST_SELECTION')
    const store = openRepositoryMergeStore(selected.root, { host, policy, readOnly: true })
    try {
      return store.withSnapshot((saved, verify) => {
        const descriptor = saved.baseArchive.descriptor
        if (!equal(descriptor.identity, selected.identity) || !equal(descriptor.binding, selected.binding)
          || !equal(physical(selected.root), record.physical)) fail('E_HOST_SELECTION')
        if (requireDigest && saved.savedDigest !== selected.savedDigest) fail('E_HOST_STALE')
        verify(); const result = callback(saved); verify(); return result
      })
    } finally { store.close() }
  }
  return Object.freeze({
    startSession(options = {}) {
      return scope(() => {
        dataObject(options, ['ttlMs'])
        const ttlMs = options.ttlMs === undefined ? 300000 : options.ttlMs
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL) fail('E_HOST_SESSION')
        const now = time()
        if (!Number.isFinite(now + ttlMs)) fail('E_HOST_CLOCK')
        if (current) current.revoked = true
        const token = Object.freeze({})
        current = { expiresAt: now + ttlMs, revoked: false }
        sessions.set(token, current); return token
      })
    },
    revoke(session) {
      return scope(() => {
        const record = sessions.get(session)
        if (!record) fail('E_HOST_SESSION')
        record.revoked = true; record.grant = undefined; record.selection = undefined
      })
    },
    select(session, root) {
      return scope(() => {
        const record = valid(session)
        // Any attempted selection clears the old grant, including a failed read.
        record.grant = undefined; record.selection = undefined; record.physical = undefined
        const store = openRepositoryMergeStore(root, { host, policy, readOnly: true })
        try {
          return store.withSnapshot((saved, verify) => {
            const descriptor = saved.baseArchive.descriptor
            const expectedBinding = { hostId,
              locationDigest: digest(process.platform === 'win32' ? path.join(root, 'world.sqlite').toLowerCase() : path.join(root, 'world.sqlite')) }
            if (!equal(descriptor.binding, expectedBinding)) fail('E_HOST_SELECTION')
            const selected = { root, identity: descriptor.identity, binding: descriptor.binding,
              savedDigest: saved.savedDigest, policyDigest: digest(policy) }
            record.physical = freezeCopy(physical(root)); verify(); valid(session)
            record.selection = freezeCopy({ ...selected, selectionDigest: digest(selected) })
            return record.selection
          })
        } finally { store.close() }
      })
    },
    enable(session, selectionDigest) {
      return scope(() => {
        const record = valid(session); record.grant = undefined
        if (!record.selection || selectionDigest !== record.selection.selectionDigest) fail('E_HOST_SELECTION')
        read(record, () => undefined, true)
        const decision = approve(freezeCopy({ kind: 'enable', selection: record.selection,
          sessionExpiresAt: record.expiresAt, syntheticOnly: true }))
        if (asyncValue(decision)) fail('E_HOST_ASYNC')
        valid(session)
        if (decision !== true) fail('E_HOST_AUTHORITY')
        // Approval may call other trusted code; re-read physical/content binding.
        read(record, () => undefined, true)
        record.grant = record.selection.selectionDigest
        return freezeCopy({ enabled: true, selectionDigest, expiresAt: record.expiresAt })
      })
    },
    apply(session, request, options = {}) {
      return scope(() => {
        const record = valid(session)
        if (!record.selection || record.grant !== record.selection.selectionDigest) fail('E_HOST_AUTHORITY')
        record.grant = undefined // One explicit attempt, including failed attempts.
        dataObject(options, ['source'])
        dataObject(request, ['format', 'formatVersion', 'kind', 'operationId', 'targetSavedDigest', 'policyDigest', 'pureRequest', 'sourceArchive'])
        checkRepositoryMergeArchiveInputs([request])
        const frozen = freezeCopy(request), selected = record.selection
        if (frozen.targetSavedDigest !== selected.savedDigest || frozen.policyDigest !== selected.policyDigest) fail('E_HOST_STALE')
        if (!['operation', 'merge'].includes(frozen.kind)) fail('E_HOST_AUTHORITY')
        const source = options.source
        if (frozen.kind === 'merge' && typeof source !== 'string') fail('E_HOST_SELECTION')
        if (frozen.kind === 'operation' && source !== undefined) fail('E_HOST_SELECTION')
        read(record, () => undefined, true)
        const key = process.platform === 'win32' ? selected.root.toLowerCase() : selected.root
        if (writingRoots.has(key)) fail('E_HOST_BUSY')
        writingRoots.add(key)
        try {
          ticket = { session, selection: selected, physical: record.physical, opened: false, applied: false,
            intent: freezeCopy({ kind: 'apply', root: selected.root, identity: selected.identity, binding: selected.binding,
              operationId: frozen.operationId, action: frozen.kind === 'operation' ? frozen.pureRequest?.operation?.action?.kind : 'merge',
              requestDigest: digest(frozen), targetSavedDigest: selected.savedDigest,
              sourceDigest: frozen.kind === 'merge' ? digest(frozen.sourceArchive) : null, policyDigest: selected.policyDigest }) }
          const store = openRepositoryMergeStore(selected.root, { host, policy })
          try { return store.apply(frozen, source === undefined ? {} : { source }) }
          finally { store.close() }
        } finally { writingRoots.delete(key) }
      })
    },
    snapshot(session) { return scope(() => read(valid(session), saved => saved)) },
    findOperation(session, operationId) {
      opaqueId(operationId, 'operationId')
      return scope(() => read(valid(session), saved => {
        if (saved.initialization?.receipt.operationId === operationId) return saved.initialization.receipt
        return saved.events.find(event => event.receipt.operationId === operationId)?.receipt
      }))
    },
    close() { guard(); closed = true; if (current) current.revoked = true },
  })
}
