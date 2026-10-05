/** Bounded synthetic crash worker; parent owns and terminates this process. */
import { readFileSync, writeSync } from 'node:fs'
import { backupWorldRepository, restoreWorldRepository } from './world-store-backup.mjs'
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const options = { unsafeTestPhase(phase) {
  if (phase !== spec.phase) return
  writeSync(1, `paused:${phase}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  process.exit(94)
} }
if (spec.operation === 'backup') backupWorldRepository(spec.database, spec.backup, options)
else if (spec.operation === 'restore') restoreWorldRepository(spec.backup, spec.restore, options)
else throw new Error('Unknown synthetic operation')
process.exitCode = 95
