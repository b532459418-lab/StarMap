/** Bounded synthetic fault worker. No private-root discovery or config reads. */
import { readFileSync, writeSync } from 'node:fs'
import { upgradeRepositoryToDirectory } from './world-store-upgrade.mjs'

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
upgradeRepositoryToDirectory(spec.source, spec.target, spec.preview, 'upgrade', {
  unsafeTestPhase(name) {
    if (name !== spec.phase) return
    writeSync(1, `paused:${name}\n`)
    // Parent terminates this child. Finite fallback prevents orphaned workers.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
    process.exit(94)
  },
})
process.exitCode = 95
