/** Finite synthetic process-exit probe for the experimental v2 writer. */
import { readFileSync, writeSync } from 'node:fs'
import { openRepositoryV2 } from './world-store-repository-v2.mjs'
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const repository = openRepositoryV2(spec.file, { unsafeTestPhase(name) {
  if (name !== spec.phase) return
  writeSync(1, `paused:${name}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  process.exit(94)
} })
try { repository.apply(spec.request); process.exitCode = 95 }
finally { repository.close() }
