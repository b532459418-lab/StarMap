/** Synthetic inputs and bounded crash worker. Never loads a private root. */
import { readFileSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fixture, entry, source, NOW, id } from '../src/worldgraph/store/store.fixture.ts'
import { openWorldRepository } from './world-store-repository.mjs'
export { fixture, entry, source, NOW, id }
export const seed = () => ({ world: fixture() })
export const candidate = () => ({ id: 'synthetic-proposal', status: 'pending', sourceId: 'test:ai', evidenceIds: ['proof-one'], createdAt: NOW, baseRevision: 0, reason: 'Synthetic candidate', commands: [{ op: 'create', table: 'entries', value: { ...entry(50), source: source('ai-record', 'test:ai') } }] })
export const stageRequest = () => ({ id: 'stage', expectedRevision: 0, action: { kind: 'stage-proposal', proposal: candidate() } })
export const acceptRequest = () => ({ id: 'accept', expectedRevision: 1, action: { kind: 'accept-proposal', proposalId: 'synthetic-proposal', decision: { reviewId: 'synthetic-review', acceptedAt: NOW } } })
export const createRequest = () => ({ id: 'create', expectedRevision: 0, action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] }, identities: [{ kind: 'entry', sourceId: 'test:manual', recordId: 'record-60', id: id(60) }] })
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'crash-worker') {
  const spec = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const repository = openWorldRepository(spec.database, { unsafeTestPhase(phase) {
    if (phase === spec.phase) {
      writeSync(1, `paused:${phase}\n`)
      // Parent must terminate us. Finite fallback prevents an orphaned worker.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
      process.exit(94)
    }
  } })
  try { repository.apply(spec.request); process.exitCode = 95 }
  finally { repository.close() }
}
