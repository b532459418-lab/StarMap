/** Bounded synthetic interruption worker; no real-private-root lookup. */
import { readFileSync, writeSync } from 'node:fs'
import { backupRepositoryBranch, restoreRepositoryBranch } from './world-store-branch-backup.mjs'
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const options = { hostId: 'test-host', unsafeTestPhase(name) {
  if (name !== spec.phase) return
  writeSync(1, `paused:${name}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  process.exit(94)
} }
if (spec.action === 'backup') backupRepositoryBranch(spec.source, spec.target, spec.preview, 'backup', options)
else restoreRepositoryBranch(spec.source, spec.target, spec.preview, 'restore', options)
process.exitCode = 95
