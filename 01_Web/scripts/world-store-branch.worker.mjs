/** Bounded process-exit fixture worker. Explicit synthetic paths only. */
import { readFileSync, writeSync } from 'node:fs'
import { forkRepositoryToDirectory, openRepositoryBranch } from './world-store-branch.mjs'
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const options = { hostId: 'test-host', unsafeTestPhase(name) {
  if (name !== spec.phase) return
  writeSync(1, `paused:${name}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  process.exit(94)
} }
if (spec.action === 'fork') forkRepositoryToDirectory(spec.source, spec.target, spec.preview, 'fork', options)
else {
  const branch = openRepositoryBranch(spec.target, options)
  try { branch.apply(spec.request) } finally { branch.close() }
}
process.exitCode = 95
