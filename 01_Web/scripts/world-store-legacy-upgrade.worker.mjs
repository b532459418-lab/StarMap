/** Bounded synthetic process-exit test, no actual user data lookup. */
import { readFileSync, writeSync } from 'node:fs'
import { upgradeLegacyRepositoryToDirectory } from './world-store-legacy-upgrade.mjs'
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
upgradeLegacyRepositoryToDirectory(spec.source, spec.target, spec.preview, 'upgrade', { hostId: 'test-host', unsafeTestPhase(name) {
  if (name !== spec.phase) return
  writeSync(1, `paused:${name}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  process.exit(94)
} })
process.exitCode = 95
