/** Experimental immutable v2 SQLite upgrade artifact, not a writable host.
 * Trusted caller-owned local paths; SHA-256 detects corruption, not forgery. */
import { DatabaseSync } from 'node:sqlite'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { freezeCopy, opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { openWorldRepository, RepositoryError } from './world-store-repository.mjs'
import { readRepositoryV2, repositoryStateDigest } from './world-store-repository-v2-contract.mjs'
import { revalidateRepositoryUpgrade } from './world-store-upgrade-preview.mjs'

const APP = 0x534d4734
const SQL = 'CREATE TABLE upgrade_envelope (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const fail = code => { throw new RepositoryError(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function targetPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('E_UPGRADE_PATH')
  return path.join(realpathSync(path.dirname(input)), path.basename(input))
}
function fileBytes(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('E_UPGRADE_PATH')
  return readFileSync(file)
}
function exclusive(file, value) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
}
function phase(options, name) {
  const result = options.unsafeTestPhase?.(name)
  if (result && typeof result.then === 'function') fail('E_UPGRADE_ASYNC_HOOK')
}

export function discoverRepositoryUpgrade(target, options = {}) {
  const root = targetPath(target)
  let stat
  try { stat = lstatSync(root) } catch (e) { if (e.code === 'ENOENT') return freezeCopy({ status: 'absent' }); throw e }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_UPGRADE_PATH')
  const files = readdirSync(root)
  if (!files.includes('complete.json')) return freezeCopy({ status: 'incomplete' })
  if (files.length !== 2 || !files.includes('world.sqlite')) fail('E_UPGRADE_CORRUPT')
  const completion = JSON.parse(fileBytes(path.join(root, 'complete.json')).toString('utf8'))
  validateJson(completion)
  shape(completion, ['format', 'formatVersion', 'operationId', 'sourceDigest', 'previewDigest', 'databaseDigest', 'envelopeDigest'])
  if (completion.format !== 'starmap.repository-upgrade-complete' || completion.formatVersion !== 1) fail('E_UPGRADE_VERSION')
  opaqueId(completion.operationId, 'operationId')
  for (const key of ['sourceDigest', 'previewDigest', 'databaseDigest', 'envelopeDigest']) {
    if (typeof completion[key] !== 'string' || !/^[a-f0-9]{64}$/.test(completion[key])) fail('E_UPGRADE_CORRUPT')
  }
  const file = path.join(root, 'world.sqlite')
  if (hash(fileBytes(file)) !== completion.databaseDigest) fail('E_UPGRADE_CORRUPT')
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 0 })
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== APP || db.prepare('PRAGMA user_version').get().user_version !== 2) fail('E_UPGRADE_VERSION')
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (schema.length !== 1 || schema[0].name !== 'upgrade_envelope' || schema[0].type !== 'table' || schema[0].sql !== SQL || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('E_UPGRADE_CORRUPT')
    const rows = db.prepare('SELECT payload,digest FROM upgrade_envelope').all()
    if (rows.length !== 1 || hash(rows[0].payload) !== rows[0].digest) fail('E_UPGRADE_CORRUPT')
    const envelope = readRepositoryV2(JSON.parse(rows[0].payload), options.policy)
    if (repositoryStateDigest(envelope) !== completion.envelopeDigest || repositoryStateDigest({ state: envelope.state, receipts: envelope.baseline.receipts }) !== completion.sourceDigest || repositoryStateDigest({ sourceDigest: completion.sourceDigest, envelope }) !== completion.previewDigest) fail('E_UPGRADE_CORRUPT')
    return freezeCopy({ status: 'completed', completion, envelope })
  } finally { db.close() }
}

export function upgradeRepositoryToDirectory(sourceFile, target, preview, operationId, options = {}) {
  opaqueId(operationId, 'operationId'); validateJson(preview)
  const root = targetPath(target), existing = discoverRepositoryUpgrade(root, options)
  if (existing.status === 'completed') {
    const expected = { format: 'starmap.repository-upgrade-preview', formatVersion: 1, executable: false, commands: [],
      sourceDigest: existing.completion.sourceDigest, previewDigest: existing.completion.previewDigest,
      envelope: existing.envelope, limitations: ['legacy-edit-bodies-unavailable', 'no-database-conversion', 'no-media-or-app-switch'] }
    if (existing.completion.operationId !== operationId || repositoryStateDigest(preview) !== repositoryStateDigest(expected)) fail('E_UPGRADE_EXISTS')
    // A sealed result is a historical success; later source edits do not undo it.
    return existing
  }
  if (existing.status !== 'absent') fail('E_UPGRADE_INCOMPLETE')
  const source = openWorldRepository(sourceFile, { readOnly: true, policy: options.policy })
  try { return source.withSnapshot(() => {
  const current = revalidateRepositoryUpgrade(sourceFile, preview, options)
  mkdirSync(root, { mode: 0o700 }); phase(options, 'directory-created')
  const file = path.join(root, 'world.sqlite')
  exclusive(file, '')
  const db = new DatabaseSync(file, { allowExtension: false, timeout: 0 })
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    db.exec(SQL); db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=2;`)
    const payload = JSON.stringify(current.envelope)
    db.prepare('INSERT INTO upgrade_envelope VALUES (1,?,?)').run(payload, hash(payload))
    phase(options, 'envelope-written'); db.exec('COMMIT')
  } finally {
    try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }
  }
  phase(options, 'database-committed')
  // Refuse sealing if the source changed while the artifact was generated.
  revalidateRepositoryUpgrade(sourceFile, current, options)
  const completion = { format: 'starmap.repository-upgrade-complete', formatVersion: 1, operationId,
    sourceDigest: current.sourceDigest, previewDigest: current.previewDigest,
    databaseDigest: hash(fileBytes(file)), envelopeDigest: repositoryStateDigest(current.envelope) }
  phase(options, 'before-completion')
  exclusive(path.join(root, 'complete.json'), JSON.stringify(completion))
  phase(options, 'completed')
  return discoverRepositoryUpgrade(root, options)
  }) } finally { source.close() }
}
